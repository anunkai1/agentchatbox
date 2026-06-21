/**
 * Voice note transcription.
 *
 * Accepts a multipart audio upload, runs it through a local `faster-whisper`
 * model on CPU, and returns the transcript. The browser then sends the
 * transcript as a regular text prompt to the agent.
 *
 * Why local: the user does not want to use the OpenAI API (no key, local-first
 * stance, CPU-only box). faster-whisper runs in Python; we shell out to a
 * small Python helper script that reads the audio from a temp file and prints
 * the transcript on stdout. Model auto-downloads on first call (the `small`
 * model is ~460MB and runs at real-time on a modern CPU).
 *
 * The Python helper is at `scripts/transcribe.py` and is invoked via
 * `python3 scripts/transcribe.py <path>`. We capture stdout and JSON-parse
 * { text, language, duration }.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express, { type Router } from "express";
import multer from "multer";
import type { TranscribeResponse } from "../shared/protocol.js";
import { projectRoot } from "./paths.js";
import { DEFAULT_PYTHON_TIMEOUT_MS, runPython } from "./python-runner.js";

const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap on audio
});

// Resolve the Python helper relative to the project root, not the
// process's working directory. The server may be started from anywhere.
const HELPER_PATH = resolve(projectRoot, "scripts/transcribe.py");

interface HelperOutput {
	text: string;
	language?: string;
	duration?: number;
}

export function createTranscribeRouter(): Router {
	const router = express.Router();

	router.post("/", upload.single("audio"), async (req, res) => {
		const file = (req as express.Request & { file?: Express.Multer.File }).file;
		if (!file) {
			res.status(400).json({ error: "no audio uploaded (field name: 'audio')" });
			return;
		}

		// Stage the audio to a temp dir (faster-whisper wants a real path).
		// We sanitize the filename to a safe stem so the temp path can't
		// escape the dir via a malicious originalname.
		let dir: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "agentchatbox-transcribe-"));
			const safeStem = (file.originalname || "voice.webm").replace(/[^\w.-]+/g, "_").slice(0, 64);
			const audioPath = join(dir, safeStem || "voice.webm");
			await writeFile(audioPath, file.buffer);

			const { stdout, stderr, code, timedOut } = await runPython({
				bin: process.env.PYTHON_BIN || "python3",
				helperPath: HELPER_PATH,
				helperArgs: [audioPath],
				timeoutMs: DEFAULT_PYTHON_TIMEOUT_MS,
			});

			if (timedOut) {
				res.status(504).json({
					error: `transcribe.py timed out after ${DEFAULT_PYTHON_TIMEOUT_MS}ms`,
				});
				return;
			}
			if (code !== 0) {
				res.status(500).json({
					error: `transcribe.py exited ${code}: ${stderr.slice(0, 500)}`,
				});
				return;
			}

			let parsed: HelperOutput;
			try {
				parsed = JSON.parse(stdout) as HelperOutput;
			} catch {
				res.status(500).json({
					error: `transcribe.py: malformed JSON output: ${stdout.slice(0, 200)}`,
				});
				return;
			}

			const response: TranscribeResponse = { text: parsed.text };
			res.json(response);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			res.status(500).json({ error: `transcription failed: ${message}` });
		} finally {
			if (dir) {
				rm(dir, { recursive: true, force: true }).catch(() => {
					/* best-effort */
				});
			}
		}
	});

	return router;
}

// ---------------------------------------------------------------------------
// Used by /api/health to report whether the local Whisper is available.
// Cached for `HEALTH_CACHE_MS` so the health check doesn't spawn a Python
// process (and trigger a faster-whisper model load) on every browser poll.
// ---------------------------------------------------------------------------

const HEALTH_CACHE_MS = 60 * 1000; // 60 s

interface HealthCache {
	at: number;
	result: { available: boolean; reason?: string };
}
let whisperHealthCache: HealthCache | null = null;

export async function checkWhisperAvailable(): Promise<{
	available: boolean;
	reason?: string;
}> {
	const now = Date.now();
	if (whisperHealthCache && now - whisperHealthCache.at < HEALTH_CACHE_MS) {
		return whisperHealthCache.result;
	}

	let result: { available: boolean; reason?: string };
	try {
		// Fast path: if the helper script isn't even on disk, fail
		// immediately. Saves a process spawn when the server's deploy
		// tree is missing the python scripts (e.g. partial install).
		if (!existsSync(HELPER_PATH)) {
			result = {
				available: false,
				reason: `helper not found at ${HELPER_PATH}`,
			};
		} else {
			const { stdout, code, timedOut } = await runPython({
				bin: process.env.PYTHON_BIN || "python3",
				helperPath: HELPER_PATH,
				helperArgs: ["--self-test"],
				timeoutMs: 30_000,
			});
			if (timedOut) result = { available: false, reason: "self-test timed out" };
			else if (code !== 0) result = { available: false, reason: stdout || "unknown" };
			else result = { available: true };
		}
	} catch (e) {
		result = {
			available: false,
			reason: e instanceof Error ? e.message : String(e),
		};
	}
	whisperHealthCache = { at: now, result };
	return result;
}
