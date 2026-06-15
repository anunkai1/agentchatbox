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

import { resolve } from "node:path";
import { projectRoot } from "./paths.js";

export interface ServerConfig {
	port: number;
	host: string;
	/** Folder for uploaded files. Created on boot. */
	uploadsDir: string;
	/** Max upload size in bytes. Default 50 MB. */
	maxUploadBytes: number;
	/** Provider API keys, keyed by provider id. */
	apiKeys: Record<string, string>;
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
	apiKeys: {
		anthropic: readKey("ANTHROPIC_API_KEY") ?? "",
		openai: readKey("OPENAI_API_KEY") ?? "",
		google: readKey("GOOGLE_API_KEY") ?? "",
		xai: readKey("XAI_API_KEY") ?? "",
		groq: readKey("GROQ_API_KEY") ?? "",
		cerebras: readKey("CEREBRAS_API_KEY") ?? "",
		openrouter: readKey("OPENROUTER_API_KEY") ?? "",
		deepseek: readKey("DEEPSEEK_API_KEY") ?? "",
		mistral: readKey("MISTRAL_API_KEY") ?? "",
		"minimax": readKey("MiniMax_API_KEY") ?? "",
		huggingface: readKey("HUGGINGFACE_API_KEY") ?? "",
		fireworks: readKey("FIREWORKS_API_KEY") ?? "",
		together: readKey("TOGETHER_API_KEY") ?? "",
		"vercel-ai-gateway": readKey("VERCEL_AI_GATEWAY_API_KEY") ?? "",
		zai: readKey("ZAI_API_KEY") ?? "",
		"kimi-coding": readKey("KIMI_API_KEY") ?? "",
		"opencode": readKey("OPENCODE_API_KEY") ?? "",
	},
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
 * Returns the API key configured for a given provider, or undefined.
 * The server uses this to decide whether to use a key the client supplied
 * or fall back to one configured here.
 */
export function getServerApiKey(provider: string): string | undefined {
	const key = config.apiKeys[provider.toLowerCase()];
	return key && key.length > 0 ? key : undefined;
}
