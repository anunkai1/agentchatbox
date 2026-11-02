/**
 * Voice-note transcription endpoint.
 *
 * Proxies to the resident pi-stt-server daemon instead of shelling out to a
 * per-request faster-whisper process (the old path reloaded the model from
 * disk for every voice note). Engine selection (multilingual Qwen3-ASR by default)
 * lives inside the daemon; this router owns only which daemons to try:
 *
 *   STT_PRIMARY_URL   default http://127.0.0.1:8182 — primary pi-stt-server daemon
 *   STT_FALLBACK_URL  default unset — an optional second daemon
 *
 * Every daemon failing returns 502 to the browser, same visible behaviour as
 * the old helper failing. Daemon contract:
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
import { log } from "./logger.js";

const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap on audio
});

/** Defaults; read per-call in sttChain() so tests and .env overrides apply. */
const DEFAULT_PRIMARY_URL = "http://127.0.0.1:8182";

/** Match the daemon's five-minute processing budget, including slow CPU notes. */
const STT_TIMEOUT_MS = Number(process.env.STT_CLIENT_TIMEOUT_MS) || 300_000;

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
	// Unset or empty fallback → only the primary daemon is tried.
	const primary = process.env.STT_PRIMARY_URL?.trim() || DEFAULT_PRIMARY_URL;
	const fallback = process.env.STT_FALLBACK_URL?.trim();
	const chain: SttAttempt[] = [{ url: primary, name: "primary" }];
	if (fallback && fallback !== primary) {
		chain.push({ url: fallback, name: "fallback" });
	}
	return chain;
}

async function postToDaemon(
	url: string,
	audio: Buffer,
): Promise<{ ok: true; body: SttDaemonResponse } | { ok: false; error: string; status?: number }> {
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
			status: response.status,
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
				if (result.status === 413) {
					res.status(413).json({ error: "Audio is too long. Record no more than five minutes." });
					return;
				}
				failures.push(result.error);
			}
			// The detail names internal addresses, so it goes to the log, not the browser.
			log.error("transcription failed on every daemon", { failures });
			res.status(502).json({ error: "all stt daemons failed" });
		}),
	);

	return router;
}

// ---------------------------------------------------------------------------
// Used by /api/health to report whether voice-note transcription is available.
// Cached (createCachedProbe) so the browser's frequent polls never hit the
// daemons more than once a minute. A daemon's /health is cheap (no model
// loading is triggered by a probe), so checking the configured chain is cheap.
// ---------------------------------------------------------------------------

export const checkSttAvailable = createCachedProbe(HEALTH_CACHE_MS, computeSttAvailable);

async function computeSttAvailable(): Promise<{
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
