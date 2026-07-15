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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { projectRoot } from "./paths.js";

export interface ServerConfig {
	port: number;
	host: string;
	/** Folder for uploaded files. Created on boot. */
	uploadsDir: string;
	/** Max upload size in bytes. Default 50 MB. */
	maxUploadBytes: number;
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
}

function readKey(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim().length > 0 ? v.trim() : undefined;
}

export const config: ServerConfig = {
	port: Number.parseInt(process.env.PORT ?? "3000", 10),
	host: process.env.HOST ?? "0.0.0.0",
	uploadsDir: process.env.UPLOADS_DIR
		? resolve(process.env.UPLOADS_DIR)
		: resolve(projectRoot, "uploads"),
	maxUploadBytes: Number.parseInt(process.env.MAX_UPLOAD_BYTES ?? `${50 * 1024 * 1024}`, 10),
	openaiApiKey: readKey("OPENAI_API_KEY"),
	// `piBin` and `piCwd` are read lazily — they need to reflect the
	// process state at boot time, not at module-load time (which could
	// be any time the module is imported, e.g. during a test). A
	// getter on the config object would be ideal but a frozen literal
	// is what the rest of the file uses; resolve them here.
	piBin: process.env.PI_BIN ?? "pi",
	piCwd: process.env.PI_CWD ?? process.cwd(),
};

/**
 * pi's auth store — the single source of truth for which LLM providers
 * the user has authenticated (via `pi auth login`/`logout`). ACB reads it
 * for BOTH the model-picker gate and the key injected into spawned `pi`
 * children, so logging a provider in or out of `pi` automatically adds or
 * removes it in ACB on the next request — no ACB restart, and no second
 * key store to keep in sync (the drift bug that motivated this:
 * `providers.env` had keys for providers the user had logged out of, so
 * the picker kept showing them).
 *
 * `~/.pi/agent/auth.json` is a symlink to `.secrets/llm/pi-auth.json`.
 * Read fresh each call (the file is tiny and `pi` rewrites it on every
 * login/logout). Returns provider id → API key; an empty map if the file
 * is missing/unreadable/malformed (picker stays empty — fix by logging
 * in via `pi`).
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
			{ key?: unknown }
		>;
		for (const [provider, entry] of Object.entries(obj)) {
			// Trim — API keys never carry intentional whitespace, and the
			// env-key reader (readKey) already trims. Keeps a stray
			// padded/blank entry from masquerading as a configured key.
			const key = entry && typeof entry.key === "string" ? entry.key.trim() : "";
			if (key.length > 0) out.set(provider.toLowerCase(), key);
		}
	} catch {
		// Missing/unreadable/malformed — treat as "logged out of everything".
	}
	return out;
}

/**
 * Returns the API key for a provider, sourced from `pi`'s auth.json. Used
 * both to gate the picker (presence of a key) and to inject the key into
 * spawned `pi` children. Not sourced from `providers.env` — that file is
 * now transport-only (env vars for non-chat tools: VENICE_API_KEY for the
 * pi-venice-image extension, GEMINI_API_KEY for YouTube transcripts).
 */
export function getServerApiKey(provider: string): string | undefined {
	return readPiAuth().get(provider.toLowerCase());
}
