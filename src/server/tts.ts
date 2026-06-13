/**
 * Local TTS via piper-tts.
 *
 * Mirrors the transcribe.ts pattern: we shell out to a Python helper
 * (scripts/tts.py) that loads a piper voice, synthesizes the text, and
 * writes a WAV to a temp file. We return the WAV bytes to the client
 * with audio/wav content type.
 *
 * Why local piper:
 *   - No paid APIs / no API keys (per user preference)
 *   - CPU-only, ~15-60MB voice model, real-time synthesis on modern CPU
 *   - Audio is on-device, never leaves the box
 *
 * Default voice: en_US-amy-medium (matches the user's hermes TTS
 * config). Override via PIPER_VOICE env var.
 */

import { Router } from "express";
import express, { type Request, type Response } from "express";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HELPER_PATH = resolve(process.cwd(), "scripts/tts.py");

const MAX_TEXT_CHARS = 4096; // hard cap on input — prevents runaway synthesis

export function createTtsRouter(): Router {
	const router = express.Router();

	/**
	 * POST /api/tts
	 * Body: { text: string, voice?: string }
	 * Returns: audio/wav bytes
	 */
	router.post("/", async (req: Request, res: Response) => {
		const body = req.body as { text?: unknown; voice?: unknown } | undefined;
		const text = typeof body?.text === "string" ? body.text : "";
		if (!text.trim()) {
			res.status(400).json({ error: "no text (field name: 'text')" });
			return;
		}
		if (text.length > MAX_TEXT_CHARS) {
			res.status(413).json({ error: `text too long (max ${MAX_TEXT_CHARS} chars)` });
			return;
		}

		let dir: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "agentchatbox-tts-"));
			const txtPath = join(dir, "input.txt");
			const wavPath = join(dir, "output.wav");
			await writeFile(txtPath, text, "utf8");

			const env = { ...process.env };
			if (typeof body?.voice === "string" && body.voice.length > 0) {
				env.PIPER_VOICE = body.voice;
			}

			const { stdout, stderr, code } = await runHelper([txtPath, wavPath], env);

			if (code !== 0) {
				const tail = (stderr || stdout).slice(-500);
				res.status(500).json({ error: `tts.py exited ${code}: ${tail}` });
				return;
			}

			const wav = await readFile(wavPath);
			res.setHeader("Content-Type", "audio/wav");
			res.setHeader("Content-Length", String(wav.length));
			res.setHeader("Cache-Control", "no-store");
			res.send(wav);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			res.status(500).json({ error: `tts failed: ${message}` });
		} finally {
			if (dir) {
				rm(dir, { recursive: true, force: true }).catch(() => {
					/* best-effort */
				});
			}
		}
	});

	/**
	 * GET /api/voices
	 * Returns: { default: string, available: string[] }
	 * Lists piper voice models present on disk.
	 */
	router.get("/voices", async (_req, res) => {
		try {
			const voices = await listVoices();
			res.json({ default: process.env.PIPER_VOICE || "en_US-amy-medium", available: voices });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			res.status(500).json({ error: `voice list failed: ${message}` });
		}
	});

	return router;
}

function runHelper(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolveP) => {
		const child = spawn(process.env.PYTHON_BIN || "python3", [HELPER_PATH, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
		child.on("close", (code) => resolveP({ stdout, stderr, code: code ?? -1 }));
		child.on("error", (e) => resolveP({ stdout, stderr: stderr + `\nspawn error: ${e.message}`, code: -1 }));
	});
}

async function listVoices(): Promise<string[]> {
	const { readdir, stat } = await import("node:fs/promises");
	const base = resolve(process.env.HOME || "/root", ".local/share/piper/voices");
	try {
		await stat(base);
	} catch {
		return [];
	}
	const entries = await readdir(base);
	return entries.filter((n) => n.endsWith(".onnx")).map((n) => n.replace(/\.onnx$/, ""));
}

// ---------------------------------------------------------------------------
// Health probe (used by /api/health)
// ---------------------------------------------------------------------------

export async function checkTtsAvailable(): Promise<{ available: boolean; reason?: string; voice?: string }> {
	return new Promise((resolveP) => {
		const child = spawn(process.env.PYTHON_BIN || "python3", [HELPER_PATH, "--self-test"], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
		child.on("close", (code) => {
			if (code !== 0) {
				resolveP({ available: false, reason: stderr || stdout || "unknown" });
				return;
			}
			try {
				const info = JSON.parse(stdout) as { voice: string };
				resolveP({ available: true, voice: info.voice });
			} catch {
				resolveP({ available: true });
			}
		});
		child.on("error", (e) => resolveP({ available: false, reason: e.message }));
	});
}
