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
 * provider key model is fiddly because:
 *
 *   1. The SDK's `KnownProvider` union doesn't include "minimax" — it's
 *      a custom provider the server constructs in agent.ts:resolveModel.
 *      So we widen the set with `as KnownProvider` casts and add a
 *      separate entry for minimax.
 *   2. Some provider keys in `config.apiKeys` (e.g. "kimi-coding") use
 *      hyphens. We use the raw string as the set member.
 *
 * The "minimax" entry is the custom provider — not in the SDK's MODELS
 * map, but constructed in agent.ts:resolveModel. It's listed here so
 * setModel({ provider: "minimax", ... }) and /api/models can both find
 * it.
 */

import type { KnownProvider } from "@earendil-works/pi-ai";

/**
 * All providers the server can build an Agent for. This is the union of
 * providers shipped by @earendil-works/pi-ai plus the custom "minimax"
 * provider defined in agent.ts. The cast on each member is required
 * because "minimax" (and the other custom keys like "kimi-coding")
 * don't appear in the SDK's narrower `KnownProvider` union.
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
 * map and can be looked up via `getModel`). Excludes the custom
 * "minimax" provider which agent.ts constructs by hand.
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
] as const;

/**
 * Array form (preserves order) for the /api/models endpoint, which
 * iterates the providers and calls `getModels(provider)` for each. Only
 * the SDK-registered providers are listed here — `minimax` is added
 * separately as a hand-built entry in index.ts because it has no
 * getModels lookup.
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
	// Custom provider — constructed by hand, not in the SDK registry.
	// input: ["text","image"] marks M3 as multimodal.
	{
		id: "MiniMax-M3",
		provider: "minimax",
		name: "MiniMax M3",
		reasoning: true,
	},
	// Newer than this SDK build's registry (which tops out at glm-5.1);
	// `pi` resolves it fine as a zai model.
	{ id: "glm-5.2", provider: "zai", name: "GLM-5.2", reasoning: true },
];
