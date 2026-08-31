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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { asyncHandler } from "./async-handler.js";
import { mountChatWs, shutdownChatWs } from "./chat.js";
import { config, readPiAuth } from "./config.js";
import { createFilesRouter } from "./files.js";
import { jsonErrorHandler } from "./json-error.js";
import { log } from "./logger.js";
import { modelsCache } from "./models-cache.js";
import { projectRoot } from "./paths.js";
import { listProjects, readProjectInstructions } from "./projects.js";
import { securityHeaders } from "./security.js";
import {
	findPiSessionFile,
	findSessionCwd,
	listPiSessions,
	readPiSessionMessages,
} from "./session-list.js";
import { registry } from "./session-registry.js";
import { staticCacheControl } from "./static-cache.js";
import { checkWhisperAvailable, createTranscribeRouter } from "./transcribe.js";
import { checkTtsAvailable, createTtsRouter } from "./tts.js";
import { uploadStore } from "./upload-store.js";
import { createUploadsRouter } from "./uploads.js";
import { createUploadsServingRouter } from "./uploads-serving.js";

mkdirSync(config.uploadsDir, { recursive: true, mode: 0o700 });

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders);
// Deliberately no CORS middleware: every browser API is same-origin. Omitting
// ACAO is the fail-closed policy for credentialed cross-origin requests.
app.use(express.json({ limit: "2mb", strict: true }));

// Lightweight access log so we can see what the browser is actually doing.
app.use((req, _res, next) => {
	if (req.url.startsWith("/api/")) {
		log.info("http request", {
			method: req.method,
			// Never log query strings: /api/file paths and semantic-search text
			// can contain private filenames or conversation content.
			path: req.path,
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
 * GET /api/agent-status
 *
 * Local read-only lifecycle snapshot for Mavali Shed. This is a transport
 * projection of pi children already owned by the session registry; it does
 * not interpret prompts or run agent logic.
 */
app.get("/api/agent-status", (_req, res) => {
	res.json({ sessions: registry.statusSnapshot() });
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
app.get(
	"/api/sessions/search",
	asyncHandler(async (req, res) => {
		// Non-literal specifier: keeps the search module fully removable. TypeScript
		// won't try to resolve this import, so deleting `src/server/search/` leaves
		// the core server compiling cleanly. The import AND the search call are
		// try-guarded because the module is OPTIONAL and pluggable: a
		// better-sqlite3 native-load failure or an ONNX init error must degrade to
		// 404/500, not hang the request. Express 4 does NOT auto-catch rejected
		// promises in async route handlers, so an unguarded `await` here would
		// leak a hung response + an unhandled-rejection warning.
		const searchPath = "./search/index.js";
		let loaded: {
			isSearchAvailable: () => Promise<boolean>;
			searchSessions: (q: string, opts?: { cwd?: string; limit?: number }) => Promise<unknown[]>;
		};
		try {
			loaded = (await import(searchPath)) as typeof loaded;
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
		try {
			const results = await loaded.searchSessions(q, { cwd, limit });
			res.json({ results });
		} catch (e) {
			log.error("session search failed", {
				error: e instanceof Error ? e.message : String(e),
			});
			res.status(500).json({ error: "search failed" });
		}
	}),
);

/**
 * HEAD /api/sessions/:id — cheap existence probe for shareable links.
 *
 * Express otherwise implements HEAD by executing the GET handler and merely
 * suppressing its body. That still parsed an image-heavy 150 MiB transcript
 * before the browser could open its WebSocket. Resolve only the session header
 * here; the subsequent pi resume owns the actual transcript load.
 */
app.head("/api/sessions/:id", (req, res) => {
	const id = req.params.id;
	const cwd = req.query.cwd
		? String(req.query.cwd)
		: findSessionCwd(
				id,
				listProjects().map((project) => project.cwd),
			);
	if (!cwd || !findPiSessionFile(cwd, id)) {
		res.status(404).end();
		return;
	}
	res.status(204).end();
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
	const id = req.params.id;
	// An explicit ?cwd= is a STRICT per-cwd lookup (e.g. a future tool
	// scoping a query to one project). When omitted, resolve the cwd across
	// ALL known project folders + orphaned
	// session dirs, exactly like the WS resume path (chat.ts
	// resolveInitCwd / resumeSession). Without this, a refresh of a
	// PROJECT chat 404s here: the session lives under the project's cwd,
	// not the global one, so the client treats the link as stale and
	// dumps the user into a brand-new global chat instead of resuming.
	const cwd = req.query.cwd
		? String(req.query.cwd)
		: (findSessionCwd(
				id,
				listProjects().map((p) => p.cwd),
			) ?? config.piCwd);
	const all = listPiSessions(cwd);
	const meta = all.find((s) => s.id === id);
	if (!meta) {
		res.status(404).json({ error: "session not found" });
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
				log.error("git log failed", { error: err.message });
				res.status(500).json({ error: "git log failed" });
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

/**
 * Resolve the image-generation model the pi-venice-image extension would
 * use for a default (no-param) call, mirroring its resolution chain:
 * override file → VENICE_IMAGE_MODEL env → "z-image-turbo". Read-only —
 * ACB never writes the override (the extension's /imagemodel command does).
 * Used by /api/health so the Models & services panel can show the truth
 * before any extension notify lands.
 */
function readImageModel(): { model: string; source: "override" | "env" | "default" } {
	const overrideFile = join(process.env.HOME ?? homedir(), ".config", "acb", "image-model");
	try {
		if (existsSync(overrideFile)) {
			const id = readFileSync(overrideFile, "utf8").split(/\r?\n/)[0]?.trim();
			if (id) return { model: id, source: "override" };
		}
	} catch {
		/* unreadable — fall through */
	}
	const envModel = process.env.VENICE_IMAGE_MODEL?.trim();
	if (envModel) return { model: envModel, source: "env" };
	return { model: "z-image-turbo", source: "default" };
}

/**
 * Resolve the vision (image/video analysis) model the pi-multimodal-proxy
 * extension would use, mirroring its resolution chain (the parts ACB can
 * see without running inside a pi session):
 *   PI_VISION_PROXY_MODEL env ("provider/model-id") → overrides all
 *   ~/.pi/agent/multimodal-proxy.json {provider, modelId} → the saved pick
 *   default anthropic/claude-sonnet-4-5 (the extension's DEFAULT_CONFIG)
 * Also reports `mode` ("fallback" | "always" | "off") from the same chain
 * — fallback = only routes to the vision model when the chat model lacks
 * image support. Read-only; the extension's /multimodal-proxy command
 * owns the persisted file and any mutations.
 */
function readVisionModel(): {
	model: string;
	source: "env" | "config" | "default";
	mode: "fallback" | "always" | "off";
} {
	// Default per pi-multimodal-proxy DEFAULT_CONFIG.
	let model = "anthropic/claude-sonnet-4-5";
	let source: "env" | "config" | "default" = "default";
	let mode: "fallback" | "always" | "off" = "fallback";
	// 1. Persistent config file.
	const cfgFile = join(homedir(), ".pi", "agent", "multimodal-proxy.json");
	try {
		if (existsSync(cfgFile)) {
			const cfg = JSON.parse(readFileSync(cfgFile, "utf8")) as {
				provider?: string;
				modelId?: string;
				mode?: string;
			};
			if (cfg.provider && cfg.modelId) {
				model = `${cfg.provider}/${cfg.modelId}`;
				source = "config";
			}
			if (cfg.mode === "fallback" || cfg.mode === "always" || cfg.mode === "off") {
				mode = cfg.mode;
			}
		}
	} catch {
		/* unreadable/invalid — keep defaults */
	}
	// 2. Env overrides everything (matches the extension's resolveConfig).
	const envModel = process.env.PI_VISION_PROXY_MODEL?.trim();
	if (envModel) {
		model = envModel;
		source = "env";
	}
	const envMode = process.env.PI_VISION_PROXY_MODE?.trim().toLowerCase();
	if (envMode === "fallback" || envMode === "always" || envMode === "off") {
		mode = envMode;
	}
	return { model, source, mode };
}

// Health check. Reports configured provider keys, local Whisper, local TTS,
// and the running commit hash (so an operator can verify the live process
// is on the expected tree). Cross-check against
// `git -C /home/lepton/agentchatbox rev-parse HEAD` on the host.
app.get(
	"/api/health",
	asyncHandler(async (_req, res) => {
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
			providers: [...readPiAuth().keys()],
			whisper: whisper.available,
			whisperReason: whisper.available ? undefined : whisper.reason,
			// Whisper model id in use. faster-whisper's script default is "medium"
			// (see scripts/transcribe.py); WHISPER_MODEL env overrides it. Surfaced
			// for the Models & services panel — display only, not a secret.
			whisperModel: process.env.WHISPER_MODEL?.trim() || "medium",
			tts: tts.available,
			ttsEngine: tts.engine,
			ttsReason: tts.available ? undefined : tts.reason,
			ttsVoice: tts.voice,
			// Configured spoken-rewrite model override (pi-voice-reply extension).
			// Surfaced so the browser banner can name the model actually generating
			// the spoken text instead of the (often different) session model. Raw
			// "provider/modelId" string; undefined when the rewrite falls back to
			// the session model. Read from env — not a secret, just a model id.
			voiceRewriteModel: process.env.VOICE_REWRITE_MODEL?.trim() || undefined,
			// Resolved image-generation model (pi-venice-image extension). The
			// extension resolves per call: explicit param → ~/.config/acb/image-model
			// override → $VENICE_IMAGE_MODEL → "z-image-turbo". We mirror that chain
			// here for display so the panel shows what a default call would use
			// before any extension notify lands. Read-only — the extension still
			// owns the override file and persistence.
			imageModel: readImageModel(),
			// Resolved vision (image/video analysis) model + mode, mirroring the
			// pi-multimodal-proxy chain: PI_VISION_PROXY_MODEL env →
			// ~/.pi/agent/multimodal-proxy.json → default anthropic/claude-sonnet-4-5.
			// `mode` is "fallback" (routes only when chat model lacks image support),
			// "always", or "off". Read-only — the extension owns mutations.
			visionModel: readVisionModel(),
			// Whether the Gemini key is configured for pi-web-access (web search /
			// fetch / YouTube transcripts). The model itself is implicit inside the
			// extension, so we only report key presence — boolean, not a secret.
			geminiKey: !!process.env.GEMINI_API_KEY,
			search,
			uploads: uploadStore.usage(),
			sessions: registry.stats(),
		});
	}),
);

/**
 * GET /api/models
 *
 * Returns the list of LLM models the client can pick from, one entry per
 * (provider, modelId). Only providers with a configured API key are
 * included.
 *
 * Shape: { models: Array<{ id, provider, name, reasoning, thinkingLevels }> }
 *   - id:             the model id (what /api/chat's setModel expects)
 *   - provider:       the provider key (e.g. "deepseek", "minimax")
 *   - name:           human-readable label
 *   - reasoning:      true if the model supports thinking
 *   - thinkingLevels: exact levels derived from pi's model metadata
 *
 * Source: pi's `get_available_models`, cached at boot (see
 * models-cache.ts). Per AGENTS.md, ACB is a transport shell, so the
 * picker is a pure mirror of what pi knows — SDK built-ins plus
 * whatever the user has declared in ~/.pi/agent/models.json. There is
 * no ACB-side model list. To add a model: put it in models.json. To
 * retire one: delete it from there.
 *
 * Cold start: the boot probe runs in the background. If a request
 * arrives before the probe completes, we synchronously wait for the
 * probe to finish (with a 5s timeout) so the picker is populated
 * immediately. If the probe fails (no API key, pi crash, etc.) the
 * picker is empty — fix the underlying issue, restart.
 */
app.get(
	"/api/models",
	asyncHandler(async (_req, res) => {
		// Kick off / await the boot probe so the very first /api/models
		// request on a cold start doesn't return an empty list. After the
		// first successful probe, this is a no-op (the cache is populated).
		if (modelsCache.get().length === 0) {
			await modelsCache.ensureReady();
		}

		const out: Array<{
			id: string;
			provider: string;
			name: string;
			reasoning: boolean;
			thinkingLevels: import("../shared/thinking.js").ThinkingLevel[];
		}> = [];

		// Mirror pi's response, gated on the provider being authenticated in
		// pi's auth.json (the single source of truth — see config.ts). Reading
		// auth.json live means a `pi auth logout` removes a provider from the
		// picker on the next request, with no ACB restart. (The model LIST is
		// still boot-cached — logging into a brand-new provider still needs a
		// restart for its models to enter the cache.)
		const authed = readPiAuth();
		for (const m of modelsCache.get()) {
			if (!authed.has(m.provider)) continue;
			out.push({
				id: m.id,
				provider: m.provider,
				name: m.name,
				reasoning: m.reasoning,
				thinkingLevels: m.thinkingLevels,
			});
		}

		res.json({ models: out });
	}),
);

// Static files (built client). Resolved against the project root so the
// server works regardless of the process working directory.
const publicDir = resolve(projectRoot, "public");
if (existsSync(publicDir)) {
	// Cache headers: the HTML document must NEVER be cached, while hashed
	// asset URLs (app.js?v=…, styles.css?v=…) are safe to cache forever.
	// index.html references those cache-busted asset URLs, which change
	// every deploy — if a browser serves a stale index.html it pins itself
	// to stale asset URLs and never sees updates (the "I refreshed but my
	// change didn't show up" bug). no-store on HTML forces every navigation
	// to re-fetch the document, which always points at the current assets.
	app.use(
		express.static(publicDir, {
			setHeaders: (res, path) => {
				const requestUrl = (res as typeof res & { req?: { url?: string } }).req?.url ?? "";
				res.setHeader("Cache-Control", staticCacheControl(path, requestUrl));
			},
		}),
	);
	// Uploaded active content is never handled by express.static. The
	// dedicated route verifies a regular no-follow file descriptor, permits
	// inline display only for magic-validated raster images, and forces every
	// other format (HTML/SVG/PDF/etc.) to download as an octet-stream.
	app.use("/uploads", createUploadsServingRouter());
	// SPA fallback: serve index.html for any non-API GET. Same no-store
	// header as above so the fallback document is never cached either.
	app.get(/^(?!\/api\/|\/uploads\/).*/, (_req, res) => {
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
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

// JSON error handler — mounted LAST (see json-error.ts). Catches any error
// forwarded via next(err) by a route/middleware above and returns the same
// `{ error }` JSON shape every other path returns, instead of Express's
// default HTML page.
app.use(jsonErrorHandler);

const server = app.listen(config.port, config.host, () => {
	const providers = [...readPiAuth().keys()];
	const uploadUsage = uploadStore.usage();
	log.info("agentchatbox listening", {
		url: `http://${config.host}:${config.port}`,
		commit: COMMIT_HASH,
		uploadsDir: config.uploadsDir,
		uploadBytes: uploadUsage.bytes,
		uploadQuotaBytes: uploadUsage.quotaBytes,
		providers: providers.length ? providers : [],
		piBin: config.piBin,
		piCwd: config.piCwd,
	});
	if (uploadUsage.warning) {
		log.warn("upload storage is above the warning threshold", { ...uploadUsage });
	}

	// Warm the Whisper + TTS health caches in the background. The first
	// /api/health call would otherwise block for seconds (faster-whisper
	// model load); pre-running the probes at boot means
	// the browser's first poll returns instantly from cache. Fire-and-forget
	// — failure here just means the cache fills lazily on first request.
	void checkWhisperAvailable().then((w) =>
		log.info("whisper probe ready", { available: w.available, reason: w.reason }),
	);
	void checkTtsAvailable().then((t) =>
		log.info("tts probe ready", { available: t.available, voice: t.voice, reason: t.reason }),
	);
	// Populate the models cache (see models-cache.ts) at boot. The
	// probe spawns a one-shot `pi --mode rpc` child and asks for
	// `get_available_models` — the authoritative list of what the
	// picker should show. /api/models awaits `ensureReady()` on the
	// first request, so even if the boot probe is still in flight
	// when the browser's first /api/models arrives, the picker
	// populates immediately (up to a 5s timeout). Failure here
	// means /api/models returns an empty list until the next probe
	// succeeds — check the boot log for the reason.
	void modelsCache.ensureReady();
});

server.maxHeadersCount = 100;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

// WebSocket endpoint. Mounted on the same HTTP server so we don't need a
// second port.
mountChatWs(server);

let shuttingDown = false;
function shutdown(reason: string, exitCode: number): void {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info("shutting down", { reason, exitCode });
	shutdownChatWs();
	server.close(() => process.exit(exitCode));
	setTimeout(() => {
		log.warn("server.close timed out, forcing exit");
		process.exit(exitCode);
	}, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));

// Unknown uncaught failures may leave session ownership inconsistent. Exit
// cleanly and let systemd restart instead of continuing in an unknown state.
process.once("uncaughtException", (err) => {
	log.error("uncaughtException", { error: err.message, stack: err.stack });
	shutdown("uncaughtException", 1);
});
process.once("unhandledRejection", (reason) => {
	const message = reason instanceof Error ? reason.message : String(reason);
	log.error("unhandledRejection", { error: message });
	shutdown("unhandledRejection", 1);
});
