/**
 * async-handler.ts — the async route wrapper.
 *
 * Express 4 does NOT auto-catch rejected promises from async handlers.
 * asyncHandler turns them into next(err) so the JSON error handler can
 * respond (and the process doesn't crash on an unhandledRejection).
 */

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asyncHandler } from "../src/server/async-handler.js";
import { jsonErrorHandler } from "../src/server/json-error.js";

/**
 * Build a tiny Express app whose single route is the handler under test,
 * backed by the jsonErrorHandler. Returns a base URL to hit it.
 */
async function appFor(route: express.RequestHandler): Promise<{
	base: string;
	close: () => Promise<void>;
}> {
	const app = express();
	app.get("/", route);
	app.use(jsonErrorHandler);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((r) => server.once("listening", () => r()));
	const { port } = server.address() as { address: string; port: number };
	return {
		base: `http://127.0.0.1:${port}`,
		close: () => new Promise((r) => server.close(() => r())),
	};
}

describe("asyncHandler", () => {
	let app: { base: string; close: () => Promise<void> } | null = null;
	beforeEach(() => {
		app = null;
	});
	afterEach(async () => {
		if (app) await app.close();
	});

	it("passes through when the handler resolves normally", async () => {
		app = await appFor(
			asyncHandler(async (_req, res) => {
				res.json({ ok: true });
			}),
		);
		const r = await fetch(app.base);
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ ok: true });
	});

	it("forwards a thrown error to next() → JSON { error }, status 500", async () => {
		app = await appFor(
			asyncHandler(async () => {
				throw new Error("boom");
			}),
		);
		const r = await fetch(app.base);
		// Default status for an unannotated error is 500.
		expect(r.status).toBe(500);
		expect(await r.json()).toEqual({ error: "internal server error" });
	});

	it("forwards a rejected promise (await-ed failure) too", async () => {
		app = await appFor(
			asyncHandler(async (_req, res) => {
				await Promise.reject(new Error("async fail"));
				res.json({ unreachable: true });
			}),
		);
		const r = await fetch(app.base);
		expect(r.status).toBe(500);
		expect(await r.json()).toEqual({ error: "internal server error" });
	});

	it("respects an error-supplied status (e.g. 400)", async () => {
		app = await appFor(
			asyncHandler(async () => {
				throw Object.assign(new Error("bad request"), { status: 400 });
			}),
		);
		const r = await fetch(app.base);
		expect(r.status).toBe(400);
		expect(await r.json()).toEqual({ error: "bad request" });
	});
});
