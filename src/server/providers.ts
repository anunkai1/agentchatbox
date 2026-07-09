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
 * map and can be looked up via `getModels`). Derived from PROVIDER_KEYS
 * instead of maintained as a second hand-edited list, so the two can't
 * drift — adding a provider to PROVIDER_KEYS that the SDK doesn't know
 * about is a one-line exclusion here, not a silent second-list edit.
 *
 * For chat-model advertisement, these are joined with whatever pi's boot
 * probe discovers from ~/.pi/agent/models.json — see models-cache.ts. The
 * picker is purely a mirror of `pi`, no ACB-side curation.
 */
const NON_SDK_PROVIDERS = new Set(["ollama", "venice"]);
const SDK_PROVIDER_KEYS = PROVIDER_KEYS.filter((p) => !NON_SDK_PROVIDERS.has(p));

/**
 * Array form (preserves order) for the /api/models endpoint, which
 * iterates the providers and calls `getModels(provider)` for each.
 */
export const SDK_PROVIDERS: ReadonlyArray<KnownProvider> =
	SDK_PROVIDER_KEYS as readonly KnownProvider[];

/** True if the provider id maps to a SDK-registered entry. */
export function isSdkProvider(provider: string): provider is KnownProvider {
	return (SDK_PROVIDER_KEYS as readonly string[]).includes(provider);
}

/**
 * Image generation models — separate from the chat model list because
 * the ACB chat picker only accepts text/chat models (image models
 * aren't callable via pi's chat-completions endpoint). pi doesn't
 * enumerate image-generation models via get_available_models, so this
 * list stays in code — there's no equivalent of `models.json` to push
 * them to. Surfaced via `GET /api/image-models`; the picker persists
 * the user's choice via the `setImageModel` RPC to a file the
 * pi-venice-image extension reads on each tool call.
 *
 * kidstories (separate service) uses two of these IDs
 * (`z-image-turbo`, `qwen-image`) via its own Venice client —
 * kidstories does NOT consume this list.
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
	{
		id: "flux-2-max",
		provider: "venice",
		name: "Flux 2 Max (Venice)",
		tags: ["flagship", "flux", "photoreal"],
	},
	{ id: "flux-2-pro", provider: "venice", name: "Flux 2 Pro (Venice)", tags: ["pro", "flux"] },
	// OpenAI image gen (Venice-routed, not direct OpenAI API)
	{
		id: "gpt-image-2",
		provider: "venice",
		name: "GPT Image 2 (Venice)",
		tags: ["openai", "latest"],
	},
	{ id: "gpt-image-1-5", provider: "venice", name: "GPT Image 1.5 (Venice)", tags: ["openai"] },
	// xAI Grok
	{
		id: "grok-imagine-image-quality",
		provider: "venice",
		name: "Grok Imagine Quality (Venice)",
		tags: ["grok", "quality"],
	},
	{ id: "grok-imagine-image", provider: "venice", name: "Grok Imagine (Venice)", tags: ["grok"] },
	// Google — "nano-banana" is the public codename
	{
		id: "nano-banana-pro",
		provider: "venice",
		name: "Nano Banana Pro (Venice)",
		tags: ["google", "pro"],
	},
	{ id: "nano-banana-2", provider: "venice", name: "Nano Banana 2 (Venice)", tags: ["google"] },
	{
		id: "nano-banana-2-lite",
		provider: "venice",
		name: "Nano Banana 2 Lite (Venice)",
		tags: ["google", "lite", "cheap"],
	},
	// Ideogram — strong at typography-in-images
	{
		id: "ideogram-v4",
		provider: "venice",
		name: "Ideogram V4 (Venice)",
		tags: ["ideogram", "typography"],
	},
	// Alibaba Qwen
	{
		id: "qwen-image-2-pro",
		provider: "venice",
		name: "Qwen Image 2 Pro (Venice)",
		tags: ["qwen", "pro"],
	},
	{ id: "qwen-image-2", provider: "venice", name: "Qwen Image 2 (Venice)", tags: ["qwen"] },
	{
		id: "qwen-image",
		provider: "venice",
		name: "Qwen Image (Venice)",
		tags: ["qwen", "kidstories"],
	},
	// Recraft — vector/illustration strength
	{
		id: "recraft-v4-pro",
		provider: "venice",
		name: "Recraft V4 Pro (Venice)",
		tags: ["recraft", "pro", "vector"],
	},
	// ByteDance Seedream
	{
		id: "seedream-v5-pro",
		provider: "venice",
		name: "Seedream V5 Pro (Venice)",
		tags: ["seedream", "pro"],
	},
	// Alibaba Wan
	{
		id: "wan-2-7-pro-text-to-image",
		provider: "venice",
		name: "Wan 2.7 Pro T2I (Venice)",
		tags: ["wan", "pro"],
	},
	// z-image-turbo — currently used by kidstories (VENICE_IMAGE_MODEL in
	// services/kidstories/.env; see server2-overview §XIII, 2026-07-06 entry)
	{
		id: "z-image-turbo",
		provider: "venice",
		name: "Z-Image Turbo (Venice)",
		tags: ["turbo", "fast", "kidstories"],
	},
];
