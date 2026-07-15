/**
 * Helpers for running Python helper scripts (scripts/transcribe.py,
 * scripts/tts.py) and reporting bounded results back to the caller.
 *
 * The pattern: spawn a child process, capture stdout/stderr into bounded
 * ring buffers, and resolve with a status when the child exits. If the
 * child hangs past the timeout, kill it and resolve with an error.
 *
 * Why a shared module: the transcribe and tts routers both need this
 * exact pattern, and the cap/timeout knobs are the same. Centralizing
 * avoids two copies of the bounded-buffer + abort-on-timeout logic
 * drifting out of sync.
 */

import { spawn } from "node:child_process";
import { BoundedBuffer } from "./bounded-buffer.js";

export const MAX_PYTHON_OUTPUT = 256 * 1024; // 256 KB per stream
const TRUNCATION_MARKER = `\n…[truncated, showing last ${MAX_PYTHON_OUTPUT} bytes]`;
export const DEFAULT_PYTHON_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

export interface PythonResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
	spawnError: boolean;
}

/**
 * Run a Python helper. Captures stdout/stderr into bounded buffers
 * (last MAX_PYTHON_OUTPUT bytes per stream), enforces a timeout via
 * SIGKILL, and resolves with a status object.
 *
 * Unlike `child_process.execFile` which concatenates all output into a
 * single string, this returns bounded tail-captured strings so a chatty
 * helper can't OOM the node process.
 */
export function runPython(args: {
	bin: string;
	helperPath: string;
	helperArgs: string[];
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<PythonResult> {
	const timeoutMs = args.timeoutMs ?? DEFAULT_PYTHON_TIMEOUT_MS;
	return new Promise((resolveP) => {
		const child = spawn(args.bin, [args.helperPath, ...args.helperArgs], {
			stdio: ["ignore", "pipe", "pipe"],
			env: args.env,
		});

		const outBuf = new BoundedBuffer(MAX_PYTHON_OUTPUT);
		const errBuf = new BoundedBuffer(MAX_PYTHON_OUTPUT);
		child.stdout.on("data", (chunk: Buffer) => outBuf.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => errBuf.push(chunk));

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.on("error", () => {
			clearTimeout(timer);
			resolveP({
				stdout: "",
				stderr: `${errBuf.toString()}\nspawn error`,
				code: -1,
				timedOut: false,
				spawnError: true,
			});
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			resolveP({
				stdout: outBuf.toString(TRUNCATION_MARKER),
				stderr: errBuf.toString(TRUNCATION_MARKER),
				code: code ?? -1,
				timedOut,
				spawnError: false,
			});
		});
	});
}
