/**
 * Single source of truth for the list of LLM providers the server knows
 * about. Imported by:
 *
 *   - agent.ts:    to validate the `provider` arg of `createAgent` before
 *                  building an Agent (rejects typos like "anhtropic")
 *   - index.ts:    to drive the /api/models picker — only providers
 *                  that are both in this set AND have a configured API
 *                  key are returned to the client
 *
 * Why a single file: the previous design had two parallel arrays
 * (`KNOWN_PROVIDERS` in agent.ts, `builtinProviders` in index.ts) that
 * drifted in membership and order. Combining the set with the SDK's
 * provider key model is fiddly because some provider keys in
 * `config.apiKeys` (e.g. "kimi-coding") use hyphens — we use the raw
 * string as the set member.
 */

import type { KnownProvider } from "@earendil-works/pi-ai";

/**
 * All providers the server can build an Agent for. This is the union of
 * providers shipped by @earendil-works/pi-ai. The cast on each member is
 * required for the keys (like "kimi-coding") that the SDK's narrower
 * `KnownProvider` union did historically exclude; harmless now that it
 * includes them.
 */
export const PROVIDER_KEYS = [
	"anthropic",
	"openai",
	"google",
	"xai",
	"groq",
	"cerebras",
	"openrouter",
	"deepseek",
	"mistral",
	"huggingface",
	"fireworks",
	"together",
	"vercel-ai-gateway",
	"zai",
	"kimi-coding",
	"opencode",
	"minimax",
	"ollama",
	"venice",
] as const;

export type SupportedProvider = (typeof PROVIDER_KEYS)[number];

/**
 * Set form for O(1) membership checks (e.g. validating client-sent
 * `provider` strings). Note: `Set` here holds the wider `string` type —
 * the `as KnownProvider` cast below mirrors what agent.ts used to do,
 * since the SDK's union excludes our custom providers.
 */
export const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<string>(
	PROVIDER_KEYS as unknown as string[],
);

/**
 * Maps a provider id to the `*_API_KEY` environment-variable name `pi`
 * reads for it. This is the **single source of truth** for both:
 *
 *   - `config.ts`  — which env var to READ at boot to populate apiKeys
 *   - `pi-process.ts` — which env var to INJECT into the child's env
 *
 * Keeping both sides reading from one table means a new provider is a
 * one-line edit here, not a coordinated change across two files (which
 * previously drifted: config.ts read `MiniMax_API_KEY`, pi-process.ts
 * injected `MINIMAX_API_KEY`; same value flowed through, but the two
 * maps had to be maintained by hand and nothing checked they matched).
 *
 * Mirrors `getApiKeyEnvVars()` in `@earendil-works/pi-ai`, which is not
 * exported. Keep this in sync if pi-ai adds providers.
 */
const PROVIDER_API_KEY_ENV: Record<string, string> = {
	"github-copilot": "COPILOT_GITHUB_TOKEN",
	anthropic: "ANTHROPIC_API_KEY",
	"ant-ling": "ANT_LING_API_KEY",
	openai: "OPENAI_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	google: "GEMINI_API_KEY",
	"google-vertex": "GOOGLE_CLOUD_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	moonshotai: "MOONSHOT_API_KEY",
	"moonshotai-cn": "MOONSHOT_API_KEY",
	huggingface: "HF_TOKEN",
	fireworks: "FIREWORKS_API_KEY",
	together: "TOGETHER_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
	"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
	"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
	// Ollama doesn't need a real API key, but pi treats unknown providers
	// as requiring auth before showing them in the picker. `pi`'s
	// model-registry uses the literal apiKey from `~/.pi/agent/models.json`
	// (default "ollama" there). We mirror that here as the env-var value
	// when OLLAMA_API_KEY is not set, so agentchatbox's own key-presence
	// check in session-registry.ts passes. The key is sent in the
	// Authorization header, which Ollama ignores.
	ollama: "OLLAMA_API_KEY",
	venice: "VENICE_API_KEY",
	xiaomi: "XIAOMI_API_KEY",
	"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
};

/**
 * Returns the env-var name `pi` reads for `provider`'s API key. Falls back
 * to the `<PROVIDER>_API_KEY` convention for providers not yet listed.
 */
export function providerApiKeyEnvVar(provider: string): string {
	return PROVIDER_API_KEY_ENV[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}

/**
 * Subset of PROVIDER_KEYS that map to SDK-registered providers (i.e.
 * providers that have a real entry in @earendil-works/pi-ai's MODELS
 * map and can be looked up via `getModels`). `minimax` was once a
 * hand-built provider; it has since been promoted into the SDK
 * registry (MiniMax-M2.7, MiniMax-M2.7-highspeed), so it lives here
 * now and the old `EXTRA_MODELS` shim is gone.
 */
const SDK_PROVIDER_KEYS = [
	"anthropic",
	"openai",
	"google",
	"xai",
	"groq",
	"cerebras",
	"openrouter",
	"deepseek",
	"mistral",
	"huggingface",
	"fireworks",
	"together",
	"vercel-ai-gateway",
	"zai",
	"kimi-coding",
	"opencode",
	"minimax",
] as const;

/**
 * Array form (preserves order) for the /api/models endpoint, which
 * iterates the providers and calls `getModels(provider)` for each.
 */
export const SDK_PROVIDERS: ReadonlyArray<KnownProvider> = SDK_PROVIDER_KEYS;

/** True if the provider id maps to a SDK-registered entry. */
export function isSdkProvider(provider: string): provider is KnownProvider {
	return (SDK_PROVIDER_KEYS as readonly string[]).includes(provider);
}

/**
 * Models not in the SDK's built-in registry — either a custom provider
 * the server builds by hand (minimax) or a model newer than the
 * registry's generated list (glm-5.2). The `/api/models` endpoint
 * appends these after the SDK-listed models, gated on each entry's
 * provider having a configured API key.
 *
 * This replaces the per-model hand-built `out.push(...)` blocks that
 * used to live in index.ts — adding a new extra model is now a one-line
 * edit here, not a new code block.
 */
export interface ExtraModel {
	id: string;
	provider: string;
	name: string;
	reasoning: boolean;
}

export const EXTRA_MODELS: readonly ExtraModel[] = [
	// --- MiniMax ---
	// The pi-ai SDK registry is stale for the native `minimax` provider:
	// it only carries MiniMax-M2.7 and -M2.7-highspeed. MiniMax's actual
	// API (https://platform.minimax.io/docs/api-reference/api-overview,
	// Anthropic-SDK compatible) serves a full M-series lineup. `pi`
	// resolves these IDs against the provider config even though they
	// aren't in the registry, so we surface them here.
	//
	// MiniMax-M3 (launched 2026-06-01) is the current flagship: 1M
	// context, native multimodal (image+video), MSA architecture, the
	// strongest coding/agentic benchmarks in the M-series. Marked
	// reasoning; the rest are listed without the badge since their
	// thinking support isn't confirmed here.
	{ id: "MiniMax-M3", provider: "minimax", name: "MiniMax M3", reasoning: true },
	{ id: "MiniMax-M2.5", provider: "minimax", name: "MiniMax M2.5", reasoning: false },
	{ id: "MiniMax-M2.5-highspeed", provider: "minimax", name: "MiniMax M2.5 Highspeed", reasoning: false },
	{ id: "MiniMax-M2.1", provider: "minimax", name: "MiniMax M2.1", reasoning: false },
	{ id: "MiniMax-M2.1-highspeed", provider: "minimax", name: "MiniMax M2.1 Highspeed", reasoning: false },
	{ id: "MiniMax-M2", provider: "minimax", name: "MiniMax M2", reasoning: false },
	// --- zai ---
	// Newer than this SDK build's registry (which tops out at glm-5.1);
	// `pi` resolves it fine as a zai model.
	{ id: "glm-5.2", provider: "zai", name: "GLM-5.2", reasoning: true },
	// --- ollama (local, served by systemd ollama.service on 127.0.0.1:11434) ---
	// Defined in ~/.pi/agent/models.json; pi's model-registry reads it at
	// startup and registers the provider under api="openai-completions"
	// pointing at http://127.0.0.1:11434/v1.
	//
	// Model history on this box (CPU-only i5-1135G7, no GPU):
	//   - qwen3-coder:30b: 500s after 2-5 min, too heavy. Deleted.
	//   - qwen3:8b: Ollama's OpenAI-compat endpoint ignores `/no_think`,
	//     `enable_thinking:false`, and `chat_template_kwargs` — the model
	//     burns its whole budget on <think> tokens and never responds.
	//     Unusable via pi until Ollama ships `PARAMETER think false`
	//     (PR ollama/ollama#14108, not in 0.13.2). Deleted.
	//   - llama3.1:latest (current): no thinking mode, works cleanly via
	//     OpenAI-compat, ~5-10 tok/s on the icelake CPU backend. The
	//     pragmatic choice — weaker tool calling than qwen3 but actually
	//     functional.
	{ id: "llama3.1:latest", provider: "ollama", name: "Llama 3.1 8B (Ollama, local)", reasoning: false },
	// --- venice ---
	// Venice (venice.ai) is an OpenAI-compatible aggregator. The provider is
	// declared in ~/.pi/agent/models.json (baseUrl https://api.venice.ai/api/v1,
	// api openai-completions); auth comes from ~/.secrets/llm/pi-auth.json (the
	// `venice` entry — same dual representation as minimax/zai: flat-env in
	// providers.env for ACB systemd + JSON in pi-auth.json for standalone pi).
	// Curated set (all vision-capable, the use case that prompted adding Venice);
	// 48 of Venice's 93 text models support image input — add more on request.
	// compat.supportsReasoningEffort is false at the provider level (set in
	// models.json) because only some Venice models honour reasoning_effort, so
	// the thinking slider in ACB does not transmit to Venice models.
	{ id: "qwen3-vl-235b-a22b", provider: "venice", name: "Qwen3 VL 235B (Venice)", reasoning: false },
	{ id: "qwen3-5-9b", provider: "venice", name: "Qwen 3.5 9B (Venice)", reasoning: true },
	{ id: "minimax-m3-preview", provider: "venice", name: "MiniMax M3 Preview (Venice)", reasoning: true },
	{ id: "gemini-3-flash-preview", provider: "venice", name: "Gemini 3 Flash (Venice)", reasoning: true },
	{ id: "gemini-3-5-flash", provider: "venice", name: "Gemini 3.5 Flash (Venice)", reasoning: true },
	{ id: "grok-4-3", provider: "venice", name: "Grok 4.3 (Venice)", reasoning: true },
	{ id: "grok-4-20", provider: "venice", name: "Grok 4.20 (Venice)", reasoning: true },
	{ id: "kimi-k2-6", provider: "venice", name: "Kimi K2.6 (Venice)", reasoning: true },
	{ id: "claude-opus-4-7", provider: "venice", name: "Claude Opus 4.7 (Venice)", reasoning: true },
	{ id: "qwen3-5-397b-a17b", provider: "venice", name: "Qwen 3.5 397B (Venice)", reasoning: true },
	{ id: "venice-uncensored-1-2", provider: "venice", name: "Venice Uncensored 1.2", reasoning: false },
];
