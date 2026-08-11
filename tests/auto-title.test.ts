import { describe, expect, it } from "vitest";
import {
	buildTitlePrompt,
	cleanGeneratedTitle,
	collectTitleSeed,
	hasAutoTitleMarker,
	hasConversation,
} from "../extensions/auto-title/lib.js";

describe("ACB auto-title helpers", () => {
	it("collects the first user request and latest successful assistant reply", () => {
		const seed = collectTitleSeed([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "status" }] } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Checking…" }] },
			},
			{ type: "message", message: { role: "toolResult", content: "ignored" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "MavaliETH is healthy and the strategy is armed." }],
				},
			},
		]);
		expect(seed).toEqual({
			user: "status",
			assistant: "MavaliETH is healthy and the strategy is armed.",
		});
	});

	it("ignores failed assistant messages and waits for usable text", () => {
		expect(
			collectTitleSeed([
				{ type: "message", message: { role: "user", content: "help" } },
				{
					type: "message",
					message: {
						role: "assistant",
						stopReason: "error",
						content: [{ type: "text", text: "bad" }],
					},
				},
			]),
		).toBeNull();
	});

	it("detects existing conversations and durable attempt markers", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "hello" } },
			{ type: "custom", customType: "acb-auto-title-v1" },
		];
		expect(hasConversation(entries)).toBe(true);
		expect(hasAutoTitleMarker(entries, "acb-auto-title-v1")).toBe(true);
	});

	it("cleans labels, markdown, quotes, emoji, punctuation, and excess words", () => {
		expect(cleanGeneratedTitle("## Title: “Reviewing ACB GUI Improvements” 🚀.")).toBe(
			"Reviewing ACB GUI Improvements",
		);
		expect(cleanGeneratedTitle("one two three four five six seven eight nine")).toBe(
			"one two three four five six seven",
		);
	});

	it("builds a bounded title-only prompt with workspace context", () => {
		const prompt = buildTitlePrompt(
			{ user: "status", assistant: "The trading service is healthy." },
			"mavalieth",
		);
		expect(prompt).toContain("3 to 7 words");
		expect(prompt).toContain("Workspace: mavalieth");
		expect(prompt).toContain("<user_request>\nstatus\n</user_request>");
	});
});
