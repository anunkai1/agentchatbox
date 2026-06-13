/**
 * Tools the pi Agent uses to interact with the local filesystem and shell.
 *
 * No sandbox. Tools accept absolute paths. Bash inherits the full process env.
 * This matches the user's explicit choice to treat the agent as a fully
 * trusted local process, like the real pi CLI.
 *
 * Each tool is an `AgentTool` from `@earendil-works/pi-agent-core`:
 *   { name, label, description, parameters (Typebox), execute }
 *
 * `execute` signature is:
 *   (toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>
 *
 * AgentToolResult = { content: TextContent[], details, isError? }.
 * On failure, throw OR return { content, details, isError: true }.
 * We return isError=true so the model sees the actual error message and can
 * self-correct (e.g. retry the edit with more context).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(s: string): TextContent {
	return { type: "text", text: s };
}

function errContent(s: string): TextContent {
	return { type: "text", text: `Error: ${s}` };
}

function ok<T>(content: TextContent[], details: T): AgentToolResult<T> {
	return { content, details };
}

/**
 * Tool failure path: throw the error. The agent-loop catches it, emits a
 * tool result with `isError: true`, and the model sees the message. The
 * client's `toolResult.isError` flag drives red styling.
 */
class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

function resolveSafe(p: string): string {
	return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to run. Runs in /bin/bash, inherits the full process env." }),
	timeoutMs: Type.Optional(
		Type.Integer({
			description: "Max runtime in ms. Default 30000 (30s). Hard cap 300000 (5min).",
			minimum: 1000,
			maximum: 300000,
		}),
	),
});

interface BashDetails {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
}

const MAX_OUTPUT = 64 * 1024; // 64 KB per stream; truncate beyond that.

function runBash(command: string, timeoutMs: number): Promise<BashDetails> {
	const started = Date.now();
	return new Promise((resolveP) => {
		const child = spawn("/bin/bash", ["-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;

		child.stdout.on("data", (chunk) => {
			if (stdout.length < MAX_OUTPUT) {
				stdout += chunk.toString("utf8");
				if (stdout.length > MAX_OUTPUT) {
					stdout = stdout.slice(0, MAX_OUTPUT);
					stdoutTruncated = true;
				}
			} else {
				stdoutTruncated = true;
			}
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length < MAX_OUTPUT) {
				stderr += chunk.toString("utf8");
				if (stderr.length > MAX_OUTPUT) {
					stderr = stderr.slice(0, MAX_OUTPUT);
					stderrTruncated = true;
				}
			} else {
				stderrTruncated = true;
			}
		});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);

		child.on("error", (e) => {
			clearTimeout(timer);
			resolveP({
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: `spawn error: ${e.message}`,
				truncated: false,
				durationMs: Date.now() - started,
			});
		});

		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveP({
				exitCode: code,
				signal,
				stdout: stdoutTruncated ? stdout + `\n…[truncated at ${MAX_OUTPUT} bytes]` : stdout,
				stderr: stderrTruncated ? stderr + `\n…[truncated at ${MAX_OUTPUT} bytes]` : stderr,
				truncated: stdoutTruncated || stderrTruncated,
				durationMs: Date.now() - started,
			});
		});
	});
}

export const bashTool: AgentTool<typeof bashSchema, BashDetails> = {
	name: "bash",
	label: "Bash",
	description:
		"Run a shell command in /bin/bash. Inherits the full process environment, runs in the agent's working directory. Returns exit code, stdout, and stderr. Use this for anything you'd do in a terminal: build, test, git, package install, file inspection via cat/ls/grep, etc.",
	parameters: bashSchema,
	execute: async (_toolCallId, params) => {
		const args = params as { command: string; timeoutMs?: number };
		const timeoutMs = args.timeoutMs ?? 30_000;
		const result = await runBash(args.command, timeoutMs);

		const parts: string[] = [];
		parts.push(
			`exit ${result.exitCode}${result.signal ? ` (signal: ${result.signal})` : ""} · ${result.durationMs}ms`,
		);
		if (result.stdout) parts.push(result.stdout);
		if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);
		if (result.truncated) parts.push(`…[output truncated]`);

		// Non-zero exit is a failure the model should see. We still return
		// the output as content, but signal isError so the client styles it red.
		const isError = result.exitCode !== 0;
		const res = ok([text(parts.join("\n"))], result);
		return isError ? { ...res, content: [errContent(parts.join("\n"))] } : res;
	},
};

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const readSchema = Type.Object({
	path: Type.String({ description: "Absolute or relative path to the file." }),
	offset: Type.Optional(
		Type.Integer({ description: "1-based line number to start from. Default 1.", minimum: 1 }),
	),
	limit: Type.Optional(
		Type.Integer({ description: "Max lines to read. Default 2000.", minimum: 1, maximum: 10000 }),
	),
});

interface ReadDetails {
	path: string;
	totalLines: number;
	offset: number;
	limit: number;
}

export const readTool: AgentTool<typeof readSchema, ReadDetails> = {
	name: "read",
	label: "Read",
	description:
		"Read the contents of a file. Returns content as text with line numbers, like `cat -n`. Use offset/limit to page through large files.",
	parameters: readSchema,
	execute: async (_toolCallId, params) => {
		const args = params as { path: string; offset?: number; limit?: number };
		const p = resolveSafe(args.path);
		const offset = args.offset ?? 1;
		const limit = args.limit ?? 2000;

		let raw: string;
		try {
			raw = readFileSync(p, "utf8");
		} catch (e) {
			throw new ToolError(`read ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}

		const lines = raw.split("\n");
		const totalLines = lines.length;
		const start = Math.max(1, offset) - 1;
		const end = Math.min(totalLines, start + limit);
		const slice = lines.slice(start, end);
		const width = String(end).length;
		const numbered = slice
			.map((l, i) => `${String(start + i + 1).padStart(width, " ")}\t${l}`)
			.join("\n");

		const details: ReadDetails = { path: p, totalLines, offset, limit };
		const header = `${p} (${totalLines} lines, showing ${start + 1}-${end})`;
		return ok([text(`${header}\n${numbered}`)], details);
	},
};

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const writeSchema = Type.Object({
	path: Type.String({ description: "Absolute or relative path. Parent dirs are created." }),
	content: Type.String({ description: "File contents to write. Overwrites the file if it exists." }),
});

interface WriteDetails {
	path: string;
	bytes: number;
	created: boolean;
}

export const writeTool: AgentTool<typeof writeSchema, WriteDetails> = {
	name: "write",
	label: "Write",
	description:
		"Create or overwrite a file with the given content. Parent directories are created automatically. Use `edit` for targeted in-place changes — `write` is for new files or full rewrites.",
	parameters: writeSchema,
	execute: async (_toolCallId, params) => {
		const args = params as { path: string; content: string };
		const p = resolveSafe(args.path);
		const created = !existsSync(p);

		try {
			await mkdir(dirname(p), { recursive: true });
			await writeFile(p, args.content, "utf8");
		} catch (e) {
			throw new ToolError(`write ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}

		const details: WriteDetails = {
			path: p,
			bytes: Buffer.byteLength(args.content, "utf8"),
			created,
		};
		return ok([text(`wrote ${details.bytes} bytes to ${p}${created ? " (new file)" : ""}`)], details);
	},
};

// ---------------------------------------------------------------------------
// edit (string-replace)
// ---------------------------------------------------------------------------

const editSchema = Type.Object({
	path: Type.String({ description: "Absolute or relative path to the file." }),
	old_string: Type.String({ description: "The exact string to find. Must match exactly (whitespace and all)." }),
	new_string: Type.String({ description: "The replacement string." }),
	replace_all: Type.Optional(
		Type.Boolean({
			description: "Replace all occurrences. Default false (refuse to proceed if >1 match).",
			default: false,
		}),
	),
});

interface EditDetails {
	path: string;
	matches: number;
	diff: string;
}

function unifiedDiff(before: string, after: string, context = 3): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			out.push(` ${a[i]}`);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push(`-${a[i]}`);
			i++;
		} else {
			out.push(`+${b[j]}`);
			j++;
		}
	}
	while (i < m) out.push(`-${a[i++]}`);
	while (j < n) out.push(`+${b[j++]}`);
	const start = Math.max(0, out.findIndex((l) => l[0] !== " ") - context);
	const end = Math.min(out.length, out.length + context);
	return out.slice(start, end).join("\n");
}

export const editTool: AgentTool<typeof editSchema, EditDetails> = {
	name: "edit",
	label: "Edit",
	description:
		"Replace a specific string in a file. By default refuses to proceed if old_string matches more than one location (pass replace_all: true to override). Returns a unified diff of the change so you can verify.",
	parameters: editSchema,
	execute: async (_toolCallId, params) => {
		const args = params as {
			path: string;
			old_string: string;
			new_string: string;
			replace_all?: boolean;
		};
		const p = resolveSafe(args.path);
		const replaceAll = args.replace_all ?? false;

		let raw: string;
		try {
			raw = readFileSync(p, "utf8");
		} catch (e) {
			throw new ToolError(`edit ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}

		const matches = raw.split(args.old_string).length - 1;
		if (matches === 0) {
			throw new ToolError(
				`edit ${p}: old_string not found in file (check whitespace, indentation, and newlines exactly)`,
			);
		}
		if (matches > 1 && !replaceAll) {
			throw new ToolError(
				`edit ${p}: old_string matches ${matches} locations. Pass replace_all: true or include more context in old_string to disambiguate.`,
			);
		}

		const updated = replaceAll
			? raw.split(args.old_string).join(args.new_string)
			: raw.replace(args.old_string, args.new_string);

		try {
			writeFileSync(p, updated, "utf8");
		} catch (e) {
			throw new ToolError(`edit ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}

		const diff = unifiedDiff(raw, updated);
		const details: EditDetails = { path: p, matches, diff };
		return ok(
			[text(`edited ${p} (${matches} match${matches === 1 ? "" : "es"})\n\n${diff}`)],
			details,
		);
	},
};

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list. Default: agent's working directory." })),
	show_hidden: Type.Optional(
		Type.Boolean({ description: "Include dotfiles. Default false.", default: false }),
	),
});

interface LsDetails {
	path: string;
	entries: Array<{ name: string; isDir: boolean; size: number; mtime: number }>;
}

export const lsTool: AgentTool<typeof lsSchema, LsDetails> = {
	name: "ls",
	label: "List",
	description:
		"List a directory. Returns entries with name, type, size, and mtime, sorted alphabetically. Hidden files (starting with .) excluded by default.",
	parameters: lsSchema,
	execute: async (_toolCallId, params) => {
		const args = params as { path?: string; show_hidden?: boolean };
		const p = resolveSafe(args.path ?? ".");
		const showHidden = args.show_hidden ?? false;

		let names: string[];
		try {
			names = await readdir(p);
		} catch (e) {
			throw new ToolError(`ls ${p}: ${e instanceof Error ? e.message : String(e)}`);
		}

		const entries = names
			.filter((n) => showHidden || !n.startsWith("."))
			.sort((a, b) => a.localeCompare(b))
			.map((name) => {
				const full = resolve(p, name);
				try {
					const st = statSync(full);
					return { name, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
				} catch {
					return { name, isDir: false, size: 0, mtime: 0 };
				}
			});

		const formatted = entries
			.map((e) => {
				const type = e.isDir ? "d" : "-";
				const size = String(e.size).padStart(8, " ");
				return `${type} ${size}  ${e.name}${e.isDir ? "/" : ""}`;
			})
			.join("\n");

		const details: LsDetails = { path: p, entries };
		return ok([text(`${p}/\n${formatted || "(empty)"}`)], details);
	},
};

// ---------------------------------------------------------------------------
// Export the list
// ---------------------------------------------------------------------------

export const allTools: AgentTool[] = [bashTool, readTool, writeTool, editTool, lsTool];
