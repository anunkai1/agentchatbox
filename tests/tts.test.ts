/**
 * tts.ts — request validation helper.
 *
 * parseTtsBody is shared by POST /api/tts and POST /api/tts/stream. It used
 * to be copy-pasted in both handlers (which drifts); these tests pin the one
 * canonical implementation: empty rejection, length cap, voice defaulting,
 * and type-coercion of weird inputs.
 */

import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { parseTtsBody } from "../src/server/tts.js";

/** Build a minimal Request whose only field parseTtsBody touches is `.body`. */
function req(body: unknown): Request {
	return { body } as Request;
}

describe("parseTtsBody", () => {
	it("rejects a missing/empty text field with 400", () => {
		expect(parseTtsBody(req(undefined))).toEqual({
			error: "no text (field name: 'text')",
			status: 400,
		});
		expect(parseTtsBody(req({}))).toEqual({
			error: "no text (field name: 'text')",
			status: 400,
		});
		expect(parseTtsBody(req({ text: "   \n\t " }))).toEqual({
			error: "no text (field name: 'text')",
			status: 400,
		});
	});

	it("rejects a non-string text (number / null) as 400, not a crash", () => {
		expect(parseTtsBody(req({ text: 42 }))).toMatchObject({ status: 400 });
		expect(parseTtsBody(req({ text: null }))).toMatchObject({ status: 400 });
	});

	it("accepts normal text and returns it with voice undefined when absent", () => {
		const out = parseTtsBody(req({ text: "hello world" }));
		expect(out).toEqual({ text: "hello world", voice: undefined });
	});

	it("keeps whitespace-only text rejected but preserves real text as-is", () => {
		const out = parseTtsBody(req({ text: "  padded  " }));
		expect("text" in out && out.text).toBe("  padded  "); // not trimmed
	});

	it("returns the voice when a non-empty string is supplied", () => {
		const out = parseTtsBody(req({ text: "hi", voice: "af_heart" }));
		expect(out).toEqual({ text: "hi", voice: "af_heart" });
	});

	it("treats an empty-string voice as 'unset' (undefined)", () => {
		const out = parseTtsBody(req({ text: "hi", voice: "" }));
		expect("voice" in out && out.voice).toBeUndefined();
	});

	it("rejects text over the 30 000-char cap with 413", () => {
		const long = "a".repeat(30_001);
		expect(parseTtsBody(req({ text: long }))).toEqual({
			error: "text too long (max 30000 chars)",
			status: 413,
		});
	});

	it("accepts text exactly at the 30 000-char cap", () => {
		const edge = "a".repeat(30_000);
		const out = parseTtsBody(req({ text: edge }));
		expect("text" in out && out.text.length).toBe(30_000);
	});
});
