import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The registry owns every pi child; these tests check what the routes ask of it.
const registry = vi.hoisted(() => ({
	acquire: vi.fn(),
	liveFor: vi.fn(),
	waitUntilReady: vi.fn(),
	kill: vi.fn(),
	releaseUnattached: vi.fn(),
}));
const broadcastSessions = vi.hoisted(() => vi.fn());
vi.mock("../src/server/session-registry.js", () => ({ registry }));
vi.mock("../src/server/chat.js", () => ({ broadcastSessions }));
vi.mock("../src/server/projects.js", () => ({ listProjects: () => [] }));

const { createInternalSessionsRouter } = await import("../src/server/internal-sessions.js");
const { config } = await import("../src/server/config.js");

let server: Server;
let base = "";
let root = "";
let folder = "";

beforeAll(async () => {
	// A hermetic session store holding one closed chat.
	root = mkdtempSync(join(tmpdir(), "acb-internal-"));
	folder = mkdtempSync(join(tmpdir(), "acb-internal-cwd-"));
	process.env.PI_CODING_AGENT_SESSION_DIR = root;
	mkdirSync(join(root, "--closed--"));
	writeFileSync(
		join(root, "--closed--", "closed.jsonl"),
		`${JSON.stringify({ type: "session", id: "closed-1", cwd: folder })}\n`,
	);
	const app = express();
	app.use(express.json());
	app.use("/api/internal", createInternalSessionsRouter());
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (addr && typeof addr === "object") base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
	rmSync(root, { recursive: true, force: true });
	rmSync(folder, { recursive: true, force: true });
});

beforeEach(() => {
	for (const fn of Object.values(registry)) fn.mockReset();
	broadcastSessions.mockReset();
	registry.waitUntilReady.mockResolvedValue(undefined);
});

function post(path: string, body: unknown, token = config.internalToken) {
	return fetch(`${base}/api/internal${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function liveSession(state: { streaming?: boolean; busy?: boolean } = {}) {
	return { sessionId: "live-1", streaming: false, busy: false, ...state, pi: { send: vi.fn() } };
}

const MODEL = { provider: "openai", modelId: "gpt", thinkingLevel: "high" };

describe("/api/internal", () => {
	it("hides itself from requests without the pi children's token", async () => {
		expect((await post("/sessions", {}, "wrong")).status).toBe(404);
		expect((await fetch(`${base}/api/internal/sessions`, { method: "POST" })).status).toBe(404);
	});

	it("refuses a folder that does not exist", async () => {
		const res = await post("/sessions", { cwd: "/no/such/folder", ...MODEL });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "cwd must be an existing absolute folder" });
	});

	it("starts a chat that the idle reaper can clean up and every sidebar sees", async () => {
		const session = liveSession({ sessionId: "new-1" } as never);
		registry.acquire.mockReturnValue(session);
		const res = await post("/sessions", { cwd: folder, ...MODEL });
		expect(await res.json()).toEqual({ sessionId: "new-1" });
		expect(registry.acquire).toHaveBeenCalledWith({ ...MODEL, cwd: folder });
		expect(registry.waitUntilReady).toHaveBeenCalledWith(session);
		expect(registry.releaseUnattached).toHaveBeenCalledWith(session);
		expect(broadcastSessions).toHaveBeenCalled();
	});

	it("kills a new chat that never becomes ready and passes the reason on", async () => {
		const session = liveSession();
		registry.acquire.mockReturnValue(session);
		registry.waitUntilReady.mockRejectedValue(new Error("pi exited before ready"));
		const res = await post("/sessions", { cwd: folder, ...MODEL });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "pi exited before ready" });
		expect(registry.kill).toHaveBeenCalledWith(session);
		expect(broadcastSessions).not.toHaveBeenCalled();
	});

	it("queues a message for a busy chat as a follow-up and sends it straight to an idle one", async () => {
		const busy = liveSession({ streaming: true });
		registry.liveFor.mockReturnValue(busy);
		expect((await post("/sessions/live-1/prompt", { message: "more", ...MODEL })).status).toBe(200);
		expect(busy.pi.send).toHaveBeenCalledWith({
			type: "prompt",
			message: "more",
			streamingBehavior: "followUp",
		});

		const idle = liveSession();
		registry.liveFor.mockReturnValue(idle);
		await post("/sessions/live-1/prompt", { message: "/delegate report w1", ...MODEL });
		expect(idle.pi.send).toHaveBeenCalledWith({ type: "prompt", message: "/delegate report w1" });
		expect(registry.acquire).not.toHaveBeenCalled();
		expect(registry.releaseUnattached).toHaveBeenCalledWith(idle);
	});

	it("resumes a closed chat in its own folder with the given model before prompting it", async () => {
		const resumed = liveSession();
		registry.liveFor.mockReturnValue(null);
		registry.acquire.mockReturnValue(resumed);
		const res = await post("/sessions/closed-1/prompt", { message: "report", ...MODEL });
		expect(res.status).toBe(200);
		expect(registry.acquire).toHaveBeenCalledWith({ ...MODEL, sessionId: "closed-1", cwd: folder });
		expect(registry.waitUntilReady).toHaveBeenCalledWith(resumed);
		expect(resumed.pi.send).toHaveBeenCalledWith({ type: "prompt", message: "report" });
		expect(registry.releaseUnattached).toHaveBeenCalledWith(resumed);
	});

	it("reports an unknown chat instead of starting one", async () => {
		registry.liveFor.mockReturnValue(null);
		const res = await post("/sessions/no-such-session/prompt", { message: "hi", ...MODEL });
		expect(res.status).toBe(404);
		expect(registry.acquire).not.toHaveBeenCalled();
	});
});
