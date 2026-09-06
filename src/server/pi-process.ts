/**
 * Subprocess wrapper for `pi --mode rpc`.
 *
 * Spawns the `pi` CLI in RPC mode (one process per WS connection) and
 * exposes:
 *   - a strict-`\n` NDJSON splitter on stdout (Node `readline` is not
 *     protocol-compliant — see the rpc.md docs and the SKILL.md note in
 *     `pi-agent-sdk-integration`. The `pi` team explicitly warns that
 *     `readline` splits on U+2028 and U+2029, which are valid inside
 *     JSON strings.)
 *   - an `EventEmitter` for parsed events (`"event"` with the parsed
 *     object as the argument; `"exit"` with `{code, signal}`; `"error"`
 *     for spawn failures or stdout/stderr streams that error).
 *   - a `send(cmd)` method that JSON.stringify's a command and writes
 *     it + `"\n"` to the child's stdin.
 *   - a `kill()` method that SIGTERMs and escalates to SIGKILL after
 *     2s, giving the child a chance to flush its session JSONL.
 *
 * Every child starts with `--offline`. This only disables pi's startup-time
 * network work (remote model-catalog refreshes, version/package checks, and
 * telemetry); normal provider and extension requests still use the network.
 * ACB relies on pi's built-in + persisted model catalogs, which can be
 * refreshed explicitly outside ACB with `pi update --models`.
 *
 * The process model is one `pi` per WS connection. Resume = kill + respawn
 * with `--session <id>`. New session = kill + respawn without `--session`.
 * Model switch mid-conversation does NOT respawn — `pi` supports in-process
 * model switching via the `set_model` RPC command.
 *
 * The selected chat credential is never passed as a command-line argument.
 * pi resolves it from ~/.pi/agent/auth.json. The child does inherit the
 * service environment because loaded extensions need tool credentials such
 * as VENICE_API_KEY/GEMINI_API_KEY; ACB does not add the selected auth.json
 * value separately.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { safeUnref } from "./util.js";

/**
 * The provider key is NOT passed on the command line. `/proc/<pid>/cmdline`
 * (and `ps`) are world-readable, so `--api-key <key>` would leak the secret
 * to every user on the box. Instead `pi` resolves the key itself from its
 * own `~/.pi/agent/auth.json` (which ACB already reads via `getServerApiKey`
 * to gate spawning) — so we pass NOTHING key-related and let the child read
 * the same auth.json it always does. Verified for every authed provider
 * (deepseek/zai/venice): `pi --mode rpc` with the `*_API_KEY` env var
 * blanked still authenticates and streams real replies from auth.json alone.
 * This retired the drift-prone hand-maintained provider→env-var map that used
 * to live in providers.ts. Tool-extension variables already present in the
 * service environment remain inherited intentionally.
 */

export interface PiProcessOptions {
	/** Path to the `pi` binary, or just "pi" for $PATH resolution. */
	bin: string;
	/** Provider id (e.g. "anthropic", "deepseek", "minimax"). */
	provider: string;
	/** Model id (e.g. "claude-sonnet-4-5", "deepseek-chat"). */
	modelId: string;
	/** Thinking level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max". */
	thinkingLevel?: string;
	/** Optional session id to resume. Omit to start a fresh session. */
	sessionId?: string;
	/** API key for the provider. Used ONLY by the registry's spawn gate
	 * (it reads auth.json via `getServerApiKey` and refuses to spawn if
	 * absent). This value is not explicitly added to argv or env. */
	apiKey: string;
	/** Working directory — the project root `pi` treats as the session scope. */
	cwd: string;
	/**
	 * Extra args appended after the standard set. Used by tests to inject
	 * `--no-session` and similar flags.
	 */
	extraArgs?: string[];
}

export interface PiProcessEvents {
	/** A parsed NDJSON line from stdout. */
	event: [line: Record<string, unknown>];
	/** The child exited. */
	exit: [info: { code: number | null; signal: NodeJS.Signals | null }];
	/** Spawn failed or a stream errored. */
	error: [err: Error];
}

/**
 * Strongly-typed wrapper over a `pi --mode rpc` child process.
 *
 * Usage:
 *   const pi = spawnPi({ ... });
 *   pi.on("event", (e) => { ... });           // forward to WS
 *   pi.send({ type: "prompt", message: "hi" }); // WS message → stdin
 *   pi.kill();                                  // on WS close
 */
export declare interface PiProcess {
	on<U extends keyof PiProcessEvents>(
		event: U,
		listener: (...args: PiProcessEvents[U]) => void,
	): this;
	emit<U extends keyof PiProcessEvents>(event: U, ...args: PiProcessEvents[U]): boolean;
}

// merging this interface into the class is the canonical TS pattern for
// strongly typing the inherited EventEmitter on/emit overloads.
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional — merges the PiProcess interface into the class to type the inherited EventEmitter on/emit overloads.
export class PiProcess extends EventEmitter {
	private readonly child: ChildProcessWithoutNullStreams;
	private stdoutBuf = "";
	private stderrBuf = "";
	private killTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * A prompt containing several uploaded images is echoed by pi as one
	 * JSONL message. The image bytes are base64-encoded, so seven ordinary
	 * 3–4 MiB phone photos can legitimately produce a line just over 32 MiB.
	 * The prompt-image aggregate is capped at 500 MiB; base64 expands that to
	 * roughly 667 MiB, so the RPC framing bound leaves room for JSON overhead.
	 */
	private static readonly MAX_STDOUT_LINE_CHARS = 768 * 1024 * 1024;
	/**
	 * True once the child has either been killed (`kill()` called) OR
	 * exited on its own (exit handler flips this). Read by callers
	 * (e.g. session-registry's `requestSessionId` retry loop) to avoid
	 * hammering a dead pipe after the OS surfaces the exit.
	 */
	private _killed = false;
	/** True once `kill()` has run OR the child has exited. */
	get killed(): boolean {
		return this._killed;
	}
	readonly pid: number;

	constructor(opts: PiProcessOptions) {
		super();
		// ACB is an always-on transport and must not block each fresh chat on
		// pi.dev catalog/update probes. `--offline` affects startup maintenance
		// only; model API calls and extension tools remain network-capable.
		const args = [
			"--mode",
			"rpc",
			"--offline",
			"--provider",
			opts.provider,
			"--model",
			opts.modelId,
		];
		// Thinking-level handling: explicit opts.thinkingLevel wins (the
		// picker or a setThinking RPC told us what the user picked).
		if (opts.thinkingLevel) {
			args.push("--thinking", opts.thinkingLevel);
		}
		if (opts.sessionId) {
			args.push("--session", opts.sessionId);
		}
		if (opts.extraArgs) {
			args.push(...opts.extraArgs);
		}

		// Each child leads a process group. Session teardown signals the whole
		// group, so extension/helper grandchildren cannot survive a switch or
		// idle reap. systemd's KillMode=control-group remains the final safety
		// net if the server itself is killed before graceful shutdown.
		//
		// `ACB_UPLOADS_DIR` exposes the server's web-servable uploads
		// directory to extensions running inside the pi child. The
		// pi-venice-image extension decodes the base64 images Venice
		// returns, writes them here as `<uuid>.<ext>`, and hands back
		// `/uploads/<uuid>.<ext>` URLs that the browser renders via the
		// express.static mount in index.ts. Venice's /image/generate
		// returns base64, NOT hosted URLs, so the extension must persist
		// the bytes itself — without this env var it has nowhere to put
		// them. Unlike the API key (which pi reads from auth.json itself —
		// see the header comment), this path is genuinely needed here:
		// the venice-image extension has no other way to learn it.
		// The selected auth.json value is intentionally not added here. The
		// inherited environment remains necessary for tool extensions.
		const child = spawn(opts.bin, args, {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: {
				...process.env,
				ACB_UPLOADS_DIR: config.uploadsDir,
			},
		});
		this.child = child;
		this.pid = child.pid ?? -1;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrBuf += chunk;
			// Keep the buffer bounded — pi should not produce much
			// stderr under normal operation, but a misbehaving version
			// could. The last 4KB is enough to diagnose any issue.
			if (this.stderrBuf.length > 4096) {
				this.stderrBuf = this.stderrBuf.slice(-4096);
			}
		});

		// CRITICAL — noop error listeners on stdin/stdout/stderr.
		//
		// When the child dies asynchronously (e.g. `pi` exits because of
		// a model-switch crash inside the RPC protocol, or because the
		// user closed their browser tab on Android and the heartbeat
		// tore the WS down), Node's underlying Socket emits an "error"
		// event (EPIPE on a closed write end, ECONNRESET on a closed
		// read end, etc.). These Stream-level errors do NOT bubble
		// through `child.on("error")` — that listener only catches
		// errors raised via the ChildProcess itself (spawn ENOENT,
		// EACCES, etc.).
		//
		// Without a listener, Node's EventEmitter sees an unhandled
		// "error" event and `process.exit(1)`s the server. That kills
		// the whole agentchatbox — every active session, every WS,
		// every idle child — even though the actual failure was just
		// one `pi` subprocess going away. systemd restarts the service,
		// but the orphaned `pi` processes from prior failed sessions
		// are still alive holding file locks; the freshly-spawned
		// server immediately crashes again on the same code path,
		// producing the crash-loop observed 2026-07-08.
		//
		// The synchronous EPIPE inside `send()`'s try/catch is already
		// caught and re-emitted as our own "error" event — that's the
		// happy path. The ASYNC EPIPE this listener swallows is the
		// one that previously escaped and crashed Node. The exit
		// handler below is the source of truth for "the child is dead";
		// these listeners exist only to keep the parent alive until
		// that handler runs.
		child.stdin.on("error", () => {});
		child.stdout.on("error", () => {});
		child.stderr.on("error", () => {});

		child.on("error", (err) => {
			// Spawn failed (ENOENT, EACCES) or stream errored.
			this.emit("error", err);
		});

		child.on("exit", (code, signal) => {
			if (this.killTimer) {
				clearTimeout(this.killTimer);
				this.killTimer = null;
			}
			// Mark dead so callers checking `pi.killed` (e.g.
			// session-registry's requestSessionId retry loop) stop
			// writing to the closed pipe. Without this, natural
			// exit left `killed=false` and the retry timer kept
			// firing send() against a pipe whose EPIPEs were
			// unhandled (the same root cause this fix targets).
			this._killed = true;
			this.emit("exit", { code, signal });
		});
	}

	/**
	 * Write a JSON-serializable command to the child's stdin. Adds the
	 * required trailing `\n` automatically.
	 */
	send(cmd: Record<string, unknown>): void {
		if (this.killed) {
			// Silently drop — the caller should have already received
			// an "exit" event and torn down its WS.
			return;
		}
		try {
			this.child.stdin.write(`${JSON.stringify(cmd)}\n`);
		} catch (err) {
			// EPIPE if the child died between our last write and this
			// one. Emit and let the caller close the WS.
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	/**
	 * SIGTERM the child, then SIGKILL after 2 seconds if it's still
	 * alive. The 2-second window is enough for `pi` to flush its
	 * session JSONL to disk; without it, a fast kill loses the last
	 * few events of the active session.
	 */
	kill(): void {
		if (this.killed) return;
		this._killed = true;
		try {
			this.child.stdin.end();
		} catch {
			/* ignore — stdin may already be closed */
		}
		this.signalGroup("SIGTERM");
		this.killTimer = setTimeout(() => {
			this.signalGroup("SIGKILL");
			this.killTimer = null;
		}, 2000);
		// Don't keep the event loop alive just for the escalation — if the
		// process is exiting, the SIGTERM (and the exit handler) suffice.
		safeUnref(this.killTimer);
	}

	/**
	 * The accumulated stderr output, capped at 4KB. Useful for logging
	 * what `pi` complained about when it exits with a non-zero code.
	 */
	getStderr(): string {
		return this.stderrBuf;
	}

	private signalGroup(signal: NodeJS.Signals): void {
		try {
			if (process.platform !== "win32" && this.pid > 0) process.kill(-this.pid, signal);
			else this.child.kill(signal);
		} catch {
			/* already exited */
		}
	}

	private handleStdout(chunk: string): void {
		// A size violation calls kill(), which marks the process as dead while
		// already-buffered stdout chunks may still be delivered. Ignore those
		// chunks so one bad line produces one error rather than a burst of
		// duplicate errors in the browser.
		if (this.killed) return;
		this.stdoutBuf += chunk;
		if (this.stdoutBuf.length > PiProcess.MAX_STDOUT_LINE_CHARS && !this.stdoutBuf.includes("\n")) {
			this.emit("error", new Error("pi emitted an oversized RPC line"));
			this.kill();
			return;
		}
		for (;;) {
			const idx = this.stdoutBuf.indexOf("\n");
			if (idx < 0) break;
			const line = this.stdoutBuf.slice(0, idx);
			this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
			if (!line) continue;
			// Strip a trailing \r defensively — pi doesn't emit
			// \r\n, but a buggy version might.
			const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (clean.length > PiProcess.MAX_STDOUT_LINE_CHARS) {
				this.emit("error", new Error("pi emitted an oversized RPC line"));
				this.kill();
				return;
			}
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(clean) as Record<string, unknown>;
			} catch {
				// Non-JSON line. `pi` should never emit one in RPC
				// mode, but a buggy version might. Drop silently;
				// the stderr buffer carries the raw bytes for
				// postmortem.
				continue;
			}
			this.emit("event", parsed);
		}
	}
}

/**
 * Convenience constructor — equivalent to `new PiProcess(opts)` but
 * reads as `spawnPi(opts)` at the call site. The `chat.ts` rewrite
 * uses this.
 */
export function spawnPi(opts: PiProcessOptions): PiProcess {
	return new PiProcess(opts);
}
