/**
 * providers.ts — provider metadata single source of truth.
 *
 * Locks in the consolidation (issue #4 of the review): both config.ts
 * (which env var to READ) and pi-process.ts (which env var to INJECT
 * into the pi child) must resolve to the SAME name for each provider.
 * These tests guard `providerApiKeyEnvVar` directly so a rename or
 * drift fails loudly instead of silently breaking a provider.
 */

import { describe, expect, it } from "vitest";
import { providerApiKeyEnvVar } from "../src/server/providers.js";

describe("providerApiKeyEnvVar", () => {
	it("returns pi's canonical env-var name for known providers", () => {
		// The names pi-ai itself reads (mirrors getApiKeyEnvVars).
		expect(providerApiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
		expect(providerApiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
		expect(providerApiKeyEnvVar("deepseek")).toBe("DEEPSEEK_API_KEY");
		expect(providerApiKeyEnvVar("zai")).toBe("ZAI_API_KEY");
		expect(providerApiKeyEnvVar("kimi-coding")).toBe("KIMI_API_KEY");
		expect(providerApiKeyEnvVar("opencode")).toBe("OPENCODE_API_KEY");
	});

	it("uses MINIMAX_API_KEY (all caps), NOT the legacy MiniMax_API_KEY", () => {
		// Regression: config.ts used to read MiniMax_API_KEY while
		// pi-process.ts injected MINIMAX_API_KEY. The two maps were
		// merged; the canonical name is now all-caps everywhere.
		expect(providerApiKeyEnvVar("minimax")).toBe("MINIMAX_API_KEY");
		expect(providerApiKeyEnvVar("minimax")).not.toBe("MiniMax_API_KEY");
	});

	it("uses pi's names for the providers that previously diverged", () => {
		// google → GEMINI_API_KEY (not GOOGLE_API_KEY)
		expect(providerApiKeyEnvVar("google")).toBe("GEMINI_API_KEY");
		// huggingface → HF_TOKEN (not HUGGINGFACE_API_KEY)
		expect(providerApiKeyEnvVar("huggingface")).toBe("HF_TOKEN");
		// vercel-ai-gateway → AI_GATEWAY_API_KEY (not VERCEL_AI_GATEWAY_API_KEY)
		expect(providerApiKeyEnvVar("vercel-ai-gateway")).toBe("AI_GATEWAY_API_KEY");
	});

	it("falls back to <PROVIDER>_API_KEY for unknown providers", () => {
		expect(providerApiKeyEnvVar("newprovider")).toBe("NEWPROVIDER_API_KEY");
		expect(providerApiKeyEnvVar("some-startup")).toBe("SOME-STARTUP_API_KEY");
	});
});
