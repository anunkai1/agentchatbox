/**
 * chat.ts — WebSocket ↔ `pi --mode rpc` pipe.
 *
 * The server no longer runs an in-process Agent; it spawns `pi` as a
 * child process and forwards its NDJSON. These tests verify the
 * pipe works end-to-end by pointing PI_BIN at a fake-pi script that
 * emits canned NDJSON. No real LLM key needed.
 *
 * Each test gets its own fake-pi script in a temp file. The
 * server's config is mutated via process.env.PI_BIN before the
 * chat module is imported.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

type AnyMsg = { type: string; [k: string]: unknown };

const ECHO_SCRIPT = `#!/usr/bin/env bash
# Fake pi that responds to any prompt with a canned event stream.
# Reads JSONL commands from stdin, writes one NDJSON line per event.
# Responds to get_state with a canned sessionId — matches real pi
# behavior (rpc mode does NOT emit a "session" line on startup; the
# session id only comes out of get_state's response).
sleep 0.05
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  case "$type" in
    "get_state")
      echo "{\\"type\\":\\"response\\",\\"command\\":\\"get_state\\",\\"success\\":true,\\"data\\":{\\"sessionId\\":\\"test-session-001\\",\\"messageCount\\":0}}"
      ;;
    "prompt")
      echo "{\\"type\\":\\"response\\",\\"command\\":\\"prompt\\",\\"success\\":true}"
      echo '{"type":"agent_start"}'
      echo '{"type":"turn_start"}'
      echo '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1}}'
      echo '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1}}'
      echo '{"type":"message_start","message":{"role":"assistant","content":[],"api":"anthropic-messages","provider":"test","model":"test","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}'
      echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}],"timestamp":2}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}],"api":"anthropic-messages","provider":"test","model":"test","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}'
      echo '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}],"timestamp":2},"toolResults":[]}'
      echo '{"type":"agent_end","messages":[],"willRetry":false}'
      ;;
    "")
      ;;
    *)
      echo "{\\"type\\":\\"response\\",\\"command\\":\\"$type\\",\\"success\\":true}"
      ;;
  esac
done
`;

const ACK_SCRIPT = `#!/usr/bin/env bash
# Fake pi that responds to get_state with a sessionId and acks
# everything else. Used by tests that don't need a full event
# stream (e.g. listSessions is a server-side read; pi is only
# there to satisfy the spawn).
sleep 0.05
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  case "$type" in
    "get_state")
      echo "{\\"type\\":\\"response\\",\\"command\\":\\"get_state\\",\\"success\\":true,\\"data\\":{\\"sessionId\\":\\"test-session-002\\",\\"messageCount\\":0}}"
      ;;
    *)
      echo "{\\"type\\":\\"response\\",\\"command\\":\\"$type\\",\\"success\\":true}"
      ;;
  esac
done
`;

const EXIT_BEFORE_SESSION_SCRIPT = `#!/usr/bin/env bash
# Fake pi that immediately exits (simulates spawn failure or
# the binary not being found).
exit 127
`;

const TRACK_SCRIPT = `#!/usr/bin/env bash
# Fake pi that records every spawn by appending its PID to the file
# named in $AGENTCHATBOX_FAKE_PI_MARKER. Used by the detach/reattach
# tests to prove a reconnect reuses the SAME child (one spawn) rather
# than respawning (two spawns) — the core guarantee of the session
# registry.
if [ -n "\${AGENTCHATBOX_FAKE_PI_MARKER}" ]; then
  echo "$$" >> "\${AGENTCHATBOX_FAKE_PI_MARKER}"
fi
sleep 0.05
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  case "$type" in
    "get_state")
      echo '{"type":"response","command":"get_state","success":true,"data":{"sessionId":"track-session-001","messageCount":0}}'
      ;;
    "")
      ;;
    *)
      echo '{"type":"response","command":"'"$type"'","success":true}'
      ;;
  esac
done
`;

const STEER_RACE_SCRIPT = `#!/usr/bin/env bash
# Fake pi that REFUSES steers (success:false, simulating the agent
# having just gone idle). Used to verify the server forwards
# success:false responses instead of silently dropping them.
# Single-quoted echoes so the JSON is literal (no shell escaping).
sleep 0.05
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  case "$type" in
    "get_state")
      echo '{"type":"response","command":"get_state","success":true,"data":{"sessionId":"race-session-001","messageCount":0}}'
      ;;
    "steer")
      echo '{"type":"response","command":"steer","success":false,"error":"Cannot steer while idle"}'
      ;;
    "prompt")
      echo '{"type":"response","command":"prompt","success":true}'
      echo '{"type":"agent_start"}'
      echo '{"type":"agent_end","messages":[],"willRetry":false}'
      ;;
    "")
      ;;
    *)
      echo "{"type":"response","command":"$type","success":true}"
      ;;
  esac
done
`;

/** Write a fake-pi shell script to a temp file and return its path. */
function makeFakePi(
	behavior: "echo" | "ack" | "exit-before-session" | "steer-race" | "track",
): string {
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	const script = join(dir, "pi");
	const body =
		behavior === "echo"
			? ECHO_SCRIPT
			: behavior === "ack"
				? ACK_SCRIPT
				: behavior === "steer-race"
					? STEER_RACE_SCRIPT
					: behavior === "track"
						? TRACK_SCRIPT
						: EXIT_BEFORE_SESSION_SCRIPT;
	writeFileSync(script, body, { mode: 0o755 });
	return script;
}

let fakePiPath: string | null = null;
let server: HttpServer | null = null;
let port = 0;

beforeEach(async () => {
	// Each test gets a unique fake-pi behavior. Default to "echo".
	fakePiPath = makeFakePi("echo");
	process.env.PI_BIN = fakePiPath;
	process.env.PI_CWD = "/tmp";
	// Server's getServerApiKey reads DEEPSEEK_API_KEY into apiKeys["deepseek"];
	// we need it set so the server passes the gate that fires before spawning
	// `pi`. The fake script doesn't use the key.
	process.env.DEEPSEEK_API_KEY = "test-dummy";
	// Reset the module cache so each test re-reads config (and sees the
	// current PI_BIN / PI_CWD env vars). Without this, vitest's
	// default module cache makes every test after the first spawn
	// `pi` with the env vars from the first test.
	vi.resetModules();

	server = createServer();
	await new Promise<void>((resolve, reject) => {
		server?.listen(0, "127.0.0.1", () => resolve());
		server?.once("error", reject);
	});
	port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
	}
	if (fakePiPath) {
		try {
			rmSync(join(fakePiPath, ".."), { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		fakePiPath = null;
	}
});

/** Connect a WS, register the inbox listener before `open`, return helpers. */
async function connectClient(): Promise<{
	ws: WebSocket;
	inbox: Inbox;
	close: () => void;
}> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat`);
	const inbox = new Inbox(ws);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return { ws, inbox, close: () => ws.close() };
}

class Inbox {
	private readonly out: AnyMsg[] = [];
	constructor(ws: WebSocket) {
		ws.on("message", (raw) => {
			const text = (raw as { toString(): string }).toString();
			try {
				this.out.push(JSON.parse(text) as AnyMsg);
			} catch {
				/* drop */
			}
		});
		ws.on("error", (err) => {
			console.error("TEST ws error:", err.message);
		});
		ws.on("close", (code, reason) => {
			console.error("TEST ws close:", code, reason.toString());
		});
	}
	all(): AnyMsg[] {
		return this.out.slice();
	}
	async waitFor(n: number, timeoutMs = 3000): Promise<AnyMsg[]> {
		const deadline = Date.now() + timeoutMs;
		while (this.out.length < n && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		return this.out.slice();
	}
}

describe("mountChatWs — pi subprocess pipe", () => {
	it("emits ready after the first session line, then forwards pi events", async () => {
		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const { ws, inbox, close } = await connectClient();
		try {
			ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			const ready = await inbox.waitFor(1);
			expect(ready[0]?.type).toBe("ready");
			expect((ready[0] as { modelId?: string }).modelId).toBe("m1");
			expect((ready[0] as { provider?: string }).provider).toBe("deepseek");

			ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
			// Wait for: ready + agent_start + turn_start + user
			// start/end + assistant start/update/end + turn_end + agent_end.
			const msgs = await inbox.waitFor(9, 5000);
			const innerTypes = msgs
				.filter((m) => m.type === "event")
				.map((m) => (m.event as { type?: string })?.type)
				.filter(Boolean);
			expect(innerTypes).toEqual(
				expect.arrayContaining(["agent_start", "turn_start", "turn_end", "agent_end"]),
			);
		} finally {
			close();
		}
	});

	it("forwards setModel as a pi set_model command (no respawn)", async () => {
		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const { ws, inbox, close } = await connectClient();
		try {
			ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			await inbox.waitFor(1);

			ws.send(JSON.stringify({ type: "setModel", modelId: "m2", provider: "p2" }));
			// The fake echoes the set_model command back as a "response" frame
			// (which the server drops). The proof of forwarding is that the
			// child stayed alive (we got the original "ready") and didn't
			// emit a SECOND "ready" — setModel is in-process in pi.
			await new Promise((r) => setTimeout(r, 300));
			const all = inbox.all();
			const readyCount = all.filter((m) => m.type === "ready").length;
			expect(readyCount).toBe(1);
		} finally {
			close();
		}
	});

	it("drops pi's response ack frames before forwarding to the client", async () => {
		// This is the "listSessions" case — server reads the disk
		// directly, no child needed. We swap in an ack-only fake-pi
		// that just emits a session line then acks. The test asserts
		// the server's {type:"sessions"} reply comes through.
		fakePiPath = makeFakePi("ack");
		process.env.PI_BIN = fakePiPath;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const { ws, inbox, close } = await connectClient();
		try {
			ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			await inbox.waitFor(1);
			ws.send(JSON.stringify({ type: "listSessions" }));
			const reply = await inbox.waitFor(2);
			const sessionsMsg = reply.find((m) => m.type === "sessions");
			expect(sessionsMsg).toBeTruthy();
			expect(Array.isArray((sessionsMsg as { sessions?: unknown[] }).sessions)).toBe(true);
		} finally {
			close();
		}
	});

	it("sends an error when the child exits before emitting a session line", async () => {
		fakePiPath = makeFakePi("exit-before-session");
		process.env.PI_BIN = fakePiPath;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const { ws, inbox, close } = await connectClient();
		try {
			ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			const msgs = await inbox.waitFor(2, 3000);
			// Expect an error message about the child exiting.
			const errMsg = msgs.find((m) => m.type === "error");
			expect(errMsg).toBeTruthy();
			expect((errMsg as { message?: string }).message ?? "").toMatch(/pi exited/);
		} finally {
			close();
		}
	});

	it("keeps the WS open across a resumeSession child respawn", async () => {
		// Regression test for the bug where the old pi child's
		// `exit` handler closed the WS, making subsequent
		// client->server sends fail with "not connected to server"
		// — which is exactly what the user reported in the browser.
		// The fix: the server's pi.on("exit") and pi.on("error")
		// handlers must not auto-close the WS when ready was already
		// sent (a normal occurrence during resumeSession/newSession
		// where the handler is in the middle of respawning).
		fakePiPath = makeFakePi("ack");
		process.env.PI_BIN = fakePiPath;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const { ws, inbox, close } = await connectClient();
		try {
			ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			await inbox.waitFor(1);

			// Snapshot WS state before respawn.
			expect(ws.readyState).toBe(WebSocket.OPEN);

			// Trigger a respawn. Server kills the old child, spawns
			// a new one with --session <id>. Old child's `exit`
			// fires while the new one is starting. The WS must
			// survive that.
			ws.send(
				JSON.stringify({
					type: "resumeSession",
					sessionId: "test-session-001",
				}),
			);

			// The new child should send a fresh `ready` (its
			// get_state replies with a sessionId). We wait until
			// we've seen TWO readies — the original from init, plus
			// the one from the resumed child. The interval poll
			// (200ms) gives a clear signal of "the new child is up".
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				if (inbox.all().filter((m) => m.type === "ready").length >= 2) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			const readies = inbox.all().filter((m) => m.type === "ready");
			expect(readies.length).toBe(2);

			// The WS must STILL be open after the respawn —
			// critical proof that we didn't auto-close it.
			expect(ws.readyState).toBe(WebSocket.OPEN);

			// And we must still be able to send a regular
			// client message after the respawn.
			ws.send(JSON.stringify({ type: "prompt", text: "after respawn" }));
			// The fake-pi ack script will respond to `prompt` with
			// a response frame (which the server drops). The point
			// is that the send itself didn't throw.
		} finally {
			close();
		}
	});

	it("forwards pi's success:false response frames (transparent pipe)", async () => {
		// The server must NOT silently drop failure responses — a
		// success:false steer tells the client its message wasn't
		// delivered (the agent went idle), so it can recover. Without
		// forwarding, the client's steer bubble hangs forever. Success
		// acks are still dropped (noise); only failures pass through.
		fakePiPath = makeFakePi("steer-race");
		process.env.PI_BIN = fakePiPath;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const { ws, inbox, close } = await connectClient();
		try {
			ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			await inbox.waitFor(1); // ready

			// Send a steer; fake-pi refuses it with success:false.
			ws.send(JSON.stringify({ type: "steer", text: "make it shorter" }));

			// The failure response must reach the client as a forwarded
			// event (not silently dropped). It arrives as the 2nd message
			// (after ready).
			const msgs = await inbox.waitFor(2, 3000);
			const failure = msgs.find(
				(m) =>
					m.type === "event" &&
					(m.event as { type?: string })?.type === "response" &&
					(m.event as { success?: boolean })?.success === false,
			);
			expect(failure).toBeTruthy();
			expect((failure?.event as { command?: string }).command).toBe("steer");
		} finally {
			close();
		}
	});

	it("does NOT kill the child on disconnect; a reconnect reattaches to the same child", async () => {
		// The core fix: backgrounding/locking the phone drops the WS,
		// but the `pi` child must keep running so work isn't interrupted.
		// On reconnect the client sends init with the sessionId it got
		// from `ready`; the registry reattaches to the still-live child
		// instead of spawning a new one. We prove "same child" by having
		// the fake-pi append its PID to a marker file on every spawn —
		// exactly one spawn across the disconnect/reconnect.
		fakePiPath = makeFakePi("track");
		process.env.PI_BIN = fakePiPath;
		const marker = join(mkdtempSync(join(tmpdir(), "marker-")), "spawns");
		process.env.AGENTCHATBOX_FAKE_PI_MARKER = marker;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		// --- first connection: fresh session ---
		const c1 = await connectClient();
		try {
			c1.ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			const ready1 = await c1.inbox.waitFor(1);
			expect(ready1[0]?.type).toBe("ready");
			expect((ready1[0] as { sessionId?: string }).sessionId).toBe("track-session-001");
		} finally {
			c1.close();
		}

		// Let the server process the close → detach (the child must NOT die).
		await new Promise((r) => setTimeout(r, 250));
		expect(spawnCount(marker)).toBe(1); // still exactly one child

		// --- second connection: reattach by sessionId ---
		const c2 = await connectClient();
		try {
			c2.ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
					sessionId: "track-session-001",
				}),
			);
			const ready2 = await c2.inbox.waitFor(1, 3000);
			expect(ready2[0]?.type).toBe("ready");
		} finally {
			c2.close();
		}

		// Decisive: still only ONE spawn. A respawn (the old behavior)
		// would have written a second PID.
		expect(spawnCount(marker)).toBe(1);
		delete process.env.AGENTCHATBOX_FAKE_PI_MARKER;
	});

	it("idle detached session is reaped after the grace period", async () => {
		// A finished + abandoned session is cleaned up so children don't
		// leak forever — but only once idle AND detached. Tiny grace via
		// env to exercise the reaping path quickly.
		fakePiPath = makeFakePi("track");
		process.env.PI_BIN = fakePiPath;
		const marker = join(mkdtempSync(join(tmpdir(), "marker-")), "spawns");
		process.env.AGENTCHATBOX_FAKE_PI_MARKER = marker;
		process.env.AGENTCHATBOX_IDLE_GRACE_MS = "300";
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const c1 = await connectClient();
		try {
			c1.ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			await c1.inbox.waitFor(1); // ready
		} finally {
			c1.close(); // detach — session is idle (no turn in flight)
		}

		// After the grace period, the idle detached child is reaped.
		await new Promise((r) => setTimeout(r, 900));
		const pids = readPids(marker);
		expect(pids.length).toBe(1);
		expect(isAlive(pids[0])).toBe(false);

		delete process.env.AGENTCHATBOX_FAKE_PI_MARKER;
		delete process.env.AGENTCHATBOX_IDLE_GRACE_MS;
	});

	it("prompts after resumeSession reach the NEW child (no stale-session hang)", async () => {
		// Regression: the ws.on("message") handler used to close over the
		// `session` captured at init time. resumeSession / newSession swap
		// the bound session via registry.attach (which updates ws._session),
		// but the captured variable still pointed at the now-killed old
		// child — whose pi.send() silently drops commands (PiProcess.killed).
		// The prompt vanished into the void and the UI hung forever. The
		// fix reads ws._session fresh on every message; this test proves a
		// prompt sent AFTER a resumeSession still produces a full event
		// stream from the live child.
		fakePiPath = makeFakePi("echo");
		process.env.PI_BIN = fakePiPath;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const { ws, inbox, close } = await connectClient();
		try {
			ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			const ready1 = await inbox.waitFor(1);
			expect(ready1[0]?.type).toBe("ready");

			// Switch to a different session. replaceSession kills child A
			// and spawns + binds child B.
			ws.send(JSON.stringify({ type: "resumeSession", sessionId: "other-session-xyz" }));
			// Wait for B's ready (the respawn re-emits ready).
			const gotSecondReady = await waitForReadyCount(inbox, 2, 3000);
			expect(gotSecondReady).toBe(true);

			// The actual regression check: a prompt now MUST reach child B
			// and come back as a live event stream. With the bug, the prompt
			// went to killed child A and we'd time out with no new events.
			const before = inbox.all().length;
			ws.send(JSON.stringify({ type: "prompt", text: "after resume" }));
			const events = await waitForEventOfType(inbox, "agent_start", before, 3000);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "event", event: { type: "agent_start" } }),
			);
		} finally {
			close();
		}
	});

	it("a second tab attaching to a live session ejects the first (error + 4001), no silent orphan", async () => {
		// Regression: attach() used to silently overwrite session.ws,
		// leaving the displaced tab deaf forever (no error, just no
		// events). The fix ejects the prior view: delivers an error frame
		// and closes with code 4001 ("session taken over"), which the
		// client treats as terminal so the two tabs don't reconnect-war.
		fakePiPath = makeFakePi("track");
		process.env.PI_BIN = fakePiPath;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		// --- tab A: fresh connect, acquires session track-session-001 ---
		const c1 = await connectClient();
		const c1Close: { code?: number; reason?: string } = {};
		c1.ws.on("close", (code, reason) => {
			c1Close.code = code;
			c1Close.reason = reason.toString();
		});
		try {
			c1.ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
				}),
			);
			const ready1 = await c1.inbox.waitFor(1);
			expect(ready1[0]?.type).toBe("ready");
			expect((ready1[0] as { sessionId?: string }).sessionId).toBe("track-session-001");

			// --- tab B: reconnect by the SAME sessionId → reattach → ejects A ---
			const c2 = await connectClient();
			try {
				c2.ws.send(
					JSON.stringify({
						type: "init",
						provider: "deepseek",
						modelId: "m1",
						thinkingLevel: "off",
						sessionId: "track-session-001",
					}),
				);
				const ready2 = await c2.inbox.waitFor(1, 3000);
				expect(ready2[0]?.type).toBe("ready");

				// Tab A must have been closed with code 4001 AND received an
				// error frame explaining why (the readable reason lives in
				// the error message, not the close reason, so the UI can
				// show it).
				await new Promise((r) => setTimeout(r, 400));
				expect(c1Close.code).toBe(4001);
				const errs = c1.inbox.all().filter((m) => m.type === "error");
				expect(errs.length).toBe(1);
				expect(String((errs[0] as { message?: string }).message ?? "")).toMatch(/another tab/i);
				// (Prompt routing from the winning tab is covered by the
				// stale-closure test above; success acks from this fake-pi
				// are dropped as noise by the server, so we don't re-check.)
			} finally {
				c2.close();
			}
		} finally {
			// c1 may already be closed by the ejection; close() is idempotent.
			c1.close();
		}
	});
});
async function waitForReadyCount(inbox: Inbox, count: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const readies = inbox.all().filter((m) => m.type === "ready");
		if (readies.length >= count) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return false;
}

/** Poll the inbox until an `event` wrapper whose inner event has the
 * given type arrives after index `afterIndex`. Returns matching msgs. */
async function waitForEventOfType(
	inbox: Inbox,
	innerType: string,
	afterIndex: number,
	timeoutMs: number,
): Promise<AnyMsg[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const recent = inbox.all().slice(afterIndex);
		const hit = recent.filter(
			(m) => m.type === "event" && (m.event as { type?: string } | undefined)?.type === innerType,
		);
		if (hit.length > 0) return hit;
		await new Promise((r) => setTimeout(r, 20));
	}
	return [];
}

/** Number of fake-pi spawns recorded in the marker file. */
function spawnCount(marker: string): number {
	return readPids(marker).length;
}

/** Read the recorded spawn PIDs from the marker file. */
function readPids(marker: string): number[] {
	try {
		const raw = readFileSync(marker, "utf8") as string;
		return raw
			.split("\n")
			.map((l) => Number.parseInt(l.trim(), 10))
			.filter((n) => Number.isFinite(n));
	} catch {
		return [];
	}
}

/** Whether a process with the given pid is currently alive. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
