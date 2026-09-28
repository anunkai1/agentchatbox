import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	buildClaudeSpawn,
	DELEGATION_MODES,
	type DelegationMode,
	type DelegationStore,
	FileDelegationStore,
	MODE_LABELS,
	parseDelegationMode,
	progressTail,
	StreamParser,
} from "./lib.js";

const TOOL_NAME = "claude_code_task";
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 5000;

export const DEFAULT_WORKSPACE = join(homedir(), ".config", "browser-harness", "agent-workspace");

interface SpawnOutcome {
	resultText?: string;
	isError: boolean;
	claudeSessionId?: string;
	usage?: Record<string, unknown>;
}

function sessionKey(): string {
	return process.env.PI_SESSION_ID || "default";
}

function killTree(child: ReturnType<typeof spawn>): void {
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
}

/**
 * Run one headless `claude -p` task. Streamed assistant text is forwarded
 * through onText so ACB shows live progress while Claude works.
 */
export function runClaudeTask(
	args: string[],
	options: {
		cwd: string;
		env: Record<string, string>;
		signal?: AbortSignal;
		timeoutMs?: number;
		onText?: (tail: string) => void;
		/** Override the executable (tests use a stub that emits stream-json). */
		bin?: string;
	},
): Promise<SpawnOutcome> {
	return new Promise((resolve, reject) => {
		const bin = options.bin ?? (platform() === "win32" ? "claude.cmd" : "claude");
		const child = spawn(bin, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const parser = new StreamParser();
		const timeout = setTimeout(() => killTree(child), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		let stderr = "";
		let lastText = "";
		let claudeSessionId: string | undefined;
		let finalUsage: Record<string, unknown> | undefined;
		let resultEvent: { text?: string; isError: boolean } | undefined;

		const abortHandler = () => killTree(child);
		options.signal?.addEventListener("abort", abortHandler, { once: true });

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			for (const event of parser.feed(chunk)) {
				if (event.kind === "init") {
					claudeSessionId = event.claudeSessionId;
				} else if (event.kind === "text") {
					lastText = event.text;
					options.onText?.(progressTail(event.text));
				} else if (event.kind === "result") {
					resultEvent = { text: event.text, isError: event.isError };
					if (event.usage) finalUsage = event.usage;
				}
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-4000);
		});

		child.on("error", (error) => {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abortHandler);
			reject(new Error(`Failed to start claude: ${error.message}`));
		});

		child.on("close", (code, signalName) => {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abortHandler);
			if (options.signal?.aborted === true) {
				reject(new Error("Delegated task cancelled."));
				return;
			}
			const outcome: SpawnOutcome = {
				resultText: resultEvent?.text ?? (lastText || undefined),
				isError: resultEvent?.isError === true || (code !== 0 && !resultEvent),
				claudeSessionId,
				usage: finalUsage,
			};
			if (outcome.isError && !outcome.resultText) {
				const reason = signalName
					? `terminated by ${signalName}`
					: `exit code ${code ?? "unknown"}`;
				outcome.resultText = stderr.trim() || `claude exited with ${reason}`;
			}
			resolve(outcome);
		});
	});
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
}

/** Only the status label matters here; the rest stays pi's own context type. */
interface StatusContext {
	ui: { setStatus(key: string, text: string | undefined): void };
}

export function registerClaudeDelegate(
	pi: ExtensionAPI,
	store: DelegationStore,
	workspace = DEFAULT_WORKSPACE,
): void {
	// Labels mirror codex-fast: ACB reads extensionStatusLabels["claude-delegate"].
	const setStatus = (mode: DelegationMode, ctx: StatusContext) => {
		ctx.ui.setStatus("claude-delegate", MODE_LABELS[mode]);
	};

	const syncToolAvailability = (mode: DelegationMode) => {
		const active = new Set(pi.getActiveTools());
		if (mode === "off") active.delete(TOOL_NAME);
		else active.add(TOOL_NAME);
		pi.setActiveTools([...active]);
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Claude Code",
		description:
			"Delegate a self-contained task to headless Claude Code (Anthropic Opus/Sonnet/Haiku, billed from the Claude plan). " +
			"The delegated agent runs with filesystem and network access in the browser-harness workspace and drives browser-harness itself. " +
			"Use for multi-step browser work (registrations, forms, scrapes) when the user asks for delegation or has enabled Claude Code mode via /claude.",
		promptSnippet:
			"Delegate a task to headless Claude Code (browser work, registrations, multi-step flows).",
		promptGuidelines: [
			"Use claude_code_task when the user explicitly asks to delegate to Claude/Opus, or when Claude Code delegation mode is enabled and the task is browser-heavy multi-step work.",
			"Do not use claude_code_task for quick lookups, research, or simple single-page reads — do those directly.",
		],
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Complete, self-contained description of the task to delegate.",
				},
				fresh: {
					type: "boolean",
					description:
						"Start a fresh Claude session instead of resuming this chat's previous delegated session (default false).",
				},
			},
			required: ["task"],
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			const mode = store.readMode();
			if (mode === "off") {
				throw new Error("Claude Code delegation is off. Enable it with /claude first.");
			}
			const task = String(params.task ?? "").trim();
			if (!task) throw new Error("A non-empty task is required.");

			const key = sessionKey();
			const resumeId = params.fresh === true ? undefined : store.readClaudeSession(key);
			const newSessionId = resumeId ? undefined : randomUUID();

			mkdirSync(workspace, { recursive: true });

			const plan = buildClaudeSpawn({
				task,
				mode,
				resumeSessionId: resumeId,
				newSessionId,
			});

			onUpdate?.({
				content: [{ type: "text", text: `Delegating to Claude Code (${MODE_LABELS[mode]})…` }],
				details: {},
			});

			let lastUpdate = 0;
			const outcome = await runClaudeTask(plan.args, {
				cwd: plan.cwd,
				env: {
					...plan.env,
					BH_TAB_SCOPE: `claude:${key}`,
					PATH: `${homedir()}/.npm-global/bin:${homedir()}/.local/bin:${process.env.PATH ?? ""}`,
				},
				signal: signal ?? undefined,
				onText: (tail) => {
					const now = Date.now();
					if (now - lastUpdate < 1500) return;
					lastUpdate = now;
					onUpdate?.({ content: [{ type: "text", text: tail }], details: {} });
				},
			});

			if (outcome.claudeSessionId) {
				store.writeClaudeSession(key, outcome.claudeSessionId);
			}

			if (outcome.isError) {
				throw new Error(outcome.resultText ?? "Delegated task failed.");
			}

			const resultText =
				outcome.resultText ??
				"Delegated task finished but produced no summary text. Check the Claude session files for details.";
			const details: Record<string, unknown> = {
				mode: MODE_LABELS[mode],
				claudeSessionId: outcome.claudeSessionId,
			};
			if (outcome.usage) details.usage = outcome.usage;
			return {
				content: [{ type: "text", text: resultText }],
				details,
			} satisfies ToolResult;
		},
	});

	pi.registerCommand("claude", {
		description: "toggle Claude Code delegation (off/opus/sonnet/haiku)",
		handler: async (rawArgs, ctx) => {
			const command = rawArgs.trim().toLowerCase();
			const current = store.readMode();

			if (command === "report") {
				setStatus(current, ctx);
				return;
			}

			let next: DelegationMode | undefined;
			if (!command || command === "menu") {
				const options = DELEGATION_MODES.map(
					(mode) => `${mode === current ? "✓ " : ""}${MODE_LABELS[mode]}`,
				);
				const selected = await ctx.ui.select("Claude Code delegation", options);
				if (!selected) return;
				next = parseDelegationMode(selected.replace("✓ ", "").toLowerCase());
			} else if (command === "status") {
				ctx.ui.notify(
					`Claude Code delegation is ${current === "off" ? "off" : MODE_LABELS[current]}.`,
					"info",
				);
				return;
			} else {
				next = parseDelegationMode(command);
				if (!next) {
					ctx.ui.notify("Usage: /claude [off|opus|sonnet|haiku|status|menu]", "warning");
					return;
				}
			}
			if (!next) return;

			store.writeMode(next);
			setStatus(next, ctx);
			syncToolAvailability(next);
			ctx.ui.notify(
				next === "off"
					? "Claude Code delegation disabled — pi handles everything itself."
					: `Claude Code delegation set to ${MODE_LABELS[next]} — claude_code_task is available for browser-heavy work.`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const mode = store.readMode();
		setStatus(mode, ctx);
		syncToolAvailability(mode);
	});
}

export default function claudeDelegate(pi: ExtensionAPI): void {
	registerClaudeDelegate(pi, new FileDelegationStore());
}
