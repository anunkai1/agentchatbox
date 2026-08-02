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

const EXIT_AFTER_FIRST_READ_SCRIPT = `#!/usr/bin/env bash
# Fake pi that READS stdin (so the parent's write end of the pipe is
# open and the parent can keep writing) and then exits hard. This is
# the exact shape of the 2026-07-08 crash-loop trigger: pi dies after
# some interactive traffic but before its session is ready, and the
# server's requestSessionId retry timer keeps sending get_state into a
# closed pipe. With the noop Stream error listeners in pi-process.ts
# + the retry-guard (if session.pi.killed return) in
# session-registry.ts, the parent MUST NOT crash. Without those
# fixes, the async EPIPE on stdin surfaces as an unhandled 'error'
# event on the Socket and process.exit(1) takes down the entire
# agentchatbox server (which in turn triggers the orphan-pi
# crash-loop when systemd brings it back).
sleep 0.05
# Read exactly one line from stdin (the parent's first get_state) and
# exit. We use 'read' not a 'while read' loop because we want the
# process to DIE after a single read -- otherwise bash would block
# forever on subsequent reads and never exit (the parent keeps
# sending get_state every 200ms; without an exit, the script never
# reaches 'exit 1' and the crash scenario can't be reproduced).
read -r _line
exit 1
`;

const EXIT_AFTER_DELAY_SCRIPT = `#!/usr/bin/env bash
# Fake pi that exits after a delay without reading stdin. Used by the
# EPIPE regression test (Part a) to produce a dead-child pipe that the
# parent can then write to -- triggering the async EPIPE that the noop
# Stream error listeners must swallow. EXIT_AFTER_FIRST_READ_SCRIPT is
# used in Part b because the session-registry path sends get_state
# before the child exits, so reading is required to drain the pipe.
sleep 0.1
exit 1
`;

const EXIT_AFTER_READY_SCRIPT = `#!/usr/bin/env bash
# Fake pi that becomes ready, then exits naturally while its WebSocket is
# still attached. Reproduces the frozen-working UI bug: the registry used
# to delete the child silently and leave the browser bound to a dead pipe.
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  if [ "$type" = "get_state" ]; then
    echo '{"type":"response","command":"get_state","success":true,"data":{"sessionId":"exit-ready-session-001","messageCount":0}}'
    sleep 0.1
    exit 23
  fi
done
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

const RUNNING_SCRIPT = `#!/usr/bin/env bash
# Fake pi that, on \`prompt\`, starts an agent run (agent_start +
# turn_start) and then stays running indefinitely — never emits
# turn_end/agent_end. Simulates a mid-run agent (a long tool call, a
# slow model stream). Used to prove the server reports isStreaming=true
# in \`ready\` on reattach, so a refreshed tab recovers the Stop button.
if [ -n "\${AGENTCHATBOX_FAKE_PI_MARKER}" ]; then
  echo "$$" >> "\${AGENTCHATBOX_FAKE_PI_MARKER}"
fi
sleep 0.05
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  case "$type" in
    "get_state")
      echo '{"type":"response","command":"get_state","success":true,"data":{"sessionId":"running-session-001","messageCount":0}}'
      ;;
    "prompt")
      echo '{"type":"response","command":"prompt","success":true}'
      echo '{"type":"agent_start"}'
      echo '{"type":"turn_start"}'
      # Stay mid-run — keep the child alive so the run is still in
      # flight when the test reconnects.
      ;;
    "")
      ;;
    *)
      echo '{"type":"response","command":"'"$type"'","success":true}'
      ;;
  esac
done
`;

const RETRY_SCRIPT = `#!/usr/bin/env bash
# Fake pi that emits the auto_retry lifecycle on \`prompt\` and records
# every command type it receives to the marker file. Used to prove two
# transport-layer guarantees of the retry-visibility feature:
#   1. the server FORWARDS auto_retry_start/end events to the client
#      (doesn't drop them as response acks) — so the banner renders.
#   2. the client's {type:"abortRetry"} reaches pi as {type:"abort_retry"}
#      on stdin (the server forwards it, not swallowed by dispatch).
# The marker file doubles as a command log: every received command type
# is appended, so the test can assert "abort_retry" was delivered.
if [ -n "\${AGENTCHATBOX_FAKE_PI_MARKER}" ]; then
  echo "$$" >> "\${AGENTCHATBOX_FAKE_PI_MARKER}"
fi
sleep 0.05
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  if [ -n "\${AGENTCHATBOX_FAKE_PI_MARKER}" ] && [ -n "$type" ]; then
    echo "cmd:$type" >> "\${AGENTCHATBOX_FAKE_PI_MARKER}"
  fi
  case "$type" in
    "get_state")
      echo '{"type":"response","command":"get_state","success":true,"data":{"sessionId":"retry-session-001","messageCount":0}}'
      ;;
    "prompt")
      echo '{"type":"response","command":"prompt","success":true}'
      echo '{"type":"agent_start"}'
      echo '{"type":"turn_start"}'
      # The retry lifecycle: a recoverable error, then a backoff, then
      # success on the next attempt. Mirrors what real pi emits.
      echo '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":5000,"errorMessage":"rate limited (test 429)"}'
      sleep 0.3
      echo '{"type":"auto_retry_end","success":true,"attempt":1}'
      # Then a normal assistant turn.
      echo '{"type":"message_start","message":{"role":"assistant","content":[],"timestamp":1}}'
      echo '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"timestamp":2}}'
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"timestamp":2}}'
      echo '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"timestamp":2},"toolResults":[]}'
      echo '{"type":"agent_end","messages":[],"willRetry":false}'
      ;;
    "abort_retry")
      # Real pi cancels the backoff and emits auto_retry_end success:false.
      echo '{"type":"response","command":"abort_retry","success":true}'
      echo '{"type":"auto_retry_end","success":false,"attempt":1,"finalError":"Retry cancelled"}'
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

const SET_MODEL_SCRIPT = `#!/usr/bin/env bash
# Fake pi that handles set_model / set_thinking_level with realistic
# data: set_model echoes back the requested model in the response
# \`data\` field (matches real pi), and set_thinking_level acks with
# success:true (no data, also matches real pi). For set_model only,
# a modelId starting with "fail" simulates the "Model not found"
# error path — the test that exercises it sets provider="p-fail" or
# modelId starting with "fail-".
# This is the canonical script for the pessimistic setModel tests
# (the bug behind the "GLM 5.2 (Venice) silently fails to switch"
# report from 2026-07-09). Both success and failure cases are driven
# from this one script; failure is opted into via the modelId prefix.
sleep 0.05
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  case "$type" in
    "get_state")
      echo '{"type":"response","command":"get_state","success":true,"data":{"sessionId":"setmodel-session-001","messageCount":0}}'
      ;;
    "set_model")
      provider="$(echo "$line" | jq -r '.provider // ""')"
      modelId="$(echo "$line" | jq -r '.modelId // ""')"
      if [ "\${modelId#fail-}" != "\$modelId" ]; then
        echo '{"type":"response","command":"set_model","success":false,"error":"Model not found: '"$provider"'/'"$modelId"'"}'
      else
        echo '{"type":"response","command":"set_model","success":true,"data":{"provider":"'"$provider"'","id":"'"$modelId"'","name":"'"$modelId"'"}}'
      fi
      ;;
    "set_thinking_level")
      level="$(echo "$line" | jq -r '.level // ""')"
      if [ "\${level#fail-}" != "\$level" ]; then
        echo '{"type":"response","command":"set_thinking_level","success":false,"error":"Unknown thinking level"}'
      else
        echo '{"type":"response","command":"set_thinking_level","success":true}'
      fi
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
	behavior: "echo" | "ack" | "exit-before-session" | "exit-after-read" | "exit-after-delay" | "exit-after-ready" | "steer-race" | "track" | "retry" | "running" | "set-model",
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
						: behavior === "retry"
							? RETRY_SCRIPT
							: behavior === "running"
								? RUNNING_SCRIPT
								: behavior === "set-model"
									? SET_MODEL_SCRIPT
									: behavior === "exit-after-read"
										? EXIT_AFTER_FIRST_READ_SCRIPT
										: behavior === "exit-after-delay"
											? EXIT_AFTER_DELAY_SCRIPT
											: behavior === "exit-after-ready"
												? EXIT_AFTER_READY_SCRIPT
												: EXIT_BEFORE_SESSION_SCRIPT;
	writeFileSync(script, body, { mode: 0o755 });
	return script;
}

let fakePiPath: string | null = null;
let authFile: string | null = null;
let projectsFile: string | null = null;
let server: HttpServer | null = null;
let port = 0;

beforeEach(async () => {
	// Each test gets a unique fake-pi behavior. Default to "echo".
	fakePiPath = makeFakePi("echo");
	process.env.PI_BIN = fakePiPath;
	process.env.PI_CWD = "/tmp";
	// The server's spawn gate calls getServerApiKey(provider), which reads
	// pi's auth.json — NOT process.env. Point it at a temp auth file with a
	// known provider so the gate passes without depending on the operator's
	// real ~/.pi/agent/auth.json (which previously made the whole suite
	// break the moment the user logged `deepseek` out of `pi`).
	authFile = join(tmpdir(), `acb-chat-auth-${process.pid}-${Date.now()}.json`);
	writeFileSync(authFile, JSON.stringify({ deepseek: { key: "test-dummy" } }));
	process.env.AGENTCHATBOX_PI_AUTH_FILE = authFile;
	// Isolate the projects store too: resolveInitDefaults() reads the
	// Global project's default model from data/projects.json, so without
	// this the suite would pick up the OPERATOR's real default model
	// (set via the model picker) and override every test's spawn — every
	// test that sent init without a sessionId would suddenly use the
	// operator's model/provider instead of the one the test set up a key
	// for. Point at a temp path that doesn't exist yet; readStore()
	// synthesizes a Global-only store (no defaults), making
	// resolveInitDefaults a no-op and restoring the pre-feature behavior.
	projectsFile = join(tmpdir(), `acb-chat-projects-${process.pid}-${Date.now()}.json`);
	process.env.AGENTCHATBOX_PROJECTS_FILE = projectsFile;
	// Reset the module cache so each test re-reads config (and sees the
	// current PI_BIN / PI_CWD / AGENTCHATBOX_PI_AUTH_FILE env vars). Without
	// this, vitest's default module cache makes every test after the first
	// spawn `pi` with the env vars from the first test.
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
	if (authFile) {
		try {
			rmSync(authFile, { force: true });
		} catch {
			/* ignore */
		}
		authFile = null;
	}
	if (projectsFile) {
		try {
			rmSync(projectsFile, { force: true });
		} catch {
			/* ignore */
		}
		projectsFile = null;
	}
	delete process.env.AGENTCHATBOX_PI_AUTH_FILE;
	delete process.env.AGENTCHATBOX_PROJECTS_FILE;
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

/**
 * Wait until the inbox has accumulated at least `n` messages of
 * `type`, or the timeout fires. Returns whatever messages are in the
 * inbox at that point (caller filters). Distinct from Inbox.waitFor
 * which counts ALL messages regardless of type — useful when the
 * server emits noise (other events, response acks) between the frames
 * we care about.
 */
async function waitForType(
	inbox: Inbox,
	type: string,
	n: number,
	timeoutMs = 3000,
): Promise<AnyMsg[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const matches = inbox.all().filter((m) => m.type === type);
		if (matches.length >= n) return matches;
		await new Promise((r) => setTimeout(r, 20));
	}
	return inbox.all().filter((m) => m.type === type);
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

	it("forwards setModel/setThinking to pi and only adopts the new model on success", async () => {
		// Pessimistic setModel/setThinking (the 2026-07-09 fix). The
		// script echoes back the requested model in set_model's
		// response data (matches real pi), and acks set_thinking_level
		// with no data. Both cases must:
		//   (a) emit a {type:"modelState"} frame to the client carrying
		//       the new provider/modelId/thinkingLevel;
		//   (b) leave session.init pointing at the new values so a
		//       later reattach (page refresh, reconnect) reports the
		//       truth, not the spawn-time default.
		fakePiPath = makeFakePi("set-model");
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

			ws.send(
				JSON.stringify({ type: "setModel", modelId: "m2", provider: "p2" }),
			);
			ws.send(
				JSON.stringify({ type: "setThinking", level: "high" }),
			);
			// Wait for the two modelState frames (one per RPC).
			const msgs = await waitForType(inbox, "modelState", 2, 3000);
			const stateMsgs = msgs.filter((m) => m.type === "modelState");
			expect(stateMsgs.length).toBeGreaterThanOrEqual(2);
			const last = stateMsgs[stateMsgs.length - 1] as {
				provider: string;
				modelId: string;
				thinkingLevel: string;
			};
			expect(last.provider).toBe("p2");
			expect(last.modelId).toBe("m2");
			expect(last.thinkingLevel).toBe("high");
		} finally {
			close();
		}
	});

	it("keeps session.init on the old model when pi rejects set_model", async () => {
		// The original bug from the 2026-07-09 report: the user picks
		// "GLM 5.2 (Venice)" (a model not in pi's registry), pi's
		// set_model returns success:false, but the server's old
		// optimistic update had already painted the new model into
		// session.init. Result: the picker lied, subsequent prompts
		// kept going to the previous model. After the pessimistic
		// fix, session.init must stay on the previous model AND the
		// modelState frame sent to the client must reflect that.
		fakePiPath = makeFakePi("set-model");
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

			// A modelId starting with "fail-" triggers the fake
			// script's failure branch (which echoes success:false +
			// error). Mirrors the real-pi "Model not found" path.
			ws.send(
				JSON.stringify({
					type: "setModel",
					modelId: "fail-glm-5-2",
					provider: "venice",
				}),
			);

			// The modelState frame MUST report the previous model,
			// not the failed one. Wait up to 2s — it should arrive in
			// well under that.
			const state = (await waitForType(inbox, "modelState", 1, 2000))[0] as {
				provider: string;
				modelId: string;
				thinkingLevel: string;
			};
			expect(state.provider).toBe("deepseek");
			expect(state.modelId).toBe("m1");
			expect(state.thinkingLevel).toBe("off");
		} finally {
			close();
		}
	});

	it("keeps session.init on the old thinking level when pi rejects set_thinking_level", async () => {
		// Sibling test of the set_model failure case — same
		// pessimistic pattern, different RPC.
		fakePiPath = makeFakePi("set-model");
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
					thinkingLevel: "high",
				}),
			);
			await inbox.waitFor(1);

			ws.send(JSON.stringify({ type: "setThinking", level: "fail-xhigh" }));
			const state = (await waitForType(inbox, "modelState", 1, 2000))[0] as {
				provider: string;
				modelId: string;
				thinkingLevel: string;
			};
			expect(state.thinkingLevel).toBe("high"); // unchanged
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

	it("reports and reconnects when a ready child exits unexpectedly", async () => {
		fakePiPath = makeFakePi("exit-after-ready");
		process.env.PI_BIN = fakePiPath;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		const { ws, inbox, close } = await connectClient();
		const closed = new Promise<{ code: number; reason: string }>((resolve) => {
			ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
		});
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
			expect(msgs.some((m) => m.type === "ready")).toBe(true);
			const errMsg = msgs.find((m) => m.type === "error");
			expect(errMsg).toBeTruthy();
			expect((errMsg as { message?: string }).message ?? "").toMatch(
				/pi exited unexpectedly.*reconnecting/i,
			);

			const closeInfo = await Promise.race([
				closed,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("socket did not close after pi exit")), 3000),
				),
			]);
			expect(closeInfo.code).toBe(1011);
			expect(closeInfo.reason).toMatch(/pi subprocess exited unexpectedly/);
		} finally {
			close();
		}
	});

	it("flags the child as killed on natural exit, so the session-registry retry short-circuits", async () => {
		// Regression test for the 2026-07-08 openrouter crash loop.
		//
		// Two-part fix in pi-process.ts + session-registry.ts:
		//
		//   (a) PiProcess: set `killed = true` in the exit handler so
		//       NATURAL exits are indistinguishable from manual
		//       kill(). Previously only manual kill() flipped the
		//       flag, so a child that exited on its own (e.g. after
		//       a set_model crash) was reported as alive to callers
		//       that read pi.killed.
		//   (b) session-registry: requestSessionId's retry loop now
		//       short-circuits on `session.pi.killed`, so it doesn't
		//       waste get_state writes on a dead pipe for the full
		//       ~10s retry budget (and in production, so the retry
		//       doesn't pile onto a pipe that's about to be torn
		//       down by the orphan-pi crash-loop).
		//
		// Also asserts the noop Stream error listeners in
		// pi-process.ts don't break anything (the underlying
		// streams still emit 'data' on stdout normally — the
		// listener is on 'error' only).
		fakePiPath = makeFakePi("exit-after-delay");
		process.env.PI_BIN = fakePiPath;
		vi.resetModules();

		const { spawnPi } = await import("../src/server/pi-process.js");

		// Part (a) — PiProcess.killed becomes true after natural exit.
		const pi = spawnPi({
			bin: fakePiPath,
			provider: "deepseek",
			modelId: "m1",
			apiKey: "test-dummy",
			cwd: "/tmp",
			thinkingLevel: "off",
		});
		expect(pi.killed).toBe(false); // not yet
		// Wait for the child to read-and-exit (script: sleep 0.1; exit 1)
		await new Promise((r) => setTimeout(r, 300));
		expect(pi.killed).toBe(true); // exit handler fired (the fix)

		// Part (a, cont.) — send() on a naturally-exited child must
		// not throw and must not crash. Before the fix, killed was
		// still false (exit handler didn't set it), so send() would
		// attempt to write to a dead pipe. send()'s try/catch
		// handles any synchronous throw, but this assertion pins
		// the no-crash guarantee end-to-end.
		expect(() => pi.send({ type: "get_state" })).not.toThrow();
		expect(() => pi.send({ type: "prompt", message: "hi" })).not.toThrow();

		// Part (b) — through the full session-registry path: spawn
		// pi, let the retry timer fire a few times, child dies,
		// retry loop sees killed=true and stops, error frame
		// delivered to the WS, parent process still alive.
		fakePiPath = makeFakePi("exit-after-read");
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
			// The exit-after-read script reads get_state, exits 1.
			// The retry timer fires every 200ms; maxAttempts = 50
			// gives a ~10s ceiling. With the killed-check fix the
			// retry stops on the next tick after the child dies
			// (sub-200ms after the exit), and the error frame
			// propagates to the WS shortly after. We assert the
			// error arrives within a few seconds (well under the
			// full retry budget) to prove the short-circuit kicked
			// in. The exact upper bound is loose because the test
			// harness has variable setup latency; the meaningful
			// guarantee is "fast + finite", not "fast".
			const msgs = await inbox.waitFor(2, 4000).catch(() => inbox.all());
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

	it("reports isStreaming in `ready` on reattach so a refreshed tab recovers the Stop button", async () => {
		// Regression: a hard refresh mid-run wipes the browser's local
		// isStreaming, so the Stop button vanished and the user lost their
		// abort lever. The server observes agent_start/agent_end as a
		// transport pipe (no derivation) and reports the bit in `ready`,
		// so the reattaching tab recovers isStreaming correctly. Prove it:
		// start a run on connection 1, disconnect, reconnect to the same
		// session — the SECOND ready must carry isStreaming:true.
		fakePiPath = makeFakePi("running");
		process.env.PI_BIN = fakePiPath;
		const marker = join(mkdtempSync(join(tmpdir(), "marker-")), "spawns");
		process.env.AGENTCHATBOX_FAKE_PI_MARKER = marker;
		vi.resetModules();

		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server!);

		// --- connection 1: start a run, then drop (simulates refresh) ---
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
			expect((ready1[0] as { isStreaming?: boolean }).isStreaming).toBe(false);
			expect((ready1[0] as { sessionId?: string }).sessionId).toBe("running-session-001");

			// Kick off a run. The fake emits agent_start + turn_start then
			// stays mid-run indefinitely.
			c1.ws.send(JSON.stringify({ type: "prompt", text: "go" }));
			// Wait until the server has seen agent_start (streaming flips true).
			await waitForEventOfType(c1.inbox, "agent_start", 0, 3000);
		} finally {
			c1.close(); // detach — child keeps running (busy, immune to reap)
		}

		// Let the server process the close → detach.
		await new Promise((r) => setTimeout(r, 250));
		expect(spawnCount(marker)).toBe(1); // still the same child, mid-run

		// --- connection 2: reattach by sessionId (the refreshed tab) ---
		const c2 = await connectClient();
		try {
			c2.ws.send(
				JSON.stringify({
					type: "init",
					provider: "deepseek",
					modelId: "m1",
					thinkingLevel: "off",
					sessionId: "running-session-001",
				}),
			);
			const ready2 = await c2.inbox.waitFor(1, 3000);
			expect(ready2[0]?.type).toBe("ready");
			// The decisive assertion: the server tells the refreshed tab the
			// agent is mid-run, so the client recovers isStreaming and the
			// Stop button stays visible.
			expect((ready2[0] as { isStreaming?: boolean }).isStreaming).toBe(true);
		} finally {
			c2.close();
		}

		// Clean up the lingering mid-run child so it doesn't outlive the test.
		for (const pid of readPids(marker)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already dead */
			}
		}
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

	it("forwards pi's auto_retry events to the client (retry banner has a signal)", async () => {
		// The retry-visibility feature hinges on the server NOT dropping
		// auto_retry_start/end events. They're plain events (not response
		// acks), so they must reach the client WS for the banner to render.
		// This test proves the transport pipe is open for them.
		fakePiPath = makeFakePi("retry");
		process.env.PI_BIN = fakePiPath;
		const marker = join(mkdtempSync(join(tmpdir(), "marker-")), "log");
		process.env.AGENTCHATBOX_FAKE_PI_MARKER = marker;
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

			ws.send(JSON.stringify({ type: "prompt", text: "go" }));
			// Wait long enough for: agent_start, turn_start, auto_retry_start,
			// auto_retry_end, message_*, turn_end, agent_end.
			const msgs = await inbox.waitFor(10, 5000);
			const inner = msgs
				.filter((m) => m.type === "event")
				.map((m) => (m.event as { type?: string })?.type);
			expect(inner).toContain("auto_retry_start");
			expect(inner).toContain("auto_retry_end");
			// And the start event carries the fields the client renders from.
			const retryStart = msgs.find(
				(m) => m.type === "event" && (m.event as { type?: string })?.type === "auto_retry_start",
			) as { event?: Record<string, unknown> } | undefined;
			expect(retryStart?.event).toMatchObject({
				attempt: 1,
				maxAttempts: 3,
				errorMessage: expect.stringMatching(/429/),
			});
		} finally {
			close();
			delete process.env.AGENTCHATBOX_FAKE_PI_MARKER;
		}
	});

	it("client abortRetry reaches pi as abort_retry on stdin", async () => {
		// The Stop-during-retry affordance sends {type:"abortRetry"}; the
		// server must forward it to pi as {type:"abort_retry"} (the rpc
		// command). Prove the dispatch isn't swallowed and the wire name
		// is translated correctly. The fake-pi logs every command type it
		// receives to the marker file.
		fakePiPath = makeFakePi("retry");
		process.env.PI_BIN = fakePiPath;
		const marker = join(mkdtempSync(join(tmpdir(), "marker-")), "log");
		process.env.AGENTCHATBOX_FAKE_PI_MARKER = marker;
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

			// Fire abortRetry directly (the client does this when Stop is
			// clicked during a retry backoff).
			ws.send(JSON.stringify({ type: "abortRetry" }));

			// The fake-pi appends "cmd:<type>" for every command it reads.
			// Wait for abort_retry to show up on its stdin.
			const deadline = Date.now() + 3000;
			let saw = false;
			while (Date.now() < deadline) {
				const log = readMarkerLog(marker);
				if (log.includes("cmd:abort_retry")) {
					saw = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 30));
			}
			expect(saw).toBe(true);
		} finally {
			close();
			delete process.env.AGENTCHATBOX_FAKE_PI_MARKER;
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

/** Raw contents of the fake-pi marker/log file (PIDs + "cmd:<type>" lines). */
function readMarkerLog(marker: string): string {
	try {
		return readFileSync(marker, "utf8") as string;
	} catch {
		return "";
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
