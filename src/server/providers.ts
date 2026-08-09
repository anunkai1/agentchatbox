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

import type { BuiltinProvider } from "@earendil-works/pi-ai/providers/all";

/**
 * Provider identifiers ACB may advertise. pi remains the authority for the
 * actual runtime catalog; this list is used only to select a built-in model
 * for the one-shot boot probe.
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
	"venice",
] as const;

export type SupportedProvider = (typeof PROVIDER_KEYS)[number];

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
const NON_SDK_PROVIDERS = new Set(["venice"]);
const SDK_PROVIDER_KEYS = PROVIDER_KEYS.filter((p) => !NON_SDK_PROVIDERS.has(p));

/**
 * Array form (preserves order) for the /api/models endpoint, which
 * iterates the providers and calls `getModels(provider)` for each.
 */
export const SDK_PROVIDERS: ReadonlyArray<BuiltinProvider> =
	SDK_PROVIDER_KEYS as readonly BuiltinProvider[];
