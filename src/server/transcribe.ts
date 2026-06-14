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

import { Router } from "express";
import express from "express";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import multer from "multer";
import { projectRoot } from "./paths.js";
import type { TranscribeResponse } from "../shared/protocol.js";

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
		let dir: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "agentchatbox-transcribe-"));
			const audioPath = join(dir, file.originalname || "voice.webm");
			await writeFile(audioPath, file.buffer);

			const { stdout, stderr, code } = await runHelper(audioPath);

			if (code !== 0) {
				res.status(500).json({ error: `transcribe.py exited ${code}: ${stderr.slice(0, 500)}` });
				return;
			}

			let parsed: HelperOutput;
			try {
				parsed = JSON.parse(stdout) as HelperOutput;
			} catch (e) {
				res.status(500).json({ error: `transcribe.py: malformed JSON output: ${stdout.slice(0, 200)}` });
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

function runHelper(audioPath: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolveP) => {
		const child = spawn(process.env.PYTHON_BIN || "python3", [HELPER_PATH, audioPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
		child.on("close", (code) => resolveP({ stdout, stderr, code: code ?? -1 }));
		child.on("error", (e) => resolveP({ stdout, stderr: stderr + `\nspawn error: ${e.message}`, code: -1 }));
	});
}

// ---------------------------------------------------------------------------
// Used by /api/health to report whether the local Whisper is available.
// ---------------------------------------------------------------------------

export async function checkWhisperAvailable(): Promise<{ available: boolean; reason?: string }> {
	try {
		const { stdout, code } = await runHelper("--self-test");
		if (code !== 0) return { available: false, reason: stdout || "unknown" };
		return { available: true };
	} catch (e) {
		return { available: false, reason: e instanceof Error ? e.message : String(e) };
	}
}
