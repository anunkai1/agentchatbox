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
 * On `--api-key` vs env: we use `--api-key <key>` on the command line
 * (visible in `ps`, but `pi` does not log it or write it to disk). The
 * alternative — injecting the key into the child's env — leaks it to
 * `/proc/<pid>/environ` and is harder to audit. The key value comes
 * from the server's existing `config.apiKeys[provider]` lookup.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

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
	/** API key for the provider. Passed as `--api-key` to the CLI. */
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
	private killed = false;
	readonly pid: number;

	constructor(opts: PiProcessOptions) {
		super();
		const args = [
			"--mode",
			"rpc",
			"--provider",
			opts.provider,
			"--model",
			opts.modelId,
			"--api-key",
			opts.apiKey,
		];
		if (opts.thinkingLevel) {
			args.push("--thinking", opts.thinkingLevel);
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

		child.on("error", (err) => {
			// Spawn failed (ENOENT, EACCES) or stream errored.
			this.emit("error", err);
		});

		child.on("exit", (code, signal) => {
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
		this.killed = true;
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
		setTimeout(() => {
			try {
				this.child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 2000);
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
