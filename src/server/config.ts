/**
 * Server configuration. All values come from environment variables.
 *
 * Copy `.env.example` to `.env` and fill in the keys you want to use.
 * Only the providers you have keys for are exposed to the client.
 */

import "dotenv/config";

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
}

function readKey(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim().length > 0 ? v.trim() : undefined;
}

export const config: ServerConfig = {
	port: Number.parseInt(process.env.PORT ?? "3000", 10),
	host: process.env.HOST ?? "0.0.0.0",
	uploadsDir: process.env.UPLOADS_DIR ?? "./uploads",
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
