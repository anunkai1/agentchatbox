/**
 * Server configuration. All values come from environment variables.
 *
 * Copy `.env.example` to `.env` and fill in the keys you want to use.
 * Only the providers you have keys for are exposed to the client.
 *
 * The `dotenv/config` side-effect import is intentionally NOT here — it
 * lives at the top of `index.ts` so the env is loaded before any other
 * module reads process.env. config.ts itself is a plain data file.
 *
 * `uploadsDir` defaults to `<projectRoot>/uploads` (not `./uploads`),
 * so the upload location doesn't drift if the process is started from
 * a different cwd (systemd, container init, supervisor, etc.). The
 * `projectRoot` helper derives the path from this file's location, not
 * from process.cwd() — see paths.ts.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { projectRoot } from "./paths.js";

export interface ServerConfig {
	port: number;
	host: string;
	/** Folder for uploaded files. Created on boot. */
	uploadsDir: string;
	/** Max size of one upload in bytes. Default 2 GiB. */
	maxUploadBytes: number;
	/** Hard aggregate quota for completed uploads. Default 20 GiB. */
	maxUploadStorageBytes: number;
	/** Exact browser origins allowed to open the chat WebSocket. */
	allowedOrigins: ReadonlySet<string>;
	/** Whether non-browser WebSocket clients may omit Origin. */
	allowMissingWsOrigin: boolean;
	/** Bounds authenticated browser connections and live pi children. */
	maxWsConnections: number;
	maxLiveSessions: number;
	/** Maximum inbound WebSocket frame size. */
	wsMaxPayloadBytes: number;
	/** Maximum time for a cold/resumed pi child to answer get_state. */
	piReadyTimeoutMs: number;
	/** OpenAI key, used for Whisper transcription of voice notes. */
	openaiApiKey: string | undefined;
	/**
	 * Path to the `pi` CLI binary. Default "pi" (resolved via $PATH).
	 * Overridable via PI_BIN for tests (point at a fake-pi.sh fixture).
	 */
	piBin: string;
	/**
	 * Working directory the server passes to `pi --mode rpc` as the
	 * project root. Sessions are scoped to this cwd by `pi` itself
	 * (under `~/.pi/agent/sessions/--<cwd>--/`).
	 * Default: process.cwd() at server boot.
	 * Overridable via PI_CWD.
	 */
	piCwd: string;
	/**
	 * Explicit operator trust anchors for independently owned project repos.
	 * These projects may run pi from their exact canonical cwd but ACB never
	 * owns or recursively deletes their directories.
	 */
	trustedExternalProjects: ReadonlyMap<string, string>;
}

function readKey(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim().length > 0 ? v.trim() : undefined;
}

function positiveInt(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
	const raw = process.env[name];
	const value = raw === undefined ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
	}
	return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	if (["1", "true", "yes"].includes(raw)) return true;
	if (["0", "false", "no"].includes(raw)) return false;
	throw new Error(`${name} must be one of: 1, 0, true, false, yes, no`);
}

const EXTERNAL_PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Parse `id:/absolute/path,id2:/absolute/path2` trust anchors. Unlike the
 * mutable projects sidecar, this operator-controlled setting authorises exact
 * external repositories. Paths must already exist, be canonical directories,
 * and sit outside both Global and ACB's managed `.projects/` tree.
 */
export function parseTrustedExternalProjects(
	raw: string | undefined,
	piCwd: string,
): ReadonlyMap<string, string> {
	const projects = new Map<string, string>();
	const usedPaths = new Set<string>();
	if (!raw?.trim()) return projects;
	const managedRoot = resolve(piCwd, ".projects");
	for (const item of raw.split(",")) {
		const entry = item.trim();
		if (!entry) continue;
		const separator = entry.indexOf(":");
		if (separator < 1) throw new Error(`invalid trusted external project entry: ${entry}`);
		const id = entry.slice(0, separator).trim();
		const configuredPath = entry.slice(separator + 1).trim();
		if (!EXTERNAL_PROJECT_ID_RE.test(id) || id === "global") {
			throw new Error(`invalid trusted external project id: ${id}`);
		}
		if (!isAbsolute(configuredPath)) {
			throw new Error(`trusted external project ${id} must use an absolute path`);
		}
		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(configuredPath);
		} catch {
			throw new Error(`trusted external project ${id} does not exist or cannot be resolved`);
		}
		if (resolve(configuredPath) !== canonicalPath || !statSync(canonicalPath).isDirectory()) {
			throw new Error(`trusted external project ${id} must name a canonical directory`);
		}
		const managedRelative = relative(managedRoot, canonicalPath);
		if (
			canonicalPath === resolve(piCwd) ||
			managedRelative === "" ||
			(!managedRelative.startsWith("..") && !isAbsolute(managedRelative))
		) {
			throw new Error(`trusted external project ${id} must be outside Global and .projects`);
		}
		if (projects.has(id)) throw new Error(`duplicate trusted external project id: ${id}`);
		if (usedPaths.has(canonicalPath)) {
			throw new Error(`duplicate trusted external project path: ${canonicalPath}`);
		}
		projects.set(id, canonicalPath);
		usedPaths.add(canonicalPath);
	}
	return projects;
}

function allowedOrigins(): ReadonlySet<string> {
	const configured = process.env.AGENTCHATBOX_ALLOWED_ORIGINS?.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (configured && configured.length > 0) {
		for (const origin of configured) {
			const parsed = new URL(origin);
			if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
				throw new Error(`invalid origin in AGENTCHATBOX_ALLOWED_ORIGINS: ${origin}`);
			}
		}
		return new Set(configured);
	}
	const port = positiveInt("PORT", 3000, 65_535);
	return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

const piCwd = resolve(process.env.PI_CWD ?? process.cwd());
const maxUploadBytes = positiveInt("MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024);
const maxUploadStorageBytes = positiveInt(
	"AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES",
	20 * 1024 * 1024 * 1024,
);
if (maxUploadStorageBytes < maxUploadBytes) {
	throw new Error("AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES must be at least MAX_UPLOAD_BYTES");
}

export const config: ServerConfig = {
	port: positiveInt("PORT", 3000, 65_535),
	host: process.env.HOST ?? "127.0.0.1",
	uploadsDir: process.env.UPLOADS_DIR
		? resolve(process.env.UPLOADS_DIR)
		: resolve(projectRoot, "uploads"),
	maxUploadBytes,
	maxUploadStorageBytes,
	allowedOrigins: allowedOrigins(),
	allowMissingWsOrigin: booleanEnv(
		"AGENTCHATBOX_ALLOW_MISSING_WS_ORIGIN",
		process.env.NODE_ENV !== "production",
	),
	maxWsConnections: positiveInt("AGENTCHATBOX_MAX_WS_CONNECTIONS", 16, 256),
	maxLiveSessions: positiveInt("AGENTCHATBOX_MAX_LIVE_SESSIONS", 8, 64),
	wsMaxPayloadBytes: positiveInt(
		"AGENTCHATBOX_WS_MAX_PAYLOAD_BYTES",
		40 * 1024 * 1024,
		64 * 1024 * 1024,
	),
	piReadyTimeoutMs: positiveInt("AGENTCHATBOX_PI_READY_TIMEOUT_MS", 30_000, 120_000),
	openaiApiKey: readKey("OPENAI_API_KEY"),
	// `piBin` and `piCwd` are read lazily — they need to reflect the
	// process state at boot time, not at module-load time (which could
	// be any time the module is imported, e.g. during a test). A
	// getter on the config object would be ideal but a frozen literal
	// is what the rest of the file uses; resolve them here.
	piBin: process.env.PI_BIN ?? "pi",
	piCwd,
	trustedExternalProjects: parseTrustedExternalProjects(
		process.env.AGENTCHATBOX_TRUSTED_EXTERNAL_PROJECTS,
		piCwd,
	),
};

/**
 * pi's auth store — the single source of truth for which LLM providers
 * the user has authenticated (via `pi auth login`/`logout`). ACB reads it
 * for BOTH the model-picker gate and the spawn gate (refuse to spawn a
 * `pi` child for a provider with no key), so logging a provider in or out
 * of `pi` automatically adds or removes it in ACB on the next request —
 * no ACB restart, and no second key store to keep in sync (the drift
 * bug that motivated this: `providers.env` had keys for providers the
 * user had logged out of, so the picker kept showing them).
 *
 * The key is NOT injected into the spawned `pi` child — `pi` reads it
 * from auth.json itself (see pi-process.ts). ACB only checks presence
 * here to decide whether spawning is allowed.
 *
 * `~/.pi/agent/auth.json` is a symlink to `.secrets/llm/pi-auth.json`.
 * Read fresh each call (the file is tiny and `pi` rewrites it on every
 * login/logout). Returns provider id → an authentication-presence value:
 * the API key for key-backed providers, or the non-secret "oauth" sentinel
 * for OAuth providers. An empty map if the file is missing/unreadable/malformed
 * (picker stays empty — fix by logging in via `pi`).
 */
// Overridable via AGENTCHATBOX_PI_AUTH_FILE so tests can point at a temp
// file instead of the operator's real ~/.pi/agent/auth.json (keeps the
// suite hermetic — previously the tests silently depended on the real
// auth.json having the provider they spawn with).
export const PI_AUTH_PATH = process.env.AGENTCHATBOX_PI_AUTH_FILE
	? resolve(process.env.AGENTCHATBOX_PI_AUTH_FILE)
	: join(homedir(), ".pi", "agent", "auth.json");

export function readPiAuth(): Map<string, string> {
	const out = new Map<string, string>();
	try {
		const obj = JSON.parse(readFileSync(PI_AUTH_PATH, "utf8")) as Record<
			string,
			{ type?: unknown; key?: unknown; access?: unknown }
		>;
		for (const [provider, entry] of Object.entries(obj)) {
			// Two credential shapes live in auth.json:
			//   - { type: "api_key", key: "sk-..." }   (env-key providers)
			//   - { type: "oauth", access, refresh, expires, accountId }
			//                                          (ChatGPT Plus/Pro login,
			//                                           e.g. openai-codex)
			// Both mean "authenticated" for picker/spawn-gate purposes. The
			// value returned is NEVER passed to the pi child — pi reads
			// auth.json itself (see pi-process.ts header) — so for OAuth we
			// return a non-empty sentinel rather than the (rotating) access
			// token. The sentinel just needs to be truthy to pass the spawn
			// gate in session-registry.ts and the picker gate in index.ts.
			const type = entry?.type;
			const key = typeof entry?.key === "string" ? entry.key.trim() : "";
			const access = typeof entry?.access === "string" ? entry.access.trim() : "";
			if (type === "oauth" && access.length > 0) {
				out.set(provider.toLowerCase(), "oauth");
			} else if (key.length > 0) {
				out.set(provider.toLowerCase(), key);
			}
		}
	} catch {
		// Missing/unreadable/malformed — treat as "logged out of everything".
	}
	return out;
}

/**
 * Returns the API key for a provider, sourced from `pi`'s auth.json. Used
 * only to gate the picker (presence of a key) and to gate spawning
 * (refuse to spawn a `pi` child for a provider with no key). The key is
 * NOT injected into the child — `pi` reads it from auth.json itself (see
 * pi-process.ts). Not sourced from `providers.env` — that file is
 * now transport-only (env vars for non-chat tools: VENICE_API_KEY for the
 * pi-venice-image extension, GEMINI_API_KEY for YouTube transcripts).
 */
export function getServerApiKey(provider: string): string | undefined {
	return readPiAuth().get(provider.toLowerCase());
}
