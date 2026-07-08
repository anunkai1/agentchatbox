/**
 * Agentchatbox server entry.
 *
 * Serves the built web UI from `public/`, exposes the upload
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

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getModels } from "@earendil-works/pi-ai";
import cors from "cors";
import express from "express";
import { getCapabilities } from "./capabilities.js";
import { mountChatWs, shutdownChatWs } from "./chat.js";
import { config } from "./config.js";
import { createFilesRouter } from "./files.js";
import { log } from "./logger.js";
import { projectRoot } from "./paths.js";
import { EXTRA_MODELS, EXTRA_IMAGE_MODELS, SDK_PROVIDERS } from "./providers.js";
import { listPiSessions, readPiSessionMessages } from "./session-list.js";
import { listProjects, readProjectInstructions } from "./projects.js";
import { checkWhisperAvailable, createTranscribeRouter } from "./transcribe.js";
import { checkTtsAvailable, createTtsRouter } from "./tts.js";
import { createUploadsRouter } from "./uploads.js";

mkdirSync(config.uploadsDir, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Lightweight access log so we can see what the browser is actually doing.
app.use((req, _res, next) => {
	if (req.url.startsWith("/api/")) {
		log.info("http request", {
			method: req.method,
			path: req.url,
			bytes: Number(req.headers["content-length"] ?? 0),
		});
	}
	next();
});

// Resolved once at boot. The commit hash goes into /api/health and
// the boot banner so an operator can verify the running process is on
// the expected tree. If git fails (e.g. running from a tarball) we fall
// back to "(unknown)" rather than blocking the server.
let COMMIT_HASH = "(unknown)";
try {
	COMMIT_HASH =
		execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: projectRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || "(unknown)";
} catch {
	/* not a git checkout — leave the placeholder */
}

// API routes
app.use("/api/upload", createUploadsRouter());
app.use("/api/file", createFilesRouter());
app.use("/api/transcribe", createTranscribeRouter());
app.use("/api/tts", createTtsRouter());

/**
 * GET /api/sessions
 *
 * Returns the list of saved `pi` sessions for the server's cwd
 * (matching what `pi --resume` would show in the TUI). The browser's
 * `/sessions` slash command calls this to populate the picker.
 *
 * Shape: { sessions: Array<{ id, cwd, createdAt, modifiedAt, title, messageCount }> }
 *
 * Pass ?cwd=<path> to query a different cwd; defaults to config.piCwd.
 */
app.get("/api/sessions", (req, res) => {
	const cwd = String(req.query.cwd ?? config.piCwd);
	const sessions = listPiSessions(cwd);
	res.json({ sessions });
});

/**
 * GET /api/projects
 * Returns the list of projects (metadata only — instructions live in
 * each project's AGENTS.md, fetched separately). The sidebar uses the WS
 * `projects` push instead, but this endpoint is handy for tooling.
 */
app.get("/api/projects", (_req, res) => {
	res.json({ projects: listProjects() });
});

/**
 * GET /api/projects/:id/instructions
 * Returns the project's AGENTS.md text (empty string if absent). Used by
 * the project editor modal to pre-fill the instructions textarea.
 */
app.get("/api/projects/:id/instructions", (req, res) => {
	const text = readProjectInstructions(req.params.id);
	res.json({ text });
});

/**
 * GET /api/sessions/search?q=<free-text memory>&cwd=<path>&limit=<n>
 *
 * Semantic search across the indexed session transcripts. The user types a
 * memory in their own words ("I moved MavalETH from server 3 to server 2")
 * and this returns the messages whose meaning is closest, regardless of
 * exact wording.
 *
 * This feature is OPTIONAL and pluggable: it only exists when the operator
 * has installed the optional packages (`better-sqlite3`,
 * `@huggingface/transformers`) and set `AGENTCHATBOX_SEARCH_ENABLED=1`.
 * When off, this endpoint returns 404 and `/api/health` advertises
 * `search: false` so the sidebar hides the search box. See
 * `src/server/search/`.
 */
app.get("/api/sessions/search", async (req, res) => {
	// Non-literal specifier: keeps the search module fully removable. TypeScript
	// won't try to resolve this import, so deleting `src/server/search/` leaves
	// the core server compiling cleanly (the runtime throw is caught below).
	const searchPath = "./search/index.js";
	const loaded = (await import(searchPath)) as {
		isSearchAvailable: () => Promise<boolean>;
		searchSessions: (q: string, opts?: { cwd?: string; limit?: number }) => Promise<unknown[]>;
	};
	try {
		if (!(await loaded.isSearchAvailable())) {
			res.status(404).json({ error: "search not enabled on this server" });
			return;
		}
	} catch {
		res.status(404).json({ error: "search not enabled on this server" });
		return;
	}
	const q = String(req.query.q ?? "").trim();
	if (!q) {
		res.json({ results: [] });
		return;
	}
	const cwd = String(req.query.cwd ?? config.piCwd);
	const limitRaw = Number.parseInt(String(req.query.limit ?? "10"), 10);
	const limit = Number.isFinite(limitRaw) ? limitRaw : 10;
	const results = await loaded.searchSessions(q, { cwd, limit });
	res.json({ results });
});

/**
 * GET /api/sessions/:id
 *
 * Returns the full message transcript for a session. The browser
 * typically doesn't need this (the WS server replays the transcript
 * on resume), but it's useful for the `/export` slash command and
 * for any future "open a session read-only" UI.
 *
 * Shape: { id, cwd, createdAt, messages: Array<UserMessage|AssistantMessage|ToolResultMessage> }
 */
app.get("/api/sessions/:id", (req, res) => {
	const cwd = String(req.query.cwd ?? config.piCwd);
	const id = req.params.id;
	const all = listPiSessions(cwd);
	const meta = all.find((s) => s.id === id);
	if (!meta) {
		res.status(404).json({ error: `session ${id} not found for cwd ${cwd}` });
		return;
	}
	const messages = readPiSessionMessages(cwd, id);
	res.json({
		id: meta.id,
		cwd: meta.cwd,
		createdAt: meta.createdAt,
		messages,
	});
});

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
	// Semantic session search is an optional, pluggable feature. Probe it the
	// same way we probe Whisper/TTS so the UI can show/hide the search box.
	let search = false;
	try {
		// Non-literal specifier: keeps the search module fully removable (see
		// /api/sessions/search handler for the same rationale).
		const searchPath = "./search/index.js";
		const loaded = (await import(searchPath)) as { isSearchAvailable: () => Promise<boolean> };
		search = await loaded.isSearchAvailable();
	} catch {
		search = false;
	}
	res.json({
		status: "ok",
		commit: COMMIT_HASH,
		providers: Object.keys(config.apiKeys).filter((k) => config.apiKeys[k]),
		whisper: whisper.available,
		whisperReason: whisper.available ? undefined : whisper.reason,
		tts: tts.available,
		ttsEngine: tts.engine,
		ttsReason: tts.available ? undefined : tts.reason,
		ttsVoice: tts.voice,
		search,
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
 */
app.get("/api/models", (_req, res) => {
	const out: Array<{
		id: string;
		provider: string;
		name: string;
		reasoning: boolean;
	}> = [];

	for (const provider of SDK_PROVIDERS) {
		if (!config.apiKeys[provider]) continue;
		try {
			const models = getModels(provider);
			for (const m of models) {
				out.push({
					id: m.id,
					provider,
					name: m.name,
					reasoning: !!m.reasoning,
				});
			}
		} catch (e) {
			// If the SDK doesn't know this provider, skip it rather than
			// 500ing the whole endpoint.
			log.warn("failed to list models for provider", {
				provider,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// Models not in the SDK registry (custom provider, or newer than the
	// generated list). See providers.ts::EXTRA_MODELS — gated on each
	// entry's provider having a configured key.
	for (const m of EXTRA_MODELS) {
		if (!config.apiKeys[m.provider]) continue;
		out.push({
			id: m.id,
			provider: m.provider,
			name: m.name,
			reasoning: m.reasoning,
		});
	}

	res.json({ models: out });
});

/**
 * GET /api/image-models
 *
 * Returns the list of image-generation models the client can pick from.
 * Separate from `/api/models` because image models aren't callable via
 * pi's chat-completions endpoint — they belong to the `venice_generate_image`
 * tool registered by the pi-venice-image extension, and live in the
 * picker's "Venice images" group (or similar) rather than the chat-model
 * section.
 *
 * Shape: { models: Array<{ id, provider, name, tags }> }
 *
 * Gating: each entry is only emitted if the entry's `provider` has a
 * configured API key on this server — same policy as `/api/models`.
 */
app.get("/api/image-models", (_req, res) => {
	const out: Array<{
		id: string;
		provider: string;
		name: string;
		tags: readonly string[];
	}> = [];
	for (const m of EXTRA_IMAGE_MODELS) {
		if (!config.apiKeys[m.provider]) continue;
		out.push({ id: m.id, provider: m.provider, name: m.name, tags: m.tags });
	}
	res.json({ models: out });
});

/**
 * GET /api/capabilities
 *
 * Returns the tools, skills, and extensions that pi has loaded.
 * Runs `pi list`, parses each installed package's package.json,
 * and extracts registered tool names and skill directories.
 *
 * Shape: { packages: [...], tools: [...], skills: [...] }
 */
app.get("/api/capabilities", async (_req, res) => {
	try {
		const caps = await getCapabilities();
		res.json(caps);
	} catch (e) {
		log.error("capabilities fetch failed", {
			error: e instanceof Error ? e.message : String(e),
		});
		res.json({ packages: [], tools: [], skills: [] });
	}
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
	log.info("agentchatbox listening", {
		url: `http://${config.host}:${config.port}`,
		commit: COMMIT_HASH,
		uploadsDir: config.uploadsDir,
		providers: providers.length ? providers : [],
		piBin: config.piBin,
		piCwd: config.piCwd,
	});

	// Warm the Whisper + TTS health caches in the background. The first
	// /api/health call would otherwise block for seconds (faster-whisper
	// model load / piper voice init); pre-running the probes at boot means
	// the browser's first poll returns instantly from cache. Fire-and-forget
	// — failure here just means the cache fills lazily on first request.
	void checkWhisperAvailable().then((w) =>
		log.info("whisper probe ready", { available: w.available, reason: w.reason }),
	);
	void checkTtsAvailable().then((t) =>
		log.info("tts probe ready", { available: t.available, voice: t.voice, reason: t.reason }),
	);
});

// WebSocket endpoint. Mounted on the same HTTP server so we don't need a
// second port.
mountChatWs(server);

// On server shutdown, SIGTERM every live `pi --mode rpc` child so each
// gets a chance to flush its session JSONL before the process dies.
// The `pi` process appends to its session file on every event, so a
// fast SIGKILL would lose the last few events of an active session.
process.on("SIGTERM", () => {
	log.info("SIGTERM received, shutting down");
	// SIGTERM every live `pi --mode rpc` child FIRST so each gets the
	// full shutdown window to flush its session JSONL before we exit.
	// (PiProcess.kill escalates to SIGKILL after 2s.) The chat WS layer
	// owns the child lifecycle; this is the single place it's wired into
	// the process signal — chat.ts no longer registers its own listener.
	shutdownChatWs();
	server.close(() => {
		process.exit(0);
	});
	// Failsafe: if the server.close() callback never fires (e.g. a
	// stuck keep-alive connection), force-exit after 3 seconds.
	setTimeout(() => {
		log.warn("server.close timed out, forcing exit");
		process.exit(1);
	}, 3000).unref();
});
