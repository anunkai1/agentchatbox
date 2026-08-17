import { describe, expect, it } from "vitest";
import { localAiLabel, parseLocalAiState } from "../extensions/local-ai/lib.js";

describe("local AI status", () => {
	it("recognises the Qwen backend", () => {
		expect(parseLocalAiState("Qwen API  : ready\nFLUX API  : unavailable")).toBe("qwen");
		expect(localAiLabel("qwen")).toBe("Qwen active");
	});

	it("recognises the image backend", () => {
		expect(parseLocalAiState("Qwen API  : unavailable\nFLUX API  : ready")).toBe("image");
	});

	it("distinguishes stopped and unreachable server4", () => {
		expect(parseLocalAiState("Qwen API  : unavailable\nFLUX API  : unavailable")).toBe("stopped");
		expect(parseLocalAiState("ssh: connect to host server4 failed", 255)).toBe("offline");
	});
});
