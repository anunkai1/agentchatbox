/**
 * Custom providers we want every agentchatbox user to see in the model picker.
 *
 * The web UI's built-in registry has MiniMax M2.x models but not M3 (yet).
 * We register M3 here so it appears in the picker as soon as the user has
 * a `MiniMax_API_KEY` configured on the server (or in the client).
 *
 * If the user already added this provider themselves, we don't overwrite.
 */

import type { CustomProvider, Model } from "@earendil-works/pi-web-ui";

const minimaxM3: Model<"anthropic-messages"> = {
	id: "MiniMax-M3",
	name: "MiniMax M3",
	api: "anthropic-messages",
	provider: "minimax",
	baseUrl: "https://api.minimax.io/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // check MiniMax dashboard for current pricing
	contextWindow: 1_000_000,
	maxTokens: 32_000,
};

const minimaxM2_5: Model<"anthropic-messages"> = {
	id: "MiniMax-M2.5",
	name: "MiniMax M2.5",
	api: "anthropic-messages",
	provider: "minimax",
	baseUrl: "https://api.minimax.io/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 204_800,
	maxTokens: 16_000,
};

const minimaxProvider: CustomProvider = {
	id: "minimax",
	name: "MiniMax",
	type: "anthropic-messages",
	baseUrl: "https://api.minimax.io/anthropic",
	// apiKey is intentionally left empty: the server's MiniMax_API_KEY env
	// var is the source of truth and is injected by the proxy. The user
	// can still override in Settings → Providers/Models if they want.
	apiKey: "",
	models: [minimaxM3, minimaxM2_5],
};

export const SEED_CUSTOM_PROVIDERS: CustomProvider[] = [minimaxProvider];
