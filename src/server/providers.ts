/**
 * Single source of truth for the list of LLM providers the server knows
 * about. Imported by:
 *
 *   - models-cache.ts: to iterate SDK providers when picking a boot-probe
 *                  provider, and to derive SDK_PROVIDERS
 *   - index.ts:    to drive the /api/models picker — only providers
 *                  that are both in this set AND authenticated in `pi`'s
 *                  auth.json are returned to the client
 *
 * Why a single file: the previous design had two parallel arrays
 * (`KNOWN_PROVIDERS` in agent.ts, `builtinProviders` in index.ts) that
 * drifted in membership and order. Combining the set with the SDK's
 * provider key model is fiddly because some provider keys (e.g.
 * "kimi-coding") use hyphens — we use the raw string as the set member.
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
 * reads for it. This is the **single source of truth** for the env-var
 * name `pi-process.ts` INJECTs into the child's env when spawning
 * `pi --mode rpc` (the key value itself comes from `pi`'s auth.json via
 * `getServerApiKey`, NOT from process.env — see config.ts).
 *
 * Keeping the name in one place means a new provider is a one-line edit
 * here, not a coordinated change across two files (which previously
 * drifted: config.ts read `MiniMax_API_KEY`, pi-process.ts injected
 * `MINIMAX_API_KEY`; same value flowed through, but the two maps had to
 * be maintained by hand and nothing checked they matched).
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

