import { describe, expect, it } from "vitest";
import veniceNoSystemPrompt from "../extensions/venice-no-system-prompt/index.js";

type Handler = (event: { payload: unknown }, ctx: { model?: { provider: string } }) => unknown;

function handler(): Handler {
	let registered: Handler | undefined;
	veniceNoSystemPrompt({
		on(event: string, h: Handler) {
			if (event === "before_provider_request") registered = h;
		},
	} as never);
	if (!registered) throw new Error("extension did not register before_provider_request");
	return registered;
}

const venice = { model: { provider: "venice" } };

describe("venice-no-system-prompt", () => {
	it("turns off Venice's system prompt and keeps the other venice_parameters", () => {
		const payload = { model: "m", venice_parameters: { enable_web_search: "auto" } };
		expect(handler()({ payload }, venice)).toEqual({
			model: "m",
			venice_parameters: { enable_web_search: "auto", include_venice_system_prompt: false },
		});
	});

	it("adds venice_parameters when the request has none", () => {
		expect(handler()({ payload: { model: "m" } }, venice)).toEqual({
			model: "m",
			venice_parameters: { include_venice_system_prompt: false },
		});
	});

	it("leaves other providers and non-object payloads alone", () => {
		expect(
			handler()({ payload: { model: "m" } }, { model: { provider: "openai" } }),
		).toBeUndefined();
		expect(handler()({ payload: { model: "m" } }, {})).toBeUndefined();
		expect(handler()({ payload: null }, venice)).toBeUndefined();
		expect(handler()({ payload: [1] }, venice)).toBeUndefined();
	});
});
