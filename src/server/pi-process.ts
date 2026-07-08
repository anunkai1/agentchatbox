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
 * The process model is one `pi` per WS connection. Resume = kill + respawn
 * with `--session <id>`. New session = kill + respawn without `--session`.
 * Model switch mid-conversation does NOT respawn — `pi` supports in-process
 * model switching via the `set_model` RPC command.
 *
 * On `--api-key` vs env: the provider key is injected into the child's
 * env, NOT passed on the command line (which is world-readable). See the
 * note on `providerApiKeyEnvVar()` below. The key value comes from the
 * server's `config.apiKeys[provider]` lookup.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { providerApiKeyEnvVar } from "./providers.js";

/**
 * The provider key is injected into the child's env via the name returned
 * by `providerApiKeyEnvVar()` (defined in providers.ts, the single source
 * of truth shared with config.ts). On `--api-key` vs env: `/proc/<pid>/cmdline`
 * (and `ps`) are world-readable, so `--api-key <key>` leaks the secret to
 * every user on the box; the child's env (`/proc/<pid>/environ`) is mode
 * 0400 — owner and root only. `pi` resolves the key from env at priority 4
 * (below its own `--api-key` / auth.json), so this is functionally
 * equivalent while keeping the key off the command line.
 */

export interface PiProcessOptions {
	/** Path to the `pi` binary, or just "pi" for $PATH resolution. */
	bin: string;
	/** Provider id (e.g. "anthropic", "deepseek", "minimax"). */
	provider: string;
	/** Model id (e.g. "claude-sonnet-4-5", "deepseek-chat"). */
	modelId: string;
	/** Thinking level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh". */
	thinkingLevel?: string;
	/** Optional session id to resume. Omit to start a fresh session. */
	sessionId?: string;
	/** API key for the provider. Injected into the child's env as the
	 * provider's `*_API_KEY` var (see `providerApiKeyEnvVar`). */
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
		const args = ["--mode", "rpc", "--provider", opts.provider, "--model", opts.modelId];
		// Thinking-level handling. Two cases:
		//   - Explicit opts.thinkingLevel wins (the picker or a setThinking
		//     RPC told us what the user picked).
		//   - For provider="ollama" with no explicit level, force "off".
		//     Ollama's OpenAI-compat endpoint doesn't expose qwen3's
		//     native `think:false` parameter, so without this override the
		//     model burns every response on internal reasoning tokens —
		//     ~26-60s for "pong" on the i5-1135G7. The matching
		//     thinkingLevelMap in ~/.pi/agent/models.json is also set
		//     all-null for qwen3:8b so an explicit user opt-in is
		//     rejected at the pi side too.
		const effectiveThinking = opts.thinkingLevel ?? (opts.provider === "ollama" ? "off" : undefined);
		if (effectiveThinking) {
			args.push("--thinking", effectiveThinking);
		}
		if (opts.sessionId) {
			args.push("--session", opts.sessionId);
		}
		if (opts.extraArgs) {
			args.push(...opts.extraArgs);
		}

		// Detached: false (default) — when the server dies, we want the
		// child to die too, not become an orphan writing to a JSONL
		// the server isn't reading. The `process.on("SIGTERM", ...)`
		// handler at server boot sends SIGTERM to every child first,
		// giving each a 2-second window to flush before SIGKILL.
		const child = spawn(opts.bin, args, {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, [providerApiKeyEnvVar(opts.provider)]: opts.apiKey },
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
		try {
			this.child.kill("SIGTERM");
		} catch {
			/* ignore — already dead */
		}
		const escalate = setTimeout(() => {
			try {
				this.child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 2000);
		// Don't keep the event loop alive just for the escalation — if the
		// process is exiting, the SIGTERM (and the exit handler) suffice.
		if (typeof escalate.unref === "function") escalate.unref();
	}

	/**
	 * The accumulated stderr output, capped at 4KB. Useful for logging
	 * what `pi` complained about when it exits with a non-zero code.
	 */
	getStderr(): string {
		return this.stderrBuf;
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		for (;;) {
			const idx = this.stdoutBuf.indexOf("\n");
			if (idx < 0) break;
			const line = this.stdoutBuf.slice(0, idx);
			this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
			if (!line) continue;
			// Strip a trailing \r defensively — pi doesn't emit
			// \r\n, but a buggy version might.
			const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
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
