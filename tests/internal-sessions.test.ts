import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { createInternalSessionsRouter } = await import("../src/server/internal-sessions.js");
const { config } = await import("../src/server/config.js");

let server: Server;
let base = "";

beforeAll(async () => {
	const app = express();
	app.use(express.json());
	app.use("/api/internal", createInternalSessionsRouter());
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (addr && typeof addr === "object") base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function post(path: string, body: unknown, token = config.internalToken) {
	return fetch(`${base}/api/internal${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("/api/internal", () => {
	it("hides itself from requests without the pi children's token", async () => {
		expect((await post("/sessions", {}, "wrong")).status).toBe(404);
		expect((await fetch(`${base}/api/internal/sessions`, { method: "POST" })).status).toBe(404);
	});

	it("refuses a folder that does not exist", async () => {
		const res = await post("/sessions", {
			cwd: "/no/such/folder",
			provider: "openai",
			modelId: "gpt",
			thinkingLevel: "high",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "cwd must be an existing absolute folder" });
	});

	it("reports an unknown chat instead of starting one", async () => {
		const res = await post("/sessions/no-such-session/prompt", {
			message: "hi",
			provider: "openai",
			modelId: "gpt",
		});
		expect(res.status).toBe(404);
	});
});
