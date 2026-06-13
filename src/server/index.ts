/**
 * Agentchatbox server entry.
 *
 * Serves the built web UI from `public/`, and exposes the proxy / upload
 * / transcribe endpoints under `/api/*`.
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
import { createTranscribeRouter } from "./transcribe.js";

mkdirSync(config.uploadsDir, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// API routes
app.post("/api/stream", handleStream);
app.use("/api/upload", createUploadsRouter());
app.use("/api/transcribe", createTranscribeRouter());

// Simple health check
app.get("/api/health", (_req, res) => {
	res.json({ status: "ok", providers: Object.keys(config.apiKeys).filter((k) => config.apiKeys[k]) });
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

app.listen(config.port, config.host, () => {
	const providers = Object.keys(config.apiKeys).filter((k) => config.apiKeys[k]);
	console.log(`agentchatbox listening on http://${config.host}:${config.port}`);
	console.log(`  uploads dir:   ${config.uploadsDir}`);
	console.log(`  providers:     ${providers.length ? providers.join(", ") : "(none — set API keys in .env)"}`);
	console.log(`  whisper:       ${config.openaiApiKey ? "enabled" : "disabled (no OPENAI_API_KEY)"}`);
});
