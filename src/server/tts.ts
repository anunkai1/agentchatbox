/**
 * TTS endpoint.
 *
 * Two engines, selected by the `TTS_ENGINE` env var:
 *
 *   - `kokoro` (recommended): proxies to the pi-voice-server systemd service
 *     at http://127.0.0.1:8181 (Kokoro-82M ONNX, warm in memory, ~1.5s for a
 *     sentence on CPU). The server is operated separately — see
 *     /home/lepton/pi-voice-server and the `pi-voice-server.service` unit.
 *
 *   - `piper` (legacy default): shells out to scripts/tts.py (piper-tts).
 *     Kept as a fallback; lower quality but no separate service required.
 *
 * Both expose the same contract to the browser:
 *   POST /api/tts        { text, voice? } → audio/wav
 *   GET  /api/tts/voices { default, available: string[] }
 *
 * The browser never knows which engine is running — it just plays the WAV.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express, { type Request, type Response, type Router } from "express";
import { projectRoot } from "./paths.js";
import { DEFAULT_PYTHON_TIMEOUT_MS, runPython } from "./python-runner.js";

const HELPER_PATH = resolve(projectRoot, "scripts/tts.py");
const MAX_TEXT_CHARS = 4096; // hard cap — prevents runaway synthesis

type Engine = "kokoro" | "piper";

function engine(): Engine {
	const e = (process.env.TTS_ENGINE || "piper").toLowerCase();
	return e === "kokoro" ? "kokoro" : "piper";
}

const KOKORO_BASE =
	process.env.KOKORO_TTS_URL || `http://${process.env.KOKORO_HOST || "127.0.0.1"}:${process.env.KOKORO_PORT || "8181"}`;
const KOKORO_DEFAULT_VOICE = process.env.KOKORO_VOICE || "af_heart";

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
		const voice =
			typeof body?.voice === "string" && body.voice.length > 0 ? body.voice : undefined;

		if (engine() === "kokoro") {
			await synthKokoro(text, voice, res);
		} else {
			await synthPiper(text, voice, res);
		}
	});

	/**
	 * GET /api/tts/voices
	 * Returns: { default: string, available: string[] }
	 */
	router.get("/voices", async (_req, res) => {
		try {
			if (engine() === "kokoro") {
				const list = await kokoroVoices();
				res.json({ default: KOKORO_DEFAULT_VOICE, available: list });
			} else {
				const voices = await listPiperVoices();
				res.json({
					default: process.env.PIPER_VOICE || "en_US-amy-medium",
					available: voices,
				});
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			res.status(500).json({ error: `voice list failed: ${message}` });
		}
	});

	return router;
}

// ── Kokoro: HTTP proxy to pi-voice-server ──────────────────────────

async function synthKokoro(
	text: string,
	voice: string | undefined,
	res: Response,
): Promise<void> {
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

// ── Piper: shell out to scripts/tts.py (legacy) ────────────────────

async function synthPiper(
	text: string,
	voice: string | undefined,
	res: Response,
): Promise<void> {
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(tmpdir(), "agentchatbox-tts-"));
		const txtPath = join(dir, "input.txt");
		const wavPath = join(dir, "output.wav");
		await writeFile(txtPath, text, "utf8");

		const env = { ...process.env };
		if (voice) env.PIPER_VOICE = voice;

		const { stdout, stderr, code, timedOut } = await runPython({
			bin: process.env.PYTHON_BIN || "python3",
			helperPath: HELPER_PATH,
			helperArgs: [txtPath, wavPath],
			env,
			timeoutMs: DEFAULT_PYTHON_TIMEOUT_MS,
		});

		if (timedOut) {
			res.status(504).json({
				error: `tts.py timed out after ${DEFAULT_PYTHON_TIMEOUT_MS}ms`,
			});
			return;
		}
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
}

async function listPiperVoices(): Promise<string[]> {
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

const HEALTH_CACHE_MS = 60 * 1000;
interface HealthCache {
	at: number;
	result: { available: boolean; reason?: string; voice?: string; engine: Engine };
}
let healthCache: HealthCache | null = null;

export async function checkTtsAvailable(): Promise<{
	available: boolean;
	reason?: string;
	voice?: string;
	engine?: Engine;
}> {
	const now = Date.now();
	if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) {
		return healthCache.result;
	}

	let result: { available: boolean; reason?: string; voice?: string; engine: Engine };
	if (engine() === "kokoro") {
		result = await checkKokoroHealth();
	} else {
		result = { engine: "piper", ...(await checkPiperHealth()) };
	}
	healthCache = { at: now, result };
	return result;
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
			modelLoaded?: boolean;
			voice?: string;
			voiceCount?: number;
		};
		if (!data.modelLoaded) {
			return { engine: "kokoro", available: false, reason: "model not loaded" };
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

async function checkPiperHealth(): Promise<{
	available: boolean;
	reason?: string;
	voice?: string;
}> {
	const { stdout, stderr, code, timedOut } = await runPython({
		bin: process.env.PYTHON_BIN || "python3",
		helperPath: HELPER_PATH,
		helperArgs: ["--self-test"],
		env: process.env,
		timeoutMs: 30_000,
	});

	if (timedOut) return { available: false, reason: "self-test timed out" };
	if (code !== 0) return { available: false, reason: stderr || stdout || "unknown" };
	try {
		const info = JSON.parse(stdout) as { voice: string };
		return { available: true, voice: info.voice };
	} catch {
		return { available: true };
	}
}
