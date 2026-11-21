/**
 * TTS endpoint.
 *
 * Ordinary chat uses ZONOS3-Mini at http://127.0.0.1:8184 (neutral Savannah).
 * Streaming /api/tts/stream forwards progressive mono 44.1 kHz PCM16 frames
 * directly; whole-blob /api/tts returns one WAV.
 * Relay uses aligned Zonos. The Kokoro routes serve isolated voice tests/trials
 * (WAV stream) and backend verification (aligned stream).
 *
 * Two routes to the browser:
 *   POST /api/tts        { text, voice?, speed? } → audio/wav (whole blob)
 *   POST /api/tts/stream { text, voice?, speed? } → binary frame stream (PCM16)
 *   GET  /api/tts/voices { default, available: string[] }
 */

import express, { type Request, type Response, type Router } from "express";
import { KOKORO_ALIGNMENT, ZONOS3_ALIGNMENT, ZONOS3_SAMPLE_RATE } from "../shared/kokoro.js";
import { SpokenSentences } from "../shared/spoken-sentences.js";
import { asyncHandler } from "./async-handler.js";
import { createCachedProbe } from "./health-cache.js";
import { audioFrame, pcmWav, zonosPcm } from "./zonos-audio.js";

/**
 * Hard cap on input length. Reject absurd/misuse-sized payloads
 * before we spend minutes of CPU
 * synthesizing. 30k chars is ~45-60 min of audio, well past anything a real
 * voice reply produces. The client truncates just under this (TTS_MAX_CHARS
 * in voice.ts) so a normal long message never hits the 413.
 */
const MAX_TEXT_CHARS = 30_000;

/** Shared TTL for the cached engine probes (health, voice list). */
const HEALTH_CACHE_MS = 60 * 1000;

/**
 * How long to wait for the upstream's FIRST chunk before declaring it hung.
 * Headers alone do not count. Once bytes flow, a long reply can stream for
 * minutes without a first-chunk deadline. A first chunk takes ~2-3s warm, ~12s if a
 * full 500-char chunk has to be synthesized under load, so this is a hang
 * detector rather than a budget. Overridable so the timeout path can be
 * exercised without waiting a minute.
 */
const STREAM_TTFB_TIMEOUT_MS =
	Number(process.env.ZONOS_TTFB_TIMEOUT_MS || process.env.KOKORO_TTFB_TIMEOUT_MS) || 60_000;

class FirstChunkTimeout extends Error {
	constructor(engine: string) {
		super(`${engine} produced no first chunk within ${STREAM_TTFB_TIMEOUT_MS}ms`);
	}
}

function firstChunkTimer(
	controller: AbortController,
	engine: string,
): ReturnType<typeof setTimeout> {
	return setTimeout(() => controller.abort(new FirstChunkTimeout(engine)), STREAM_TTFB_TIMEOUT_MS);
}

type Engine = "zonos3";

/**
 * Speed bounds shared by the Zonos and Kokoro shims, so an out-of-range value is rejected here
 * with a clear message instead of surfacing as an opaque upstream 400.
 */
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;

/**
 * Validate the shared { text, voice?, speed? } body for POST / and POST /stream.
 * Extracted so both routes apply the identical checks (non-empty text, length
 * cap, speed range) in one place.
 *
 * `speed` is a synthesis parameter, not a playback rate: Zonos conditions its
 * speaking rate; Kokoro scales phoneme durations.
 */
type TtsInput = { text: string; voice: string | undefined; speed: number };
export function parseTtsBody(req: Request): TtsInput | { error: string; status: number } {
	const body = req.body as { text?: unknown; voice?: unknown; speed?: unknown } | undefined;
	const text = typeof body?.text === "string" ? body.text : "";
	if (!text.trim()) return { error: "no text (field name: 'text')", status: 400 };
	if (text.length > MAX_TEXT_CHARS) {
		return { error: `text too long (max ${MAX_TEXT_CHARS} chars)`, status: 413 };
	}
	const voice = typeof body?.voice === "string" && body.voice.length > 0 ? body.voice : undefined;
	// Absent (or null) means "no preference" → normal speed. Anything else must be
	// a real number in range; strings are rejected rather than coerced.
	let speed = 1;
	const rawSpeed = body?.speed;
	if (rawSpeed !== undefined && rawSpeed !== null) {
		if (
			typeof rawSpeed !== "number" ||
			!Number.isFinite(rawSpeed) ||
			rawSpeed < MIN_SPEED ||
			rawSpeed > MAX_SPEED
		) {
			return { error: `speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}`, status: 400 };
		}
		speed = rawSpeed;
	}
	return { text, voice, speed };
}

/**
 * Wait for a response's write buffer to drain before writing more. Also
 * resolves on 'close' so a client that disconnects while we're awaiting
 * backpressure can't wedge the stream pipe forever — the clientGone abort
 * then cancels the upstream fetch and the next reader.read() rejects.
 */
function waitForDrain(res: Response): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			res.off("drain", done);
			res.off("close", done);
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
	});
}

const KOKORO_BASE =
	process.env.KOKORO_TTS_URL ||
	`http://${process.env.KOKORO_HOST || "127.0.0.1"}:${process.env.KOKORO_PORT || "8181"}`;
const KOKORO_DEFAULT_VOICE = process.env.KOKORO_VOICE || "af_heart";
const ZONOS_RELAY_BASE =
	process.env.ZONOS_RELAY_TTS_URL ||
	`http://${process.env.ZONOS_RELAY_HOST || "127.0.0.1"}:${process.env.ZONOS_RELAY_PORT || "8184"}`;

export function createTtsRouter(): Router {
	const router = express.Router();

	/**
	 * POST /api/tts
	 * Body: { text: string, voice?: string }
	 * Returns: audio/wav bytes
	 */
	router.post(
		"/",
		asyncHandler(async (req: Request, res: Response) => {
			const parsed = parseTtsBody(req);
			if ("error" in parsed) {
				res.status(parsed.status).json({ error: parsed.error });
				return;
			}
			const { text, speed } = parsed;
			await synthZonos(text, speed, res);
		}),
	);

	router.post(
		"/stream",
		asyncHandler(async (req, res) => {
			const parsed = parseTtsBody(req);
			if ("error" in parsed) {
				res.status(parsed.status).json({ error: parsed.error });
				return;
			}
			const controller = new AbortController();
			res.on("close", () => controller.abort());
			res.setHeader("Content-Type", "application/octet-stream");
			res.setHeader("X-Audio-Format", "pcm16");
			res.setHeader("X-Audio-Sample-Rate", String(ZONOS3_SAMPLE_RATE));
			res.setHeader("X-Audio-Channels", "1");
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-Accel-Buffering", "no");
			try {
				for await (const pcm of synthZonosPcm(parsed.text, parsed.speed, controller)) {
					if (!res.write(audioFrame(0x01, pcm))) await waitForDrain(res);
				}
				res.end(audioFrame(0x00));
			} catch (error) {
				if (res.destroyed) return;
				const message = error instanceof Error ? error.message : String(error);
				if (!res.headersSent) {
					res
						.status(error instanceof FirstChunkTimeout ? 504 : 502)
						.type("json")
						.json({ error: message });
				} else res.end(audioFrame(0x80, Buffer.from(message)));
			} finally {
				controller.abort();
			}
		}),
	);

	/**
	 * Forward the backend's framed stream without interpreting audio or timing.
	 * Normal Relay only uses /zonos-relay-stream. /kokoro-stream serves the
	 * isolated trial and voice test; /relay-stream preserves the aligned Kokoro
	 * contract used by pi-voice-server's consumer verifier.
	 */
	router.post(
		["/kokoro-stream", "/relay-stream", "/zonos-relay-stream"],
		asyncHandler(async (req: Request, res: Response) => {
			const zonosRelay = req.path === "/zonos-relay-stream";
			const kokoroAligned = req.path === "/relay-stream";
			const parsed = parseTtsBody(req);
			if ("error" in parsed) {
				res.status(parsed.status).json({ error: parsed.error });
				return;
			}
			const { text, voice, speed } = parsed;
			const upstreamBase = zonosRelay ? ZONOS_RELAY_BASE : KOKORO_BASE;
			const engineName = zonosRelay ? "zonos-relay" : "kokoro";
			const alignHeader = zonosRelay
				? "X-Zonos-Alignment"
				: kokoroAligned
					? "X-Kokoro-Alignment"
					: undefined;
			const alignValue = zonosRelay
				? ZONOS3_ALIGNMENT
				: kokoroAligned
					? KOKORO_ALIGNMENT
					: undefined;

			// Abort upstream the moment the browser goes away (stop button,
			// navigation) so the voice server stops spending CPU on chunks no one
			// will hear. res 'close' also fires on normal completion, where
			// aborting an already-finished fetch is a harmless no-op.
			const clientGone = new AbortController();
			res.on("close", () => clientGone.abort());
			const ttfbTimer = firstChunkTimer(clientGone, `${engineName} tts/stream`);
			try {
				const upstream = await fetch(`${upstreamBase}/tts/stream`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(alignHeader && alignValue ? { [alignHeader]: alignValue } : {}),
					},
					body: JSON.stringify(
						zonosRelay
							? { text, ...(voice ? { voice } : {}), speed }
							: { text, voice: voice ?? KOKORO_DEFAULT_VOICE, speed },
					),
					signal: clientGone.signal,
				});
				// Pre-stream failures stay JSON so the browser can handle them before playback.
				if (!upstream.ok || !upstream.body) {
					const detail = (await upstream.text()).slice(0, 300);
					throw new Error(`upstream ${upstream.status}: ${detail}`);
				}
				if (alignHeader && alignValue) {
					if (upstream.headers.get(alignHeader) !== alignValue) {
						clientGone.abort();
						throw new Error(
							`${zonosRelay ? "ZONOS3-Mini" : "Kokoro"} synthesis alignment unavailable; no speech fallback`,
						);
					}
					res.setHeader(alignHeader, alignValue);
				}
				res.setHeader("Content-Type", "application/octet-stream");
				res.setHeader("Cache-Control", "no-store");
				res.setHeader("X-Accel-Buffering", "no");

				const reader = upstream.body.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (!value?.byteLength) continue;
						if (!res.headersSent) clearTimeout(ttfbTimer);
						// Preserve backpressure: don't buffer the whole stream for a slow tab.
						const more = res.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
						if (!more) await waitForDrain(res);
					}
				} finally {
					reader.releaseLock();
				}
				if (!res.headersSent) throw new Error("upstream ended without audio data");
				res.end();
			} catch (e) {
				if (res.destroyed) return;
				if (res.headersSent) {
					res.end();
					return;
				}
				const timeout = clientGone.signal.reason;
				const message = e instanceof Error ? e.message : String(e);
				res
					.status(timeout instanceof FirstChunkTimeout ? 504 : 502)
					.type("json")
					.json({
						error:
							timeout instanceof FirstChunkTimeout
								? timeout.message
								: `${engineName} tts/stream: ${message}`,
					});
			} finally {
				clearTimeout(ttfbTimer);
			}
		}),
	);

	return router;
}

// ── Ordinary read-aloud: bounded synthesis + WAV transport ─────────

const ZONOS_CHUNK_MAX_CHARS = 440;

/**
 * Split ordinary read-aloud text into bounded requests for ZONOS3-Mini:
 * disable the Kokoro-era 36-char first-clause split (Zonos already streams
 * prefix audio within one request) and pack consecutive sentences up to the
 * per-generation budget so short replies stay in one continuous synthesis.
 */
export function splitZonosReadAloud(text: string): string[] {
	const splitter = new SpokenSentences(false);
	const chunks: string[] = [];
	let packed = "";
	for (let offset = 0; offset < text.length; offset += 220) {
		const sentences = splitter.push(text.slice(offset, offset + 220), offset + 220 >= text.length);
		for (const sentence of sentences) {
			if (packed && packed.length + 1 + sentence.length <= ZONOS_CHUNK_MAX_CHARS) {
				packed = `${packed} ${sentence}`;
			} else {
				if (packed) chunks.push(packed);
				packed = sentence;
			}
		}
	}
	if (packed) chunks.push(packed);
	return chunks;
}

async function* synthZonosPcm(
	text: string,
	speed: number,
	controller: AbortController,
): AsyncGenerator<Uint8Array> {
	for (const chunk of splitZonosReadAloud(text)) {
		controller.signal.throwIfAborted();
		const timer = firstChunkTimer(controller, "ZONOS3-Mini");
		try {
			const upstream = await fetch(`${ZONOS_RELAY_BASE}/tts/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Zonos-Alignment": ZONOS3_ALIGNMENT },
				body: JSON.stringify({ text: chunk, voice: "Savannah", speed }),
				signal: controller.signal,
			});
			if (!upstream.ok)
				throw new Error(
					`zonos3 tts upstream ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`,
				);
			// Without this opt-in Zonos returns raw float32, not framed PCM16.
			if (upstream.headers.get("X-Zonos-Alignment") !== ZONOS3_ALIGNMENT) {
				await upstream.body?.cancel();
				throw new Error("ZONOS3-Mini PCM stream negotiation unavailable; no speech fallback");
			}
			for await (const pcm of zonosPcm(upstream)) {
				clearTimeout(timer);
				yield pcm;
			}
		} catch (error) {
			// Fetch can reject a body read with a generic AbortError after headers.
			controller.signal.throwIfAborted();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}

async function synthZonos(text: string, speed: number, res: Response): Promise<void> {
	// Same disconnect handling as the streaming route: this route only responds
	// once the WHOLE utterance is synthesized, so a browser that goes away
	// mid-synthesis (stop pressed during the fallback path, navigation) would
	// otherwise leave Zonos burning CPU — minutes of it, at the 30k-char cap —
	// on audio nobody will ever hear.
	//
	// No deadline on the whole reply; synthZonosPcm bounds the wait for each
	// synthesis request to start streaming.
	const clientGone = new AbortController();
	res.on("close", () => clientGone.abort());
	try {
		const chunks: Uint8Array[] = [];
		for await (const pcm of synthZonosPcm(text, speed, clientGone)) chunks.push(pcm);
		const wav = pcmWav(Buffer.concat(chunks));
		res.setHeader("Content-Type", "audio/wav");
		res.setHeader("Content-Length", String(wav.length));
		res.setHeader("Cache-Control", "no-store");
		res.send(wav);
	} catch (e) {
		// An aborted fetch means the browser left; there is nobody to answer.
		if (res.destroyed) return;
		const message = e instanceof Error ? e.message : String(e);
		res.status(e instanceof FirstChunkTimeout ? 504 : 502).json({
			error: `zonos3 tts failed at ${ZONOS_RELAY_BASE}: ${message}`,
		});
	}
}

// ---------------------------------------------------------------------------
// Health probe (used by /api/health)
// ---------------------------------------------------------------------------

export const checkTtsAvailable = createCachedProbe(HEALTH_CACHE_MS, checkZonosHealth);

export function ttsHealthIsAvailable(data: {
	modelAvailable?: boolean;
	modelLoaded?: boolean;
}): boolean {
	// New lazy servers expose capability separately from warm residency. Fall
	// back to modelLoaded for older pi-voice-server releases.
	return (
		data.modelAvailable === true || (data.modelAvailable === undefined && data.modelLoaded === true)
	);
}

async function checkZonosHealth(): Promise<{
	available: boolean;
	reason?: string;
	voice?: string;
	engine: Engine;
}> {
	try {
		const res = await fetch(`${ZONOS_RELAY_BASE}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) {
			return { engine: "zonos3", available: false, reason: `upstream ${res.status}` };
		}
		const data = (await res.json()) as {
			modelAvailable?: boolean;
			modelLoaded?: boolean;
			modelResident?: boolean;
			voice?: string;
			voiceCount?: number;
		};
		if (!ttsHealthIsAvailable(data)) {
			return { engine: "zonos3", available: false, reason: "model unavailable" };
		}
		return {
			engine: "zonos3",
			available: true,
			voice: data.voice || "Savannah",
		};
	} catch (e) {
		return {
			engine: "zonos3",
			available: false,
			reason: `unreachable: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
