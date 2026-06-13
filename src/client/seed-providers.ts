/**
 * Custom providers we want every agentchatbox user to see in the model picker.
 *
 * The web UI's built-in registry has MiniMax M2.x models but not M3 (yet).
 * We register M3 here so it appears in the picker as soon as the user has
 * a `MiniMax_API_KEY` configured on the server (or in the client).
 */

export interface CustomProviderSeed {
	id: string;
	name: string;
	type: string;
	baseUrl: string;
	apiKey?: string;
	models: Array<{
		id: string;
		name: string;
		contextWindow: number;
		maxTokens: number;
	}>;
}

const minimaxProvider: CustomProviderSeed = {
	id: "minimax",
	name: "MiniMax",
	type: "anthropic-messages",
	baseUrl: "https://api.minimax.io/anthropic",
	models: [
		{
			id: "MiniMax-M3",
			name: "MiniMax M3",
			contextWindow: 1_000_000,
			maxTokens: 32_000,
		},
		{
			id: "MiniMax-M2.5",
			name: "MiniMax M2.5",
			contextWindow: 204_800,
			maxTokens: 16_000,
		},
	],
};

export const SEED_CUSTOM_PROVIDERS: CustomProviderSeed[] = [minimaxProvider];

/** Flatten built-in + custom providers into a single model list for the picker. */
export async function listAvailableModels(): Promise<
	Array<{ id: string; name: string; provider: string; baseUrl?: string }>
> {
	const out: Array<{ id: string; name: string; provider: string; baseUrl?: string }> = [];

	// Built-in models from the registry (Claude, GPT-4o, etc.)
	const { getModels } = await import("@earendil-works/pi-ai");
	try {
		const all = (getModels as unknown as () => Array<unknown>)();
		for (const m of all as Array<{ id: string; name: string; provider: string; baseUrl: string }>) {
			if (m.id && m.provider) {
				out.push({ id: m.id, name: m.name ?? m.id, provider: m.provider, baseUrl: m.baseUrl });
			}
		}
	} catch {
		// getModels may not exist in this version; fall through
	}

	// Add custom providers (MiniMax M3, etc.)
	const custom: CustomProviderSeed[] = (await import("./seed-providers.js")).SEED_CUSTOM_PROVIDERS;
	for (const p of custom) {
		for (const m of p.models) {
			out.push({ id: m.id, name: m.name, provider: p.id, baseUrl: p.baseUrl });
		}
	}

	// De-dupe by id
	const seen = new Set<string>();
	return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}
