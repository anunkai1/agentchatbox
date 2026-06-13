/**
 * Agentchatbox server entry.
 *
 * Serves the built web UI from `public/`, exposes the proxy / upload
 * / transcribe endpoints under `/api/*`, and runs a per-connection
 * server-side pi Agent over WebSocket at `/api/chat`.
 *
 * Run in dev with `npm run dev` (concurrent server + client watcher).
 * Run in prod with `npm start` after `npm run build`.
 */

import cors from "cors";
import express from "express";
import { existsSync, mkdirSync } from "node:fs";
import { config } from "./config.js";
import { handleStream } from "./proxy.js";
import { createUploadsRouter } from "./uploads.js";
import { createTranscribeRouter, checkWhisperAvailable } from "./transcribe.js";
import { createTtsRouter, checkTtsAvailable } from "./tts.js";
import { mountChatWs } from "./chat.js";

mkdirSync(config.uploadsDir, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Lightweight access log so we can see what the browser is actually doing.
app.use((req, _res, next) => {
	const ts = new Date().toISOString().slice(11, 23);
	const line = `${ts} ${req.method} ${req.url}`;
	if (req.url.startsWith("/api/")) {
		const len = req.headers["content-length"];
		console.log(`${line} (${len ?? 0} bytes)`);
	}
	next();
});

// API routes
app.post("/api/stream", handleStream);
app.use("/api/upload", createUploadsRouter());
app.use("/api/transcribe", createTranscribeRouter());
app.use("/api/tts", createTtsRouter());
/**
 * GET /api/changelog?limit=20
 * Returns the most recent N commits on the current HEAD, formatted for
 * the /changelog slash command. No auth.
 */
app.get("/api/changelog", (req, res) => {
	const limitRaw = Number.parseInt(String(req.query.limit ?? "20"), 10);
	const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 20));
	import("node:child_process").then(({ execFile }) => {
		execFile(
			"git",
			["log", `-n${String(limit)}`, "--pretty=format:%h%x09%ad%x09%s", "--date=iso"],
			{ cwd: process.cwd() },
			(err, stdout) => {
				if (err) {
					res.status(500).json({ error: `git log failed: ${err.message}` });
					return;
				}
				const commits = stdout
					.split("\n")
					.filter((l) => l.length > 0)
					.map((l) => {
						const [hash, date, ...rest] = l.split("\t");
						return { hash, date, subject: rest.join("\t") };
					});
				res.json({ commits });
			},
		);
	});
});

// Health check. Reports configured provider keys, local Whisper, local TTS.
app.get("/api/health", async (_req, res) => {
	const whisper = await checkWhisperAvailable();
	const tts = await checkTtsAvailable();
	res.json({
		status: "ok",
		providers: Object.keys(config.apiKeys).filter((k) => config.apiKeys[k]),
		whisper: whisper.available,
		whisperReason: whisper.available ? undefined : whisper.reason,
		tts: tts.available,
		ttsReason: tts.available ? undefined : tts.reason,
		ttsVoice: tts.voice,
	});
});

// Static files (built client)
const publicDir = "./public";
if (existsSync(publicDir)) {
	app.use(express.static(publicDir));
	// SPA fallback: serve index.html for any non-API GET.
	app.get(/^(?!\/api\/|\/uploads\/).*/, (_req, res) => {
		res.sendFile("index.html", { root: publicDir });
	});
} else {
	app.get("/", (_req, res) => {
		res
			.status(503)
			.type("text/plain")
			.send(
				"agentchatbox: client has not been built yet. Run `npm run build` or `npm run dev` first.",
			);
	});
}

const server = app.listen(config.port, config.host, () => {
	const providers = Object.keys(config.apiKeys).filter((k) => config.apiKeys[k]);
	console.log(`agentchatbox listening on http://${config.host}:${config.port}`);
	console.log(`  uploads dir:   ${config.uploadsDir}`);
	console.log(`  providers:     ${providers.length ? providers.join(", ") : "(none — set API keys in .env)"}`);
	console.log(`  whisper:       ${config.openaiApiKey ? "openai (disabled, using local faster-whisper)" : "local faster-whisper (CPU)"}`);
	console.log(`  tts:           local piper (CPU)`);
});

// WebSocket endpoint. Mounted on the same HTTP server so we don't need a
// second port.
mountChatWs(server);
