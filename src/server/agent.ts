/**
 * Server-side Agent factory.
 *
 * Constructs a single `pi Agent` per WebSocket session, with the local
 * tools (bash, read, write, edit, ls) registered, default model and
 * thinking level set.
 *
 * Defaults are locked in by user decision (2026-06-13):
 *   - default model:    MiniMax-M3 (minimax provider)
 *   - default thinking: high
 *
 * API key resolution: the server env is the only source. There is no
 * client-supplied API key in the current WS protocol — the init frame
 * never existed, despite the older CreateAgentOptions.clientApiKey
 * field. (The option is kept exported for back-compat with any future
 * protocol extension that re-introduces a per-key model switch.)
 *
 * `setModel` from the client can only pick from models the server
 * knows about — see providers.ts.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel as ThinkingLevelSdk } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { config, getServerApiKey } from "./config.js";
import { allTools } from "./tools.js";
import { isSdkProvider, KNOWN_PROVIDERS } from "./providers.js";

export const DEFAULT_MODEL_ID = "MiniMax-M3";
export const DEFAULT_PROVIDER = "minimax";
export const DEFAULT_THINKING: ThinkingLevelSdk = "high";

export interface CreateAgentOptions {
	/** Override the default model. */
	modelId?: string;
	provider?: string;
	/** Client-supplied API key for the chosen provider. Reserved for a
	 *  future protocol extension that re-introduces a per-key model
	 *  switch. The WS protocol today does not send this. */
	clientApiKey?: string;
	/** Override the default thinking level. */
	thinkingLevel?: ThinkingLevelSdk;
}

export interface CreateAgentResult {
	agent: Agent;
	model: Model<any>;
	provider: string;
	apiKeySource: "server" | "client" | "none";
	thinkingLevel: ThinkingLevelSdk;
}

export function createAgent(opts: CreateAgentOptions = {}): CreateAgentResult {
	// `opts.provider` is `string | undefined`. The KNOWN_PROVIDERS.has()
	// check on the *string* value below narrows the list of valid
	// providers, but TS doesn't know that — so we keep a typed local
	// (`provider: string`) and validate explicitly.
	const provider = (opts.provider ?? DEFAULT_PROVIDER).toLowerCase();
	const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
	const thinkingLevel = opts.thinkingLevel ?? DEFAULT_THINKING;

	if (!KNOWN_PROVIDERS.has(provider)) {
		throw new Error(`unknown provider: ${provider}`);
	}

	// Resolve the model. For "minimax" the SDK doesn't have it built-in, so
	// we have to construct a custom Model object (same shape the SDK uses).
	const model = resolveModel(provider, modelId);

	// API key: server env is the canonical source. Client key is reserved
	// for a future protocol extension; today chat.ts never passes it.
	const serverKey = getServerApiKey(provider);
	const clientKey = opts.clientApiKey?.trim() || undefined;
	const apiKey = serverKey ?? clientKey;
	const apiKeySource: "server" | "client" | "none" = serverKey
		? "server"
		: clientKey
			? "client"
			: "none";

	if (!apiKey) {
		throw new Error(`no API key for provider "${provider}" — set it in .env or via the model picker`);
	}

	// Build the agent. The Model object we pass in is the one that the SDK
	// will use to make provider calls — its `api` field tells streamSimple
	// which transport to use. The proxy `streamFn` is now identity, because
	// the server IS the one calling the provider directly.
	const agent = new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel,
			messages: [],
			tools: allTools,
		},
		streamFn: (model, context, options) => {
			// Server-side stream: call the provider directly with our key.
			// streamSimple is re-imported lazily here (vs. a top-level
			// import) so the SDK's heavy transport adapters don't load
			// until the first prompt. The import is cached after the
			// first call.
			return import("@earendil-works/pi-ai").then((m) => m.streamSimple(model, context, options));
		},
		getApiKey: async (prov: string) => {
			return prov === provider ? apiKey : undefined;
		},
	});

	return { agent, model, provider, apiKeySource, thinkingLevel };
}

function resolveModel(provider: string, modelId: string): Model<any> {
	// The built-in registry has anthropic/openai/google/... but not "minimax".
	// For known SDK providers, defer to getModel. For minimax, construct
	// the Model object from the same shape the seed-providers used.
	// modelId is a `string` but getModel wants `keyof (typeof MODELS)[K]`.
	// The cast is safe because resolveModel is only called with ids the
	// caller validated against KNOWN_PROVIDERS, and getModel returns
	// undefined for unknown ids (which we handle below).
	if (isSdkProvider(provider)) {
		const built = getModel(provider, modelId as never) as Model<any> | undefined;
		if (built) return built;
	}

	if (provider === "minimax") {
		return {
			id: modelId,
			name: modelId,
			api: "anthropic-messages",
			provider: "minimax",
			baseUrl: "https://api.minimax.io/anthropic",
			reasoning: true,
			// MiniMax M3 is multimodal — accepts text + image input. This
			// matters for image uploads: the SDK's streamSimple looks at
			// model.input to decide whether to include image content
			// blocks in the request, or just to send the URL as text.
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 32_000,
		} as Model<any>;
	}

	throw new Error(`model "${modelId}" not found for provider "${provider}"`);
}

const SYSTEM_PROMPT = `You are a coding agent running in a web chat that mimics the pi CLI. You have access to the local filesystem and a shell through these tools:

- bash: run a shell command. Use for builds, tests, git, anything you'd do in a terminal.
- read: read a file (with optional offset/limit for large files).
- write: create or overwrite a file. Use for new files or full rewrites.
- edit: in-place string replacement. Use for small, targeted changes.
- ls: list a directory.

You also have three web access tools (vendored from pi-web-access, MIT):

- web_search: search the web and get a synthesised answer with source URLs. Use this for any question about current events, libraries, APIs, or anything that needs up-to-date information. Returns the answer plus a numbered list of sources. Provider 'auto' uses Exa (zero-config, no API key needed) and falls back to Gemini's google-search grounding if GEMINI_API_KEY is set.
- fetch_content: read a URL and extract its readable content as markdown. Routes automatically — HTML pages, GitHub repos (cloned), YouTube videos (via Gemini), PDFs (text-extracted), and local video files. Use this for a specific page, doc, or video.
- code_search: programming-focused search. Use this instead of web_search for code questions, API lookups, library docs, and debugging topics.

There is NO sandbox. Files outside the working directory are accessible. Bash inherits the full process env. The user trusts you to operate on their machine; match that trust by being careful and explaining what you're doing.

When the user asks you to do something, prefer using tools over guessing. Show the tool calls and their results so the user can follow along. If a tool fails, read the error and try again with a corrected approach.

When responding, keep prose tight. Use code blocks for snippets. Prefer explaining tradeoffs in 1-2 sentences, then acting.`;
