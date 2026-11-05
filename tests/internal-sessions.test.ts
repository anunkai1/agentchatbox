import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordTransportStop, transportStoppedSince } from "../src/shared/transport-state.js";

// The registry owns every pi child; these tests check what the routes ask of it.
const registry = vi.hoisted(() => ({
	acquire: vi.fn(),
	liveFor: vi.fn(),
	waitUntilReady: vi.fn(),
	kill: vi.fn(),
	releaseUnattached: vi.fn(),
	statusSnapshot: vi.fn(),
	terminateById: vi.fn(),
}));
const broadcastSessions = vi.hoisted(() => vi.fn());
vi.mock("../src/server/session-registry.js", () => ({
	registry,
	isWorking: (session: {
		busy?: boolean;
		streaming?: boolean;
		statusFrames?: Map<string, unknown>;
	}) => session.busy || session.streaming || session.statusFrames?.has("claude-progress"),
}));
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
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
	rmSync(folder, { recursive: true, force: true });
});

beforeEach(() => {
	vi.stubEnv("ACB_TRANSPORT_STATE_DIR", mkdtempSync(join(root, "transport-")));
	for (const fn of Object.values(registry)) fn.mockReset();
	broadcastSessions.mockReset();
	registry.waitUntilReady.mockResolvedValue(undefined);
	registry.statusSnapshot.mockReturnValue([]);
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
		const resumed = liveSession({ sessionId: "closed-1" } as never);
		registry.liveFor.mockReturnValueOnce(null).mockReturnValue(resumed);
		registry.acquire.mockReturnValue(resumed);
		const res = await post("/sessions/closed-1/prompt", { message: "report", ...MODEL });
		expect(res.status).toBe(200);
		expect(registry.acquire).toHaveBeenCalledWith({ ...MODEL, sessionId: "closed-1", cwd: folder });
		expect(registry.waitUntilReady).toHaveBeenCalledWith(resumed);
		expect(resumed.pi.send).toHaveBeenCalledWith({ type: "prompt", message: "report" });
		expect(registry.releaseUnattached).toHaveBeenCalledWith(resumed);
	});

	it("exposes the authenticated process incarnation and live sessions", async () => {
		const response = await fetch(`${base}/api/internal/sessions`, {
			headers: { authorization: `Bearer ${config.internalToken}` },
		});
		expect(await response.json()).toEqual({ bootId: config.bootId, sessions: [] });
		expect((await fetch(`${base}/api/internal/sessions`)).status).toBe(404);
	});

	it("deduplicates a conditional continuation across repeated requests", async () => {
		const resumed = liveSession({ sessionId: "closed-1" } as never);
		registry.liveFor.mockReturnValueOnce(null).mockReturnValue(resumed);
		registry.acquire.mockReturnValue(resumed);
		const body = {
			message: "/delegate recover closed-1",
			...MODEL,
			requestId: "recovery-route-1",
			onlyIfNotLive: true,
			notStoppedSince: Date.now(),
		};
		const first = await post("/sessions/closed-1/prompt", body);
		expect(await first.json()).toMatchObject({ bootId: config.bootId, delivery: "submitted" });
		const duplicate = await post("/sessions/closed-1/prompt", body);
		expect(await duplicate.json()).toMatchObject({ delivery: "submitted" });
		expect(resumed.pi.send).toHaveBeenCalledTimes(1);
		expect(registry.acquire).toHaveBeenCalledTimes(1);
	});

	it("never queues an automatic continuation behind a live session", async () => {
		const live = liveSession({ streaming: true });
		registry.liveFor.mockReturnValue(live);
		const response = await post("/sessions/live-1/prompt", {
			message: "continue",
			...MODEL,
			requestId: "recovery-live-1",
			onlyIfNotLive: true,
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "session already live" });
		expect(live.pi.send).not.toHaveBeenCalled();
	});

	it("allows deduplicated idle-only recovery into a browser-reattached chat", async () => {
		const idle = { ...liveSession(), ws: {} };
		registry.liveFor.mockReturnValue(idle);
		const body = {
			message: "/recovery resume owner-1",
			...MODEL,
			requestId: "idle-recovery-1",
			onlyIfIdle: true,
		};
		expect((await post("/sessions/live-1/prompt", body)).status).toBe(200);
		expect((await post("/sessions/live-1/prompt", body)).status).toBe(200);
		expect(idle.pi.send).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ busy: true },
		{ streaming: true },
		{ statusFrames: new Map([["claude-progress", {}]]) },
		{ compaction: "manual" },
	])("never queues idle-only recovery behind active work: %o", async (activity) => {
		const live = { ...liveSession(), ...activity };
		registry.liveFor.mockReturnValue(live);
		const response = await post("/sessions/live-1/prompt", {
			message: "continue",
			...MODEL,
			requestId: "idle-active-1",
			onlyIfIdle: true,
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "session already active" });
		expect(live.pi.send).not.toHaveBeenCalled();
	});

	it("rechecks activity after idle-only startup and requires a durable request ID", async () => {
		const live = liveSession();
		registry.liveFor.mockReturnValue(live);
		expect(
			(await post("/sessions/live-1/prompt", { message: "continue", ...MODEL, onlyIfIdle: true }))
				.status,
		).toBe(400);
		registry.waitUntilReady.mockImplementation(async () => {
			live.busy = true;
		});
		expect(
			(
				await post("/sessions/live-1/prompt", {
					message: "continue",
					...MODEL,
					onlyIfIdle: true,
					requestId: "idle-race-1",
				})
			).status,
		).toBe(503);
		expect(live.pi.send).not.toHaveBeenCalled();
	});

	it("rechecks cancellation after session startup before forwarding the command", async () => {
		const resumed = liveSession({ sessionId: "closed-1" } as never);
		registry.liveFor.mockReturnValueOnce(null).mockReturnValue(resumed);
		registry.acquire.mockReturnValue(resumed);
		registry.waitUntilReady.mockImplementation(async () => {
			recordTransportStop(`http://127.0.0.1:${config.port}`, "closed-1");
		});
		const response = await post("/sessions/closed-1/prompt", {
			message: "continue",
			...MODEL,
			requestId: "recovery-stop-1",
			onlyIfNotLive: true,
			notStoppedSince: Date.now() - 1000,
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "session explicitly stopped" });
		expect(resumed.pi.send).not.toHaveBeenCalled();
	});

	it("stops a process group with a durable cancellation marker and never resumes it", async () => {
		const since = Date.now() - 1000;
		registry.terminateById.mockResolvedValue(liveSession());
		expect((await post("/sessions/live-1/stop", {})).status).toBe(200);
		expect(registry.terminateById).toHaveBeenCalledWith("live-1");
		expect(transportStoppedSince(`http://127.0.0.1:${config.port}`, "live-1", since)).toBe(true);
		registry.terminateById.mockResolvedValue(null);
		expect(await (await post("/sessions/closed-1/stop", {})).json()).toEqual({ ok: true, live: false });
		expect(registry.acquire).not.toHaveBeenCalled();
		expect((await post("/sessions/live-1/stop", {}, "wrong")).status).toBe(404);
	});

	it("reports an unknown chat instead of starting one", async () => {
		registry.liveFor.mockReturnValue(null);
		const res = await post("/sessions/no-such-session/prompt", { message: "hi", ...MODEL });
		expect(res.status).toBe(404);
		expect(registry.acquire).not.toHaveBeenCalled();
	});
});
