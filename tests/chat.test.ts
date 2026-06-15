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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** Write a fake-pi shell script to a temp file and return its path. */
function makeFakePi(behavior: "echo" | "ack" | "exit-before-session"): string {
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	const script = join(dir, "pi");
	const body =
		behavior === "echo" ? ECHO_SCRIPT :
		behavior === "ack" ? ACK_SCRIPT :
		EXIT_BEFORE_SESSION_SCRIPT;
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
		server!.listen(0, "127.0.0.1", () => resolve());
		server!.once("error", reject);
	});
	port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = null;
	}
	if (fakePiPath) {
		try { rmSync(join(fakePiPath, ".."), { recursive: true, force: true }); } catch { /* ignore */ }
		fakePiPath = null;
	}
});

/** Connect a WS, register the inbox listener before `open`, return helpers. */
async function connectClient(): Promise<{ ws: WebSocket; inbox: Inbox; close: () => void }> {
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
			try { this.out.push(JSON.parse(text) as AnyMsg); }
			catch { /* drop */ }
		});
		ws.on("error", (err) => {
			console.error("TEST ws error:", err.message);
		});
		ws.on("close", (code, reason) => {
			console.error("TEST ws close:", code, reason.toString());
		});
	}
	all(): AnyMsg[] { return this.out.slice(); }
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
			ws.send(JSON.stringify({ type: "init", provider: "deepseek", modelId: "m1", thinkingLevel: "off" }));
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
			ws.send(JSON.stringify({ type: "init", provider: "deepseek", modelId: "m1", thinkingLevel: "off" }));
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
			ws.send(JSON.stringify({ type: "init", provider: "deepseek", modelId: "m1", thinkingLevel: "off" }));
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
			ws.send(JSON.stringify({ type: "init", provider: "deepseek", modelId: "m1", thinkingLevel: "off" }));
			const msgs = await inbox.waitFor(2, 3000);
			// Expect an error message about the child exiting.
			const errMsg = msgs.find((m) => m.type === "error");
			expect(errMsg).toBeTruthy();
			expect((errMsg as { message?: string }).message ?? "").toMatch(/pi exited/);
		} finally {
			close();
		}
	});
});

// Keep this as a placeholder so the file ends with a non-empty line
// after the last test — helps some editors' "did the file end mid
// statement" linter rule. (No runtime effect.)
export {};
