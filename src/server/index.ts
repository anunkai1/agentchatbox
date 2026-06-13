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

// Health check. Reports configured provider keys AND whether local Whisper
// is available (so the client can fall back gracefully if it isn't).
app.get("/api/health", async (_req, res) => {
	const whisper = await checkWhisperAvailable();
	res.json({
		status: "ok",
		providers: Object.keys(config.apiKeys).filter((k) => config.apiKeys[k]),
		whisper: whisper.available,
		whisperReason: whisper.available ? undefined : whisper.reason,
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
});

// WebSocket endpoint. Mounted on the same HTTP server so we don't need a
// second port.
mountChatWs(server);
