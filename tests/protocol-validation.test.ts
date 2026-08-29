import { describe, expect, it } from "vitest";
import { ProtocolError, parseClientMessage } from "../src/server/protocol-validation.js";

describe("parseClientMessage", () => {
	it("accepts and clones a bounded init without trusting a cwd", () => {
		const parsed = parseClientMessage({
			type: "init",
			provider: "venice",
			modelId: "openai/gpt-5",
			thinkingLevel: "high",
			cwd: "/etc",
		});
		expect(parsed).toEqual({
			type: "init",
			provider: "venice",
			modelId: "openai/gpt-5",
			thinkingLevel: "high",
		});
	});

	it("rejects unknown messages and invalid thinking levels", () => {
		expect(() => parseClientMessage({ type: "shell", command: "id" })).toThrow(ProtocolError);
		expect(() => parseClientMessage({ type: "setThinking", level: "unlimited" })).toThrow(
			"invalid thinking level",
		);
	});

	it("accepts bounded compact instructions and rejects oversized/non-string values", () => {
		expect(parseClientMessage({ type: "compact" })).toEqual({ type: "compact" });
		expect(
			parseClientMessage({ type: "compact", customInstructions: "retain error details" }),
		).toEqual({ type: "compact", customInstructions: "retain error details" });
		expect(() =>
			parseClientMessage({ type: "compact", customInstructions: "x".repeat(2_001) }),
		).toThrow("customInstructions");
		expect(() =>
			parseClientMessage({ type: "compact", customInstructions: { unsafe: true } }),
		).toThrow("customInstructions");
	});

	it("accepts a small raster image and rejects SVG/base64 abuse", () => {
		expect(
			parseClientMessage({
				type: "prompt",
				text: "look",
				images: [{ data: "AQ==", mimeType: "image/png" }],
			}),
		).toMatchObject({ type: "prompt", text: "look" });
		expect(() =>
			parseClientMessage({
				type: "prompt",
				text: "look",
				images: [{ data: "AQ==", mimeType: "image/svg+xml" }],
			}),
		).toThrow("not supported");
		expect(() =>
			parseClientMessage({
				type: "prompt",
				text: "look",
				images: [{ data: "not base64!", mimeType: "image/png" }],
			}),
		).toThrow("base64");
	});

	it("bounds names, project arrays, and fork counts", () => {
		expect(() => parseClientMessage({ type: "renameSession", name: "x".repeat(501) })).toThrow();
		expect(() =>
			parseClientMessage({
				type: "reorderProjects",
				order: Array.from({ length: 101 }, () => "abcdef"),
			}),
		).toThrow();
		expect(() =>
			parseClientMessage({ type: "forkSession", sessionId: "abc", messageCount: -1 }),
		).toThrow();
	});
});
