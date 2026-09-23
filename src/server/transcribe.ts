/**
 * Voice-note transcription endpoint.
 *
 * Proxies to the resident pi-stt-server daemons instead of shelling out to a
 * per-request faster-whisper process (the old path reloaded the model from
 * disk for every voice note). Engine selection lives inside the daemons;
 * this router owns only the ORDER:
 *
 *   STT_PRIMARY_URL   default http://127.0.0.1:8183 — Lappy's GPU whisper
 *                     (large-v3-turbo, int8_float16) via lappy-stt-tunnel
 *   STT_FALLBACK_URL  default http://127.0.0.1:8182 — this host's CPU
 *                     pi-stt-server (qwen3-asr-0.6B int8, whisper small)
 *
 * A Lappy sleep/deploy degrades to the CPU daemon transparently; both failing
 * returns 502 to the browser, same visible behaviour as the old helper
 * failing. See /home/lepton/pi-stt-server for the daemon contract:
 *   POST /transcribe  raw audio bytes → { text, engine, model, ... }
 *   GET  /health      → capability/residency metadata
 *
 * Two routes, one contract:
 *   POST /api/transcribe  multipart field "audio" → { text } JSON
 *
 * The browser never knows the engine — it just gets the transcript.
 */

import express, { type Request, type Response, type Router } from "express";
import multer from "multer";
import { asyncHandler } from "./async-handler.js";
import { createCachedProbe } from "./health-cache.js";

const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap on audio
});

/** Defaults; read per-call in sttChain() so tests and .env overrides apply. */
const DEFAULT_PRIMARY_URL = "http://127.0.0.1:8183";
const DEFAULT_FALLBACK_URL = "http://127.0.0.1:8182";

/** Bounded wait for a daemon answer — transcription is seconds, not minutes. */
const STT_TIMEOUT_MS = Number(process.env.STT_CLIENT_TIMEOUT_MS) || 120_000;

const HEALTH_CACHE_MS = 60 * 1000;

interface SttDaemonResponse {
	text?: string;
	engine?: string;
	model?: string;
	language?: string;
	duration?: number;
	error?: string;
}

interface SttAttempt {
	url: string;
	name: string;
}

/**
 * The ordered daemon chain for one transcription. Kept as data so the route
 * handler and the health probe share one source of truth for what is primary.
 */
export function sttChain(): SttAttempt[] {
	// Unset → default URL; empty string → fallback disabled (Lappy has no
	// second daemon to fall back to).
	const primary = process.env.STT_PRIMARY_URL?.trim() || DEFAULT_PRIMARY_URL;
	const fallbackRaw = process.env.STT_FALLBACK_URL;
	const fallback = fallbackRaw === undefined ? DEFAULT_FALLBACK_URL : fallbackRaw.trim();
	const chain: SttAttempt[] = [{ url: primary, name: "primary" }];
	if (fallback && fallback !== primary) {
		chain.push({ url: fallback, name: "fallback" });
	}
	return chain;
}

async function postToDaemon(
	url: string,
	audio: Buffer,
): Promise<{ ok: true; body: SttDaemonResponse } | { ok: false; error: string }> {
	let response: globalThis.Response;
	try {
		response = await fetch(`${url}/transcribe`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: new Uint8Array(audio),
			signal: AbortSignal.timeout(STT_TIMEOUT_MS),
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { ok: false, error: `stt daemon unreachable at ${url}: ${message}` };
	}
	const text = await response.text().catch(() => "");
	let body: SttDaemonResponse;
	try {
		body = JSON.parse(text) as SttDaemonResponse;
	} catch {
		return {
			ok: false,
			error: `stt daemon at ${url} returned non-JSON ${response.status}: ${text.slice(0, 200)}`,
		};
	}
	if (!response.ok || typeof body.text !== "string") {
		return {
			ok: false,
			error: `stt daemon at ${url} failed (${response.status}): ${body.error ?? body.text?.slice(0, 200) ?? "no transcript"}`,
		};
	}
	return { ok: true, body };
}

export function createTranscribeRouter(): Router {
	const router = express.Router();

	router.post(
		"/",
		upload.single("audio"),
		asyncHandler(async (req: Request, res: Response) => {
			const file = (req as express.Request & { file?: Express.Multer.File }).file;
			if (!file) {
				res.status(400).json({ error: "no audio uploaded (field name: 'audio')" });
				return;
			}

			const failures: string[] = [];
			for (const attempt of sttChain()) {
				const result = await postToDaemon(attempt.url, file.buffer);
				if (result.ok) {
					const transcript: SttDaemonResponse = { text: result.body.text };
					res.json(transcript);
					return;
				}
				failures.push(result.error);
			}
			res.status(502).json({ error: `all stt daemons failed: ${failures.join("; ")}` });
		}),
	);

	return router;
}

// ---------------------------------------------------------------------------
// Used by /api/health to report whether voice-note transcription is available.
// Cached (createCachedProbe) so the browser's frequent polls never hit the
// daemons more than once a minute. A daemon's /health is cheap (no model
// loading is triggered by a probe), so probing both is fine.
// ---------------------------------------------------------------------------

export const checkWhisperAvailable = createCachedProbe(HEALTH_CACHE_MS, computeWhisperAvailable);

async function computeWhisperAvailable(): Promise<{
	available: boolean;
	reason?: string;
	engine?: string;
	model?: string;
}> {
	const failures: string[] = [];
	for (const attempt of sttChain()) {
		try {
			const response = await fetch(`${attempt.url}/health`, {
				signal: AbortSignal.timeout(3000),
			});
			if (!response.ok) {
				failures.push(`${attempt.name}: upstream ${response.status}`);
				continue;
			}
			const body = (await response.json()) as {
				modelAvailable?: boolean;
				status?: string;
				engines?: Record<string, { model?: string }>;
			};
			if (body.modelAvailable === true && body.status === "ok") {
				// Engine metadata is display-only; the daemon reports its own engine.
				const engines = body.engines ?? {};
				const engineName = Object.keys(engines)[0];
				return {
					available: true,
					engine: engineName,
					model: engines[engineName]?.model,
				};
			}
			failures.push(`${attempt.name}: model unavailable`);
		} catch (e) {
			failures.push(`${attempt.name}: unreachable (${e instanceof Error ? e.message : String(e)})`);
		}
	}
	return { available: false, reason: failures.join("; ") };
}
