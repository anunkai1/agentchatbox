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
	//
	// Curated chat/text set — one flagship+ per major family so the picker
	// shows the breadth of what Venice routes without overwhelming it (94 text
	// models total; this is 25). Grouped by family below; vision-capable
	// models are preferred where it doesn't compromise on capability (vision
	// was the original use case that prompted adding Venice).
	//
	// compat.supportsReasoningEffort is false at the provider level (set in
	// models.json) because only some Venice models honour reasoning_effort, so
	// the thinking slider in ACB does not transmit to Venice models. The
	// `reasoning: true` flag below is purely a UI badge (shows the 🧠 icon in
	// the picker), not an indicator that reasoning_effort is honoured.
	//
	// Anthropic
	{ id: "claude-opus-4-7", provider: "venice", name: "Claude Opus 4.7 (Venice)", reasoning: true },
	{ id: "claude-opus-4-8", provider: "venice", name: "Claude Opus 4.8 (Venice)", reasoning: true },
	{ id: "claude-sonnet-5", provider: "venice", name: "Claude Sonnet 5 (Venice)", reasoning: true },
	// OpenAI
	{ id: "openai-gpt-55", provider: "venice", name: "GPT-5.5 (Venice)", reasoning: true },
	{ id: "openai-gpt-55-pro", provider: "venice", name: "GPT-5.5 Pro (Venice)", reasoning: true },
	{ id: "openai-gpt-54", provider: "venice", name: "GPT-5.4 (Venice)", reasoning: true },
	{ id: "openai-gpt-53-codex", provider: "venice", name: "GPT-5.3 Codex (Venice)", reasoning: true },
	// Google
	{ id: "gemini-3-flash-preview", provider: "venice", name: "Gemini 3 Flash (Venice)", reasoning: true },
	{ id: "gemini-3-5-flash", provider: "venice", name: "Gemini 3.5 Flash (Venice)", reasoning: true },
	{ id: "gemini-3-1-pro-preview", provider: "venice", name: "Gemini 3.1 Pro (Venice)", reasoning: true },
	// xAI Grok
	{ id: "grok-4-3", provider: "venice", name: "Grok 4.3 (Venice)", reasoning: true },
	{ id: "grok-4-20", provider: "venice", name: "Grok 4.20 (Venice)", reasoning: true },
	{ id: "grok-4-5", provider: "venice", name: "Grok 4.5 (Venice)", reasoning: true },
	// Moonshot Kimi
	{ id: "kimi-k2-6", provider: "venice", name: "Kimi K2.6 (Venice)", reasoning: true },
	{ id: "kimi-k2-7-code", provider: "venice", name: "Kimi K2.7 Code (Venice)", reasoning: true },
	// DeepSeek
	{ id: "deepseek-v4-pro", provider: "venice", name: "DeepSeek V4 Pro (Venice)", reasoning: true },
	{ id: "deepseek-v4-flash", provider: "venice", name: "DeepSeek V4 Flash (Venice)", reasoning: true },
	// Alibaba Qwen
	{ id: "qwen-3-7-plus", provider: "venice", name: "Qwen 3.7 Plus (Venice)", reasoning: true },
	{ id: "qwen3-5-397b-a17b", provider: "venice", name: "Qwen 3.5 397B (Venice)", reasoning: true },
	{ id: "qwen3-vl-235b-a22b", provider: "venice", name: "Qwen3 VL 235B (Venice)", reasoning: false },
	// Xiaomi MiMo (omnimodal — text + image + audio + video, 1M ctx)
	{ id: "xiaomi-mimo-v2-5", provider: "venice", name: "Xiaomi MiMo V2.5 (Venice)", reasoning: true },
	// Mistral
	{ id: "mistral-small-2603", provider: "venice", name: "Mistral Small 3.1 (Venice)", reasoning: true },
	// Z.AI GLM
	{ id: "zai-org-glm-5-2", provider: "venice", name: "GLM 5.2 (Venice)", reasoning: true },
	// MiniMax (via Venice routing — different price/cache behaviour vs the
	// direct minimax provider entry above; useful when the direct quota
	// is exhausted)
	{ id: "minimax-m3-preview", provider: "venice", name: "MiniMax M3 Preview (Venice)", reasoning: true },
	// Uncensored (no reasoning, no tool calling; kept for cases where
	// safety filtering is the blocker, not the capability)
	{ id: "venice-uncensored-1-2", provider: "venice", name: "Venice Uncensored 1.2", reasoning: false },
	// --- openrouter ---
	// Provider declared in ~/.pi/agent/models.json (baseUrl
	// https://openrouter.ai/api/v1, api openai-completions, compat
	// supportsDeveloperRole=false + thinkingFormat=openrouter). Auth comes
	// from .secrets/llm/providers.env (OPENROUTER_API_KEY) for the ACB systemd
	// child and .secrets/llm/pi-auth.json `openrouter` entry for standalone pi.
	//
	// Built-in SDK models (e.g. tencent/hy3-preview) flow through `getModels`
	// automatically once OPENROUTER_API_KEY is set. Custom models not in the
	// SDK registry (like the `:free` tier below) get surfaced via this list
	// — appended after the SDK-listed models, gated on the provider key.
	//
	// tencent/hy3:free — Tencent Hy3, a 295B-param MoE (21B active, 192
	// experts top-8). OpenRouter's free tier of the production model, served
	// by Novita. 262K context, reasoning configurable (default high, supported
	// efforts: high/low/none). Free promo expires 2026-07-21 per OpenRouter —
	// when the promo ends, either re-evaluate or delete this entry. Cost
	// hard-coded to $0 to match OpenRouter's `pricing: {prompt:"0",
	// completion:"0"}`. See server2-overview §XX entry for 2026-07-08.
	{ id: "tencent/hy3:free", provider: "openrouter", name: "Tencent Hy3 (free)", reasoning: true },
];

/**
 * Image generation models — separate from EXTRA_MODELS because the ACB
 * chat picker only accepts text/chat models (image models aren't callable
 * via pi's chat-completions endpoint). This list is the source of truth
 * for which image model IDs are valid for the image-gen tool registered
 * by the pi-venice-image extension (loaded by `pi --mode rpc` alongside
 * the agentchatbox chat flow). Surfaced to the browser via
 * `GET /api/image-models` so the model picker can show a separate
 * "Venice images" group independent of the chat models; the picker
 * selection is persisted via `setImageModel` RPC → file write
 * (`/home/lepton/.config/acb/image-model`), and the extension reads
 * that file on each tool call, so model switches take effect on the
 * next agent invocation without needing to respawn pi.
 *
 * kidstories (separate service) also uses two of these IDs
 * (`z-image-turbo`, `qwen-image`) directly via its own Venice client —
 * kidstories does NOT consume this list.
 *
 * Currently Venice-only (Venice is the only provider we have image-gen
 * creds for; if OpenRouter image routes get wired in later, add a
 * `provider: "openrouter"` field and gate on the key the same way
 * EXTRA_MODELS does).
 *
 * IDs come from `GET https://api.venice.ai/api/v1/models?type=image`.
 * 35 image models exist; this is a curated 17 — one per notable family
 * / flagship, prioritising current generation. Pricing varies wildly
 * (SDXL-tier ~$0.001/img, Flux-2 Max several cents/img); see Venice's
 * model catalog for current rates.
 */
export interface ExtraImageModel {
	id: string;
	provider: string;
	name: string;
	/** Free-form tags for the UI / docs; no enforced schema. */
	tags: readonly string[];
}

export const EXTRA_IMAGE_MODELS: readonly ExtraImageModel[] = [
	// Black Forest Labs — current flagship
	{ id: "flux-2-max", provider: "venice", name: "Flux 2 Max (Venice)", tags: ["flagship", "flux", "photoreal"] },
	{ id: "flux-2-pro", provider: "venice", name: "Flux 2 Pro (Venice)", tags: ["pro", "flux"] },
	// OpenAI image gen (Venice-routed, not direct OpenAI API)
	{ id: "gpt-image-2", provider: "venice", name: "GPT Image 2 (Venice)", tags: ["openai", "latest"] },
	{ id: "gpt-image-1-5", provider: "venice", name: "GPT Image 1.5 (Venice)", tags: ["openai"] },
	// xAI Grok
	{ id: "grok-imagine-image-quality", provider: "venice", name: "Grok Imagine Quality (Venice)", tags: ["grok", "quality"] },
	{ id: "grok-imagine-image", provider: "venice", name: "Grok Imagine (Venice)", tags: ["grok"] },
	// Google — "nano-banana" is the public codename
	{ id: "nano-banana-pro", provider: "venice", name: "Nano Banana Pro (Venice)", tags: ["google", "pro"] },
	{ id: "nano-banana-2", provider: "venice", name: "Nano Banana 2 (Venice)", tags: ["google"] },
	{ id: "nano-banana-2-lite", provider: "venice", name: "Nano Banana 2 Lite (Venice)", tags: ["google", "lite", "cheap"] },
	// Ideogram — strong at typography-in-images
	{ id: "ideogram-v4", provider: "venice", name: "Ideogram V4 (Venice)", tags: ["ideogram", "typography"] },
	// Alibaba Qwen
	{ id: "qwen-image-2-pro", provider: "venice", name: "Qwen Image 2 Pro (Venice)", tags: ["qwen", "pro"] },
	{ id: "qwen-image-2", provider: "venice", name: "Qwen Image 2 (Venice)", tags: ["qwen"] },
	{ id: "qwen-image", provider: "venice", name: "Qwen Image (Venice)", tags: ["qwen", "kidstories"] },
	// Recraft — vector/illustration strength
	{ id: "recraft-v4-pro", provider: "venice", name: "Recraft V4 Pro (Venice)", tags: ["recraft", "pro", "vector"] },
	// ByteDance Seedream
	{ id: "seedream-v5-pro", provider: "venice", name: "Seedream V5 Pro (Venice)", tags: ["seedream", "pro"] },
	// Alibaba Wan
	{ id: "wan-2-7-pro-text-to-image", provider: "venice", name: "Wan 2.7 Pro T2I (Venice)", tags: ["wan", "pro"] },
	// z-image-turbo — currently used by kidstories (VENICE_IMAGE_MODEL in
	// services/kidstories/.env; see server2-overview §XIII, 2026-07-06 entry)
	{ id: "z-image-turbo", provider: "venice", name: "Z-Image Turbo (Venice)", tags: ["turbo", "fast", "kidstories"] },
];
