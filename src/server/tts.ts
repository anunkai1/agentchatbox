/**
 * TTS endpoint.
 *
 * Proxies to the pi-voice-server systemd service at http://127.0.0.1:8181
 * (Kokoro-82M ONNX, warm in memory, ~1.5s for a sentence on CPU). The server
 * is operated separately — see /home/lepton/pi-voice-server and the
 * `pi-voice-server.service` unit.
 *
 * (A legacy Piper engine path was removed 2026-07-24 — Kokoro had been the
 * sole configured engine in production for a long time; Piper was dead code.)
 *
 * Two routes, same contract to the browser:
 *   POST /api/tts        { text, voice? } → audio/wav (whole blob)
 *   POST /api/tts/stream { text, voice? } → binary frame stream (chunked)
 *   GET  /api/tts/voices { default, available: string[] }
 *
 * The browser never knows the engine — it just plays the WAV / frames.
 */

import express, { type Request, type Response, type Router } from "express";
import { asyncHandler } from "./async-handler.js";
import { createCachedProbe } from "./health-cache.js";

/**
 * Hard cap on input length. Kokoro itself has no text limit — this exists
 * only to reject absurd/misuse-sized payloads before we spend minutes of CPU
 * synthesizing. 30k chars is ~45-60 min of audio, well past anything a real
 * voice reply produces. The client truncates just under this (TTS_MAX_CHARS
 * in voice.ts) so a normal long message never hits the 413.
 */
const MAX_TEXT_CHARS = 30_000;

type Engine = "kokoro";

/**
 * Validate the shared { text, voice? } body for POST / and POST /stream.
 * Extracted so both routes apply the identical checks (non-empty text,
 * length cap) in one place.
 */
type TtsInput = { text: string; voice: string | undefined };
export function parseTtsBody(req: Request): TtsInput | { error: string; status: number } {
	const body = req.body as { text?: unknown; voice?: unknown } | undefined;
	const text = typeof body?.text === "string" ? body.text : "";
	if (!text.trim()) return { error: "no text (field name: 'text')", status: 400 };
	if (text.length > MAX_TEXT_CHARS) {
		return { error: `text too long (max ${MAX_TEXT_CHARS} chars)`, status: 413 };
	}
	const voice = typeof body?.voice === "string" && body.voice.length > 0 ? body.voice : undefined;
	return { text, voice };
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
			const { text, voice } = parsed;
			await synthKokoro(text, voice, res);
		}),
	);

	/**
	 * POST /api/tts/stream
	 * Body: { text: string, voice?: string }
	 * Returns: application/octet-stream — a binary frame stream (one frame
	 * per synthesized text chunk) forwarded verbatim from pi-voice-server's
	 * /tts/stream, so the browser can start playing the first chunk while
	 * later chunks are still being synthesized.
	 *
	 * Frame layout: [1 byte type][uint32 LE length N][N bytes payload]
	 *   0x01 DATA (payload = WAV) · 0x00 END · 0x80 ERR (payload = message)
	 *
	 * This route is a pure byte pipe — no parsing, no business logic. The
	 * server stays the transport layer; the browser owns chunked playback.
	 */
	router.post(
		"/stream",
		asyncHandler(async (req: Request, res: Response) => {
			const parsed = parseTtsBody(req);
			if ("error" in parsed) {
				res.status(parsed.status).json({ error: parsed.error });
				return;
			}
			const { text, voice } = parsed;

			// Abort upstream the moment the browser goes away (stop button,
			// navigation) so pi-voice-server stops spending CPU on chunks no one
			// will hear. res 'close' also fires on normal completion, where
			// aborting an already-finished fetch is a harmless no-op.
			const clientGone = new AbortController();
			res.on("close", () => clientGone.abort());

			let upstream: globalThis.Response;
			try {
				upstream = await fetch(`${KOKORO_BASE}/tts/stream`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text, voice: voice ?? KOKORO_DEFAULT_VOICE, speed: 1 }),
					signal: clientGone.signal,
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				res.status(502).json({ error: `kokoro tts unreachable at ${KOKORO_BASE}: ${message}` });
				return;
			}
			// Pre-stream upstream failure (e.g. 503 model not loaded): relay as JSON
			// so the client can fall back to the whole-blob endpoint.
			if (!upstream.ok || !upstream.body) {
				const errText = await upstream.text().catch(() => "");
				res.status(502).json({
					error: `kokoro tts/stream upstream ${upstream.status}: ${errText.slice(0, 300)}`,
				});
				return;
			}

			res.setHeader("Content-Type", "application/octet-stream");
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-Accel-Buffering", "no"); // defeat any reverse-proxy buffering

			const reader = upstream.body.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						// Zero-copy wrap the Uint8Array into a Buffer for res.write.
						const more = res.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
						// Honor backpressure: res.write() returns false when the socket's
						// write buffer is full. Without waiting for 'drain' we'd keep
						// pulling from upstream and buffer the whole stream in memory on a
						// slow client (a long voice reply can be several MB of WAV).
						// waitForDrain also resolves on 'close' so a disconnect mid-wait
						// can't wedge the pipe — clientGone aborts the upstream fetch,
						// the next reader.read() rejects, and we drop into the catch.
						if (!more) await waitForDrain(res);
					}
				}
				res.end();
			} catch (e) {
				if (!res.headersSent) {
					const message = e instanceof Error ? e.message : String(e);
					res.status(502).json({ error: `tts stream pipe failed: ${message}` });
				} else {
					try {
						res.end();
					} catch {
						/* client already gone */
					}
				}
			}
		}),
	);

	/**
	 * GET /api/tts/voices
	 * Returns: { default: string, available: string[] }
	 */
	router.get(
		"/voices",
		asyncHandler(async (_req, res) => {
			const list = await kokoroVoices();
			res.json({ default: KOKORO_DEFAULT_VOICE, available: list });
		}),
	);

	return router;
}

// ── Kokoro: HTTP proxy to pi-voice-server ──────────────────────────

async function synthKokoro(text: string, voice: string | undefined, res: Response): Promise<void> {
	try {
		const upstream = await fetch(`${KOKORO_BASE}/tts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, voice: voice ?? KOKORO_DEFAULT_VOICE, speed: 1 }),
		});
		if (!upstream.ok) {
			const errText = (await upstream.text()).slice(0, 300);
			res.status(502).json({
				error: `kokoro tts upstream ${upstream.status}: ${errText}`,
			});
			return;
		}
		const wav = Buffer.from(await upstream.arrayBuffer());
		res.setHeader("Content-Type", "audio/wav");
		res.setHeader("Content-Length", String(wav.length));
		res.setHeader("Cache-Control", "no-store");
		res.send(wav);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		res.status(502).json({
			error: `kokoro tts unreachable at ${KOKORO_BASE}: ${message}`,
		});
	}
}

async function kokoroVoices(): Promise<string[]> {
	const res = await fetch(`${KOKORO_BASE}/voices`, { signal: AbortSignal.timeout(3000) });
	if (!res.ok) throw new Error(`upstream ${res.status}`);
	const data = (await res.json()) as { voices?: string[] };
	return data.voices ?? [];
}

// ---------------------------------------------------------------------------
// Health probe (used by /api/health)
// ---------------------------------------------------------------------------

const HEALTH_CACHE_MS = 60 * 1000;

export const checkTtsAvailable = createCachedProbe(HEALTH_CACHE_MS, computeTtsAvailable);

async function computeTtsAvailable(): Promise<{
	available: boolean;
	reason?: string;
	voice?: string;
	engine: Engine;
}> {
	return checkKokoroHealth();
}

export function kokoroHealthIsAvailable(data: {
	modelAvailable?: boolean;
	modelLoaded?: boolean;
}): boolean {
	// New lazy servers expose capability separately from warm residency. Fall
	// back to modelLoaded for older pi-voice-server releases.
	return (
		data.modelAvailable === true || (data.modelAvailable === undefined && data.modelLoaded === true)
	);
}

async function checkKokoroHealth(): Promise<{
	available: boolean;
	reason?: string;
	voice?: string;
	engine: Engine;
}> {
	try {
		const res = await fetch(`${KOKORO_BASE}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) {
			return { engine: "kokoro", available: false, reason: `upstream ${res.status}` };
		}
		const data = (await res.json()) as {
			modelAvailable?: boolean;
			modelLoaded?: boolean;
			modelResident?: boolean;
			voice?: string;
			voiceCount?: number;
		};
		if (!kokoroHealthIsAvailable(data)) {
			return { engine: "kokoro", available: false, reason: "model unavailable" };
		}
		return {
			engine: "kokoro",
			available: true,
			voice: data.voice || KOKORO_DEFAULT_VOICE,
		};
	} catch (e) {
		return {
			engine: "kokoro",
			available: false,
			reason: `unreachable: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

// NOTE: this module previously also hosted a Piper engine (shell out to
// scripts/tts.py). It was removed 2026-07-24 — Kokoro had been the sole
// configured engine in production for a long time. If a second engine is ever
// needed again, reintroduce an `engine()` discriminator + a synth/health path
// per engine; the route handlers above already centralize body validation.
