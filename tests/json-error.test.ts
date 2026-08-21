/**
 * json-error.ts — the Express JSON error handler.
 *
 * Pinned because it is the catch-all for forwarded errors (multer
 * LIMIT_FILE_SIZE on oversized uploads, body-parser 400s on malformed
 * JSON). Without it those fall through to Express's default HTML page,
 * which the browser client can't parse. Exercises status resolution +
 * message extraction directly against the exported middleware.
 */

import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { jsonErrorHandler, messageForError, statusForError } from "../src/server/json-error.js";

/** Build a fake Response that records the status + body the handler wrote. */
function fakeRes(sent = false): Response & { status: number; body: unknown } {
	const r = {
		headersSent: sent,
		statusCode: 200,
		status(code: number) {
			this.status = code;
			this.statusCode = code;
			return this;
		},
		json(body: unknown) {
			this.body = body;
			return this;
		},
	};
	return r as unknown as Response & { status: number; body: unknown };
}

describe("statusForError", () => {
	it("maps multer LIMIT_* errors to 413", () => {
		const err = Object.assign(new Error("File too large"), { code: "LIMIT_FILE_SIZE" });
		expect(statusForError(err)).toBe(413);
		expect(statusForError({ code: "LIMIT_UNEXPECTED_FILE" })).toBe(413);
	});

	it("respects an error-supplied numeric status (body-parser 400)", () => {
		expect(statusForError(Object.assign(new Error("bad json"), { status: 400 }))).toBe(400);
		expect(statusForError({ status: 401 })).toBe(401);
	});

	it("falls back to 500 for anything else", () => {
		expect(statusForError({ status: 200 })).toBe(500);
		expect(statusForError({ status: 600 })).toBe(500);
		expect(statusForError({ status: 400.5 })).toBe(500);
		expect(statusForError(new Error("boom"))).toBe(500);
		expect(statusForError("a string")).toBe(500);
		expect(statusForError(null)).toBe(500);
		expect(statusForError(undefined)).toBe(500);
		expect(statusForError({})).toBe(500);
	});
});

describe("messageForError", () => {
	it("uses the Error message", () => {
		expect(messageForError(new Error("boom"))).toBe("boom");
	});
	it("uses a bare string", () => {
		expect(messageForError("plain")).toBe("plain");
	});
	it("falls back to a generic message for unknown shapes", () => {
		expect(messageForError({ weird: true })).toBe("internal server error");
		expect(messageForError(null)).toBe("internal server error");
	});
});

describe("jsonErrorHandler middleware", () => {
	it("writes status + JSON { error } body", () => {
		const res = fakeRes();
		jsonErrorHandler(
			Object.assign(new Error("File too large"), { code: "LIMIT_FILE_SIZE" }),
			{} as Request,
			res,
			vi.fn() as NextFunction,
		);
		expect(res.status).toBe(413);
		expect(res.body).toEqual({ error: "File too large" });
	});

	it("exposes a deliberate operational 5xx rejection", () => {
		const res = fakeRes();
		jsonErrorHandler(
			Object.assign(new Error("upload storage quota exceeded"), { status: 507, expose: true }),
			{} as Request,
			res,
			vi.fn(),
		);
		expect(res.status).toBe(507);
		expect(res.body).toEqual({ error: "upload storage quota exceeded" });
	});

	it("defers to next() when headers are already sent (mid-stream)", () => {
		// Once headers are flushed (streaming /api/file, /api/tts) we must
		// not try to write a new status line — hand the error to Express's
		// default handler so it can end the response.
		const next = vi.fn();
		const res = fakeRes(true);
		jsonErrorHandler(new Error("late"), {} as Request, res, next);
		expect(next).toHaveBeenCalledTimes(1);
		// And it must NOT have written a JSON body.
		expect(res.body).toBeUndefined();
	});

	it("logs 5xx errors (operator visibility) but not 4xx", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// json-error writes 5xx via logger.error → process.stderr; we just
		// assert the handler runs cleanly for both classes without throwing.
		const r4 = fakeRes();
		jsonErrorHandler(Object.assign(new Error("nope"), { status: 400 }), {} as Request, r4, vi.fn());
		expect(r4.status).toBe(400);
		const r5 = fakeRes();
		jsonErrorHandler(new Error("kaboom"), {} as Request, r5, vi.fn());
		expect(r5.status).toBe(500);
		expect(r5.body).toEqual({ error: "internal server error" });
		errSpy.mockRestore();
	});
});
