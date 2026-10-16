import { describe, expect, it } from "vitest";
import { keepOpenAIModel } from "../extensions/openai-models/index.js";

describe("keepOpenAIModel", () => {
	it("keeps GPT-6 and later", () => {
		for (const id of ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-7"]) {
			expect(keepOpenAIModel(id)).toBe(true);
		}
	});

	it("drops older and ChatGPT-refused models", () => {
		for (const id of [
			"gpt-4o",
			"gpt-5.5-pro",
			"o3",
			"gpt-daybreak-blue-latest",
			"gpt-realtime-2.1",
		]) {
			expect(keepOpenAIModel(id)).toBe(false);
		}
	});
});
