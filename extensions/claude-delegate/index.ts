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
	delegationLabel,
	EFFORT_LEVELS,
	type EffortLevel,
	FileDelegationStore,
	MODE_LABELS,
	PROBE_MODES,
	PROBE_TASK,
	parseDelegationMode,
	parseEffortLevel,
	prettyModelName,
	progressTail,
	resolveEffort,
	StreamParser,
} from "./lib.js";

const TOOL_NAME = "claude_code_task";
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Alias probes are trivial; keep them from hanging a user-initiated refresh. */
export const PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const KILL_GRACE_MS = 5000;

export const DEFAULT_WORKSPACE = join(homedir(), ".config", "browser-harness", "agent-workspace");

/** Parse `/cc [opus|sonnet|haiku] <task>`; the model token is optional. */
export function parseCcArgs(raw: string): { mode?: DelegationMode; task: string } {
	const trimmed = raw.trim();
	const [first, ...rest] = trimmed.split(/\s+/);
	const asMode = first ? parseDelegationMode(first.toLowerCase()) : undefined;
	if (asMode && asMode !== "off" && rest.length > 0) {
		return { mode: asMode, task: rest.join(" ") };
	}
	return { task: trimmed };
}

export interface DelegationRequest {
	task: string;
	mode: Exclude<DelegationMode, "off">;
	fresh?: boolean;
	signal?: AbortSignal;
	onText?: (tail: string) => void;
}

export interface DelegationOutcome {
	outcome: SpawnOutcome;
	effort?: EffortLevel;
	label: string;
}

/**
 * Shared delegation core: session continuity, effort, spawn, and the
 * model/session bookkeeping. Used by the claude_code_task tool and by the
 * `/cc` passthrough command.
 */
export async function performDelegation(
	store: DelegationStore,
	workspace: string,
	runTask: typeof runClaudeTask,
	request: DelegationRequest,
): Promise<DelegationOutcome> {
	const key = sessionKey();
	const resumeId = request.fresh === true ? undefined : store.readClaudeSession(key);
	const newSessionId = resumeId ? undefined : randomUUID();
	mkdirSync(workspace, { recursive: true });

	const mode = request.mode;
	const effort = resolveEffort(mode, store.readEffort(mode));
	const plan = buildClaudeSpawn({
		task: request.task,
		mode,
		resumeSessionId: resumeId,
		newSessionId,
		effort,
	});

	const outcome = await runTask(plan.args, {
		cwd: plan.cwd,
		env: {
			...plan.env,
			BH_TAB_SCOPE: `claude:${key}`,
			PATH: `${homedir()}/.npm-global/bin:${homedir()}/.local/bin:${process.env.PATH ?? ""}`,
		},
		signal: request.signal,
		onText: request.onText,
	});

	if (outcome.claudeSessionId) store.writeClaudeSession(key, outcome.claudeSessionId);
	const primaryModel = outcome.models[0];
	if (primaryModel) store.writeModel(mode, primaryModel);

	return {
		outcome,
		effort,
		label: delegationLabel(mode, primaryModel ?? store.readModel(mode), effort),
	};
}

interface SpawnOutcome {
	resultText?: string;
	isError: boolean;
	claudeSessionId?: string;
	usage?: Record<string, unknown>;
	/** Every model id Claude Code reported for the run, primary first. */
	models: string[];
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
		// Primary model first (init/assistant), then any extra models reported
		// by modelUsage (for example a Haiku subagent).
		const models: string[] = [];
		const noteModel = (model: string | undefined) => {
			if (model && !models.includes(model)) models.push(model);
		};

		const abortHandler = () => killTree(child);
		options.signal?.addEventListener("abort", abortHandler, { once: true });

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			for (const event of parser.feed(chunk)) {
				if (event.kind === "init") {
					claudeSessionId = event.claudeSessionId;
					noteModel(event.model);
				} else if (event.kind === "text") {
					noteModel(event.model);
					if (event.text) {
						lastText = event.text;
						options.onText?.(progressTail(event.text));
					}
				} else if (event.kind === "result") {
					resultEvent = { text: event.text, isError: event.isError };
					if (event.usage) finalUsage = event.usage;
					for (const model of event.models ?? []) noteModel(model);
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
				models,
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

/** Resolves one probe run; injectable so tests do not spawn Claude. */
export type ProbeRunner = (mode: Exclude<DelegationMode, "off">) => Promise<string | undefined>;

export function registerClaudeDelegate(
	pi: ExtensionAPI,
	store: DelegationStore,
	workspace = DEFAULT_WORKSPACE,
	runProbe?: ProbeRunner,
	runTask: typeof runClaudeTask = runClaudeTask,
): void {
	// Labels mirror codex-fast: ACB reads extensionStatusLabels["claude-delegate"].
	// The text includes the resolved model version once a run has reported it.
	const statusText = (mode: DelegationMode) =>
		delegationLabel(mode, store.readModel(mode), resolveEffort(mode, store.readEffort(mode)));
	const setStatus = (mode: DelegationMode, ctx: StatusContext) => {
		ctx.ui.setStatus("claude-delegate", statusText(mode));
	};

	const syncToolAvailability = (mode: DelegationMode) => {
		const active = new Set(pi.getActiveTools());
		if (mode === "off") active.delete(TOOL_NAME);
		else active.add(TOOL_NAME);
		pi.setActiveTools([...active]);
	};

	// One cheap throwaway run per alias; only the reported model id is kept.
	const defaultProbe: ProbeRunner = async (mode) => {
		const plan = buildClaudeSpawn({
			task: PROBE_TASK,
			mode,
			effort: resolveEffort(mode, store.readEffort(mode)),
		});
		const outcome = await runClaudeTask(plan.args, {
			cwd: plan.cwd,
			env: {
				...plan.env,
				PATH: `${homedir()}/.npm-global/bin:${homedir()}/.local/bin:${process.env.PATH ?? ""}`,
			},
			timeoutMs: PROBE_TIMEOUT_MS,
		});
		return outcome.models[0];
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
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mode = store.readMode();
			if (mode === "off") {
				throw new Error("Claude Code delegation is off. Enable it with /claude first.");
			}
			const task = String(params.task ?? "").trim();
			if (!task) throw new Error("A non-empty task is required.");

			onUpdate?.({
				content: [{ type: "text", text: `Delegating to Claude Code (${statusText(mode)})…` }],
				details: {},
			});

			let lastUpdate = 0;
			const { outcome, effort } = await performDelegation(store, workspace, runTask, {
				task,
				mode,
				fresh: params.fresh === true,
				signal: signal ?? undefined,
				onText: (tail) => {
					const now = Date.now();
					if (now - lastUpdate < 1500) return;
					lastUpdate = now;
					onUpdate?.({ content: [{ type: "text", text: tail }], details: {} });
				},
			});

			if (outcome.models[0]) {
				const ui = (ctx as unknown as StatusContext | undefined)?.ui;
				if (ui) ui.setStatus("claude-delegate", statusText(mode));
			}

			if (outcome.isError) {
				throw new Error(outcome.resultText ?? "Delegated task failed.");
			}

			const primaryModel = outcome.models[0];
			const resultText =
				outcome.resultText ??
				"Delegated task finished but produced no summary text. Check the Claude session files for details.";
			const modelNote = primaryModel
				? `\n\n— Claude Code model: **${prettyModelName(primaryModel)}** (\`${primaryModel}\`)${effort ? ` at \`${effort}\` effort` : ""}`
				: "";
			const details: Record<string, unknown> = {
				mode: MODE_LABELS[mode],
				label: delegationLabel(mode, primaryModel, effort),
				claudeSessionId: outcome.claudeSessionId,
			};
			if (primaryModel) details.model = primaryModel;
			if (effort) details.effort = effort;
			if (outcome.models.length > 1) details.models = outcome.models;
			if (outcome.usage) details.usage = outcome.usage;
			return {
				content: [{ type: "text", text: `${resultText}${modelNote}` }],
				details,
			} satisfies ToolResult;
		},
	});

	// Direct passthrough: the prompt goes to headless Claude Code without a
	// driver-model turn deciding whether to delegate.
	pi.registerCommand("cc", {
		description: "send a task straight to headless Claude Code: /cc [opus|sonnet|haiku] <task>",
		handler: async (rawArgs, ctx) => {
			const { mode: requested, task } = parseCcArgs(rawArgs);
			if (!task) {
				ctx.ui.notify("Usage: /cc [opus|sonnet|haiku] <task>", "warning");
				return;
			}
			const mode = requested ?? store.readMode();
			if (mode === "off") {
				ctx.ui.notify(
					"Claude Code delegation is off. Pick a model with /claude, or prefix the task: /cc sonnet <task>.",
					"warning",
				);
				return;
			}

			const label = statusText(mode);
			ctx.ui.notify(`Sending to Claude Code (${label})…`, "info");
			try {
				const { outcome, label: resolved } = await performDelegation(store, workspace, runTask, {
					task,
					mode,
					onText: (tail) =>
						ctx.ui.setStatus("claude-delegate", `${label} · ${tail.split("\n")[0].slice(0, 60)}`),
				});
				// Restore the steady-state label (now with the resolved version).
				ctx.ui.setStatus(
					"claude-delegate",
					delegationLabel(mode, store.readModel(mode), resolveEffort(mode, store.readEffort(mode))),
				);
				if (outcome.isError) {
					ctx.ui.notify(outcome.resultText ?? "Delegated task failed.", "error");
					return;
				}
				const primaryModel = outcome.models[0];
				const footer = primaryModel ? `\n\n— ${resolved} (\`${primaryModel}\`)` : "";
				// ACB renders extension display notes for customType "note"
				// (display:true, no triggerTurn); other custom types are
				// counted in context but never drawn.
				pi.sendMessage({
					customType: "note",
					content: `${outcome.resultText ?? "Task finished with no summary text."}${footer}`,
					display: true,
				});
			} catch (error) {
				ctx.ui.setStatus(
					"claude-delegate",
					delegationLabel(mode, store.readModel(mode), resolveEffort(mode, store.readEffort(mode))),
				);
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("claude", {
		description:
			"toggle Claude Code delegation (off/opus/sonnet/haiku), /claude effort to set reasoning effort",
		handler: async (rawArgs, ctx) => {
			const command = rawArgs.trim().toLowerCase();
			const current = store.readMode();

			if (command === "report") {
				setStatus(current, ctx);
				return;
			}

			// /claude effort [level|auto] — per-mode override of the built-in default.
			if (command === "effort" || command.startsWith("effort ")) {
				if (current === "off") {
					ctx.ui.notify("Select a delegation mode before setting effort.", "warning");
					return;
				}
				const arg = command.slice("effort".length).trim();
				const stored = store.readEffort(current);
				if (!arg) {
					const effective = resolveEffort(current, stored);
					const source = stored && stored !== "auto" ? "override" : "default";
					ctx.ui.notify(
						effective
							? `${MODE_LABELS[current]} effort: ${effective} (${source}). Levels: ${EFFORT_LEVELS.join(", ")}, or auto.`
							: `${MODE_LABELS[current]} has no effort parameter (its model does not support effort).`,
						"info",
					);
					return;
				}
				const setting = parseEffortLevel(arg);
				if (!setting) {
					ctx.ui.notify(
						`Unknown effort "${arg}". Use ${EFFORT_LEVELS.join(", ")}, or auto.`,
						"warning",
					);
					return;
				}
				store.writeEffort(current, setting);
				setStatus(current, ctx);
				const effective = resolveEffort(current, setting);
				ctx.ui.notify(
					effective
						? `${MODE_LABELS[current]} effort set to ${effective}${setting === "auto" ? " (default)" : ""}.`
						: `${MODE_LABELS[current]} does not support effort; the setting is stored but unused.`,
					"info",
				);
				return;
			}

			if (command === "probe" || command === "versions") {
				// Aliases resolve server-side, so the only way to learn which
				// version an alias points at is to ask Claude Code for a cheap run.
				const runner = runProbe ?? defaultProbe;
				ctx.ui.notify("Probing Claude Code model aliases (haiku, sonnet, opus)…", "info");
				const lines: string[] = [];
				for (const mode of PROBE_MODES) {
					try {
						const model = await runner(mode);
						if (model) {
							store.writeModel(mode, model);
							lines.push(`${MODE_LABELS[mode]}: ${prettyModelName(model)} (${model})`);
						} else {
							lines.push(`${MODE_LABELS[mode]}: unresolved`);
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						lines.push(`${MODE_LABELS[mode]}: failed (${message})`);
					}
				}
				setStatus(current, ctx);
				ctx.ui.notify(`Claude Code models — ${lines.join("; ")}`, "info");
				return;
			}

			let next: DelegationMode | undefined;
			if (!command || command === "menu") {
				// Menu entries carry the resolved version, so map them back by index
				// rather than re-parsing the label text.
				const entries = DELEGATION_MODES.map((mode) => ({
					mode,
					label: `${mode === current ? "✓ " : ""}${delegationLabel(mode, store.readModel(mode))}`,
				}));
				const selected = await ctx.ui.select(
					"Claude Code delegation",
					entries.map((entry) => entry.label),
				);
				if (!selected) return;
				next = entries.find((entry) => entry.label === selected)?.mode;
			} else if (command === "status") {
				ctx.ui.notify(
					`Claude Code delegation is ${current === "off" ? "off" : statusText(current)}.`,
					"info",
				);
				return;
			} else {
				next = parseDelegationMode(command);
				if (!next) {
					ctx.ui.notify(
						"Usage: /claude [off|opus|sonnet|haiku|status|menu|probe|effort <level>]",
						"warning",
					);
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
					: `Claude Code delegation set to ${statusText(next)} — claude_code_task is available for browser-heavy work.`,
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
