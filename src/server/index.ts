/**
 * Agentchatbox server entry.
 *
 * Serves the built web UI from `public/`, exposes the proxy / upload
 * / transcribe endpoints under `/api/*`, and runs a per-connection
 * server-side pi Agent over WebSocket at `/api/chat`.
 *
 * Run in dev with `npm run dev` (concurrent server + client watcher).
 * Run in prod with `npm start` after `npm run build`.
 *
 * `dotenv/config` is imported here (not in config.ts) so the .env file
 * is loaded exactly once at process start, before any module reads
 * process.env. config.ts is a pure data module.
 */

import "dotenv/config";

import cors from "cors";
import express from "express";
import { existsSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { config } from "./config.js";
import { handleStream } from "./proxy.js";
import { createUploadsRouter } from "./uploads.js";
import { createTranscribeRouter, checkWhisperAvailable } from "./transcribe.js";
import { createTtsRouter, checkTtsAvailable } from "./tts.js";
import { mountChatWs } from "./chat.js";
import { projectRoot } from "./paths.js";
import { SDK_PROVIDERS } from "./providers.js";
import { getModels } from "@earendil-works/pi-ai";

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

// Resolved once at boot. The commit hash goes into /api/health and
// the boot banner so an operator can verify the running process is on
// the expected tree. If git fails (e.g. running from a tarball) we fall
// back to "(unknown)" rather than blocking the server.
let COMMIT_HASH = "(unknown)";
try {
	COMMIT_HASH = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: projectRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim() || "(unknown)";
} catch {
	/* not a git checkout — leave the placeholder */
}

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
	execFile(
		"git",
		["log", `-n${String(limit)}`, "--pretty=format:%h%x09%ad%x09%s", "--date=iso"],
		{ cwd: projectRoot, maxBuffer: 1024 * 1024 },
		(err, stdout) => {
		if (err) {
			res.status(500).json({ error: `git log failed: ${err.message}` });
			return;
		}
		const commits = stdout
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => {
				const [hash, date, ...rest] = l.split("	");
				return { hash, date, subject: rest.join("	") };
			});
		res.json({ commits });
	},
	);
});

// Health check. Reports configured provider keys, local Whisper, local TTS,
// and the running commit hash (so an operator can verify the live process
// is on the expected tree). Cross-check against
// `git -C /home/architect/agentchatbox rev-parse HEAD` on the host.
app.get("/api/health", async (_req, res) => {
	const whisper = await checkWhisperAvailable();
	const tts = await checkTtsAvailable();
	res.json({
		status: "ok",
		commit: COMMIT_HASH,
		providers: Object.keys(config.apiKeys).filter((k) => config.apiKeys[k]),
		whisper: whisper.available,
		whisperReason: whisper.available ? undefined : whisper.reason,
		tts: tts.available,
		ttsReason: tts.available ? undefined : tts.reason,
		ttsVoice: tts.voice,
	});
});

/**
 * GET /api/models
 *
 * Returns the list of LLM models the client can pick from, one entry per
 * (provider, modelId). Only providers with a configured API key are
 * included — the server is the source of truth for what's available,
 * matching the policy in src/shared/protocol.ts.
 *
 * Shape: { models: Array<{ id, provider, name, reasoning }> }
 *   - id:        the model id (what /api/chat's setModel expects)
 *   - provider:  the provider key (e.g. "deepseek", "minimax")
 *   - name:      human-readable label
 *   - reasoning: true if the model supports thinking
 *
 * The custom "minimax" provider isn't in the SDK's built-in registry,
 * so we hand-build its entry here to keep the picker self-consistent.
 * (See providers.ts for the source of truth on which providers exist.)
 */
app.get("/api/models", (_req, res) => {
	const out: Array<{ id: string; provider: string; name: string; reasoning: boolean }> = [];

	for (const provider of SDK_PROVIDERS) {
		if (!config.apiKeys[provider]) continue;
		try {
			const models = getModels(provider);
			for (const m of models) {
				out.push({ id: m.id, provider, name: m.name, reasoning: !!m.reasoning });
			}
		} catch (e) {
			// If the SDK doesn't know this provider, skip it rather than
			// 500ing the whole endpoint.
			console.warn(`[models] failed to list models for ${provider}:`, e instanceof Error ? e.message : e);
		}
	}

	// Custom "minimax" provider — not in the SDK registry, but used by
	// this app as the default. Match the construction in agent.ts so the
	// model id the client picks is the same one the server resolves.
	// input: ["text","image"] marks M3 as multimodal — image uploads work
	// when this model is selected.
	if (config.apiKeys["minimax"]) {
		out.push({
			id: "MiniMax-M3",
			provider: "minimax",
			name: "MiniMax M3",
			reasoning: true,
		});
	}

	res.json({ models: out });
});

// Static files (built client). Resolved against the project root so the
// server works regardless of the process working directory.
const publicDir = resolve(projectRoot, "public");
if (existsSync(publicDir)) {
	app.use(express.static(publicDir));
	// Serve uploaded files at /uploads/<id>.<ext>. We mount the whole
	// uploads dir as static so the URLs returned by /api/upload are
	// fetchable. The upload IDs are random UUIDs (unguessable), which
	// is sufficient capability for this single-user local app. The SPA
	// fallback below explicitly excludes /uploads/ so it doesn't try to
	// serve index.html for missing files.
	if (existsSync(config.uploadsDir)) {
		app.use(
			"/uploads",
			express.static(config.uploadsDir, {
				fallthrough: true,
				maxAge: "1h",
			}),
		);
	}
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
	console.log(`  commit:        ${COMMIT_HASH}`);
	console.log(`  uploads dir:   ${config.uploadsDir}`);
	console.log(`  providers:     ${providers.length ? providers.join(", ") : "(none — set API keys in .env)"}`);
	console.log(`  whisper:       ${config.openaiApiKey ? "openai (disabled, using local faster-whisper)" : "local faster-whisper (CPU)"}`);
	console.log(`  tts:           local piper (CPU)`);
});

// WebSocket endpoint. Mounted on the same HTTP server so we don't need a
// second port.
mountChatWs(server);
