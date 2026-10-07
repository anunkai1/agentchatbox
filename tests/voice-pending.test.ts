import { describe, expect, it } from "vitest";
import {
	isVoiceFailureNotice,
	pendingReplyText,
	voiceableReplyStamp,
} from "../src/client/voice-pending.js";

describe("pendingReplyText", () => {
	it("plays the variant the pending request asked for", () => {
		expect(pendingReplyText({ variant: "medium", hint: null }, { medium: " spoken " })).toBe(
			"spoken",
		);
	});

	it("stays silent when nothing is pending (cancelled, or voice mode off)", () => {
		expect(pendingReplyText({ variant: null, hint: null }, { long: "words" })).toBeNull();
	});

	it("ignores a reply carrying a different variant", () => {
		expect(pendingReplyText({ variant: "short", hint: null }, { long: "words" })).toBeNull();
		expect(pendingReplyText({ variant: "short", hint: null }, { short: "  " })).toBeNull();
	});

	it("ignores a reply the extension tied to another row", () => {
		expect(
			pendingReplyText({ variant: "long", hint: "row a" }, { long: "words", match: "row b" }),
		).toBeNull();
		expect(
			pendingReplyText({ variant: "long", hint: null }, { long: "words", match: "row b" }),
		).toBeNull();
		expect(
			pendingReplyText({ variant: "long", hint: "row a" }, { long: "words", match: "row a" }),
		).toBe("words");
		// No echoed hint (the extension could not match it): still this press's reply.
		expect(pendingReplyText({ variant: "long", hint: "row a" }, { long: "words" })).toBe("words");
	});
});

describe("isVoiceFailureNotice", () => {
	it("matches the extension's failure notices", () => {
		expect(isVoiceFailureNotice("Voice reply: model produced no output.")).toBe(true);
		expect(isVoiceFailureNotice("Voice reply failed: boom")).toBe(true);
		expect(isVoiceFailureNotice("No assistant message to voice yet.")).toBe(true);
	});

	it("does not match the model-fallback warning that precedes a successful reply", () => {
		expect(
			isVoiceFailureNotice("Voice model venice/x (429) failed; used a/b instead. Log: ~/.pi/..."),
		).toBe(false);
		expect(isVoiceFailureNotice("Image model changed")).toBe(false);
	});
});

describe("voiceableReplyStamp", () => {
	const reply = (extra: object = {}) => ({
		role: "assistant",
		timestamp: 42,
		content: [{ type: "text", text: "hello" }],
		...extra,
	});

	it("returns the last assistant reply's timestamp", () => {
		expect(voiceableReplyStamp([{ role: "user" }, reply()])).toBe(42);
	});

	it("returns null for errored, aborted or text-less replies", () => {
		expect(voiceableReplyStamp([reply({ stopReason: "error" })])).toBeNull();
		expect(voiceableReplyStamp([reply({ stopReason: "aborted" })])).toBeNull();
		expect(voiceableReplyStamp([reply({ content: [{ type: "text", text: "  " }] })])).toBeNull();
		expect(voiceableReplyStamp("nope")).toBeNull();
	});
});
