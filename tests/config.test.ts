/**
 * config.ts — env → ServerConfig.
 *
 * Verifies the apiKeys map is built from the single provider→env-var
 * table in providers.ts (the #4 consolidation). The key behavior: the
 * server reads each provider's key from the SAME env-var name that pi
 * itself reads, so setting the legacy mixed-case name no longer works.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Snapshot of process.env so each test starts clean. config.ts reads
// env at module-eval time, so we reset modules between cases.
const ENV_KEYS = [
	"MINIMAX_API_KEY",
	"MiniMax_API_KEY",
	"DEEPSEEK_API_KEY",
	"ZAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
];

const snapshot: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const k of ENV_KEYS) snapshot[k] = process.env[k];
	for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (snapshot[k] === undefined) delete process.env[k];
		else process.env[k] = snapshot[k];
	}
});

async function loadConfig() {
	const mod = await import("../src/server/config.js");
	return mod.config;
}

describe("config.apiKeys — single-source-of-truth env names", () => {
	it("reads MINIMAX_API_KEY into apiKeys.minimax", async () => {
		process.env.MINIMAX_API_KEY = "mm-secret";
		vi.resetModules();
		const config = await loadConfig();
		expect(config.apiKeys.minimax).toBe("mm-secret");
	});

	it("does NOT read the legacy MiniMax_API_KEY name", async () => {
		// Regression guard for the pre-consolidation drift: setting the
		// old mixed-case name must leave minimax empty, because the
		// canonical name is now MINIMAX_API_KEY everywhere.
		process.env.MiniMax_API_KEY = "legacy-should-not-work";
		vi.resetModules();
		const config = await loadConfig();
		expect(config.apiKeys.minimax).toBe("");
	});

	it("reads GEMINI_API_KEY (not GOOGLE_API_KEY) into apiKeys.google", async () => {
		process.env.GEMINI_API_KEY = "gem-secret";
		process.env.GOOGLE_API_KEY = "should-be-ignored";
		vi.resetModules();
		const config = await loadConfig();
		expect(config.apiKeys.google).toBe("gem-secret");
	});

	it("getServerApiKey resolves the configured key and treats blank as unset", async () => {
		process.env.DEEPSEEK_API_KEY = "ds-secret";
		vi.resetModules();
		const mod = await import("../src/server/config.js");
		expect(mod.getServerApiKey("deepseek")).toBe("ds-secret");
		// A provider with no key set resolves to undefined (not "").
		expect(mod.getServerApiKey("anthropic")).toBeUndefined();
	});

	it("getServerApiKey is case-insensitive on the provider id", async () => {
		process.env.ZAI_API_KEY = "zai-secret";
		vi.resetModules();
		const mod = await import("../src/server/config.js");
		expect(mod.getServerApiKey("ZAI")).toBe("zai-secret");
		expect(mod.getServerApiKey("zai")).toBe("zai-secret");
	});
});
