import { describe, expect, it } from "vitest";
import { supportedThinkingLevels } from "../src/shared/thinking.js";

describe("supportedThinkingLevels", () => {
	it("returns only off for non-reasoning models", () => {
		expect(supportedThinkingLevels(false)).toEqual(["off"]);
	});

	it("keeps standard levels by default but does not invent extended levels", () => {
		expect(supportedThinkingLevels(true)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("honors DeepSeek-style sparse level maps", () => {
		expect(
			supportedThinkingLevels(true, {
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				max: "max",
			}),
		).toEqual(["off", "high", "max"]);
	});

	it("exposes every GPT-style level when xhigh and max are mapped", () => {
		expect(
			supportedThinkingLevels(true, {
				off: "none",
				minimal: "low",
				xhigh: "xhigh",
				max: "max",
			}),
		).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("can hide off for always-thinking models", () => {
		expect(supportedThinkingLevels(true, { off: null, high: "high", max: "max" })).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"max",
		]);
	});
});
