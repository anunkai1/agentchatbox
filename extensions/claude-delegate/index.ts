import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	buildClaudeSpawn,
	capToolResult,
	DELEGATION_MODES,
	type DelegationMode,
	type DelegationStore,
	delegationLabel,
	EFFORT_LEVELS,
	type EffortLevel,
	FileDelegationStore,
	MODE_LABELS,
	normaliseToolArgs,
	PROBE_MODES,
	PROBE_TASK,
	parseDelegationMode,
	parseEffortLevel,
	prettyModelName,
	progressTail,
	resolveEffort,
	type StreamEvent,
	StreamParser,
} from "./lib.js";

const TOOL_NAME = "claude_code_task";
/**
 * Custom message carrying the prompt the owner sent to Claude Code. ACB draws
 * it as a user bubble so /cc and sticky-mode prompts survive in the history.
 */
export const PROMPT_MESSAGE_TYPE = "claude-prompt";
/** Session entry recording this chat's sticky mode; the last entry wins. */
export const STICKY_ENTRY_TYPE = "claude-sticky";
/** Alias probes are trivial; keep them from hanging a user-initiated refresh. */
export const PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const KILL_GRACE_MS = 5000;
/** How often the progress heartbeat refreshes during a delegated run. */
const HEARTBEAT_MS = 5000;
/** Silence on the stream beyond this is flagged in the status label. */
const QUIET_WARNING_MS = 2 * 60 * 1000;

/** `45s`, `3m12s`, `1h05m`. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
	return `${sec}s`;
}

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

export type CcControl =
	| { kind: "on"; mode?: Exclude<DelegationMode, "off"> }
	| { kind: "off" }
	| { kind: "status" };

/**
 * Recognise the sticky-mode controls: `/cc on [opus|sonnet|haiku]`, `/cc off`
 * and `/cc status`. Anything longer is an ordinary task ("on Monday, book…").
 */
export function parseCcControl(raw: string): CcControl | undefined {
	const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 1 && words[0] === "off") return { kind: "off" };
	if (words.length === 1 && words[0] === "status") return { kind: "status" };
	if (words[0] !== "on" || words.length > 2) return undefined;
	if (words.length === 1) return { kind: "on" };
	const mode = parseDelegationMode(words[1]);
	if (!mode || mode === "off" || words[1] !== mode) return undefined;
	return { kind: "on", mode };
}

/** Read this chat's sticky mode back from its session entries. */
export function restoreStickyMode(
	entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
): Exclude<DelegationMode, "off"> | undefined {
	let sticky: Exclude<DelegationMode, "off"> | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STICKY_ENTRY_TYPE) continue;
		const raw = (entry.data as { mode?: unknown } | undefined)?.mode;
		const mode = typeof raw === "string" ? parseDelegationMode(raw) : undefined;
		sticky = mode && mode !== "off" ? mode : undefined;
	}
	return sticky;
}

export interface DelegationRequest {
	task: string;
	mode: Exclude<DelegationMode, "off">;
	/** Chat the run belongs to; keys Claude session continuity. */
	sessionKey?: string;
	fresh?: boolean;
	signal?: AbortSignal;
	onText?: (tail: string) => void;
	/** Every parsed stream event (thinking, tool calls and results included). */
	onEvent?: (event: StreamEvent) => void;
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
	const key = request.sessionKey ?? sessionKey();
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
		onEvent: request.onEvent,
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

/**
 * Pi exports PI_SESSION_ID only to bash children, not to extensions, so the
 * chat's own session id is the key whenever a context is available.
 */
function sessionKey(ctx?: unknown): string {
	const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
		?.sessionManager;
	return manager?.getSessionId?.() || process.env.PI_SESSION_ID || "default";
}

function killTree(child: ReturnType<typeof spawn>): void {
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
}

/**
 * Run one headless `claude -p` task. Streamed assistant text is forwarded
 * through onText and every parsed event through onEvent, so ACB shows live
 * progress while Claude works. There is no default time limit: long
 * sessions are expected, and only an explicit timeoutMs (probes) or the
 * abort signal stops a run.
 */
export function runClaudeTask(
	args: string[],
	options: {
		cwd: string;
		env: Record<string, string>;
		signal?: AbortSignal;
		timeoutMs?: number;
		onText?: (tail: string) => void;
		onEvent?: (event: StreamEvent) => void;
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
		const timeout =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => killTree(child), options.timeoutMs);

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
				options.onEvent?.(event);
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
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abortHandler);
			reject(new Error(`Failed to start claude: ${error.message}`));
		});

		child.on("close", (code, signalName) => {
			if (timeout) clearTimeout(timeout);
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
	sessionManager?: unknown;
}

/** Provider tag on the assistant messages that mirror a Claude Code reply. */
export const MIRROR_PROVIDER = "claude-code";

interface MirrorSink {
	appendMessage(message: unknown): unknown;
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function appendToSession(ctx: StatusContext, message: unknown): void {
	const sink = ctx.sessionManager as Partial<MirrorSink> | undefined;
	if (typeof sink?.appendMessage !== "function") return;
	sink.appendMessage(message);
}

function assistantMessage(content: unknown[], model: string, stopReason: "stop" | "toolUse") {
	return {
		role: "assistant",
		content,
		api: MIRROR_PROVIDER,
		provider: MIRROR_PROVIDER,
		model,
		usage: ZERO_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * Pi writes a chat's session file only once it holds an assistant message, and
 * Claude Code mode never produces one (pi is bypassed), so the prompts and
 * notes would vanish on reload. Recording each Claude Code reply as an
 * assistant message makes pi flush the whole chat. Pi hands extensions the
 * read-only session view, but the object is the real manager. Thinking that
 * arrived after the last tool step rides along on the reply.
 */
export function mirrorReplyToSession(
	ctx: StatusContext,
	text: string,
	model: string,
	thinking: string[] = [],
): void {
	appendToSession(
		ctx,
		assistantMessage(
			[...thinking.map((t) => ({ type: "thinking", thinking: t })), { type: "text", text }],
			model,
			"stop",
		),
	);
}

/** Status key carrying live activity events to ACB's browser client. */
export const ACTIVITY_STATUS_KEY = "claude-activity";
const THINKING_LIVE_LIMIT = 8000;

/** One-line description of a tool call, for the status label. */
function describeTool(name: string, args: Record<string, unknown>): string {
	const detail =
		typeof args.command === "string"
			? args.command
			: typeof args.path === "string"
				? args.path
				: typeof args.url === "string"
					? args.url
					: "";
	return `${name}${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 40)}` : ""}`;
}

/**
 * Turns one run's stream events into what ACB shows for any other model:
 * live thinking blocks and tool cards (ephemeral status events the browser
 * paints), and the same steps saved to the chat as assistant/toolResult
 * messages so a reload rebuilds them. A step is saved when its first tool
 * result arrives, matching how pi orders assistant and toolResult messages.
 */
export class RunTrace {
	private thinking: string[] = [];
	private text = "";
	private tools: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
	private names = new Map<string, string>();
	private pending = new Map<string, string>();
	private seq = 0;
	private model: string;
	lastEventAt = Date.now();
	steps = 0;

	constructor(
		private readonly ctx: StatusContext,
		fallbackModel: string,
	) {
		this.model = fallbackModel;
	}

	/** Tool calls started but not yet answered, oldest first. */
	get pendingTools(): string[] {
		return [...this.pending.values()];
	}

	/** Thinking not yet attached to a saved step; goes on the final reply. */
	get trailingThinking(): string[] {
		return this.thinking;
	}

	private live(payload: Record<string, unknown>): void {
		this.seq += 1;
		this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, JSON.stringify({ seq: this.seq, ...payload }));
	}

	handle(event: StreamEvent): void {
		if (event.kind === "result") return;
		this.lastEventAt = Date.now();
		if (event.kind === "init") {
			if (event.model) this.model = event.model;
		} else if (event.kind === "text") {
			if (event.model) this.model = event.model;
			if (event.text) this.text = event.text;
		} else if (event.kind === "thinking") {
			this.thinking.push(event.text);
			this.live({ t: "thinking", text: event.text.slice(0, THINKING_LIVE_LIMIT) });
		} else if (event.kind === "tool_use") {
			const args = normaliseToolArgs(event.input);
			this.tools.push({ id: event.id, name: event.name, args });
			this.names.set(event.id, event.name);
			this.pending.set(event.id, describeTool(event.name, args));
			this.live({ t: "tool", id: event.id, name: event.name, args });
		} else if (event.kind === "tool_result") {
			const saved = this.flushStep() + 1;
			const text = capToolResult(event.text);
			this.pending.delete(event.id);
			this.steps += 1;
			// `saved` lets the browser keep its fork ordinal in step with the
			// session messages written behind its back.
			this.live({ t: "tool_end", id: event.id, text, isError: event.isError, saved });
			appendToSession(this.ctx, {
				role: "toolResult",
				toolCallId: event.id,
				toolName: this.names.get(event.id) ?? "tool",
				content: [{ type: "text", text }],
				isError: event.isError,
				timestamp: Date.now(),
			});
		}
	}

	/** Save the assistant message (thinking, commentary, tool calls) so far. */
	private flushStep(): number {
		if (this.tools.length === 0) return 0;
		const content: unknown[] = [
			...this.thinking.map((t) => ({ type: "thinking", thinking: t })),
			...(this.text ? [{ type: "text", text: this.text }] : []),
			...this.tools.map((tool) => ({
				type: "toolCall",
				id: tool.id,
				name: tool.name,
				arguments: tool.args,
			})),
		];
		appendToSession(this.ctx, assistantMessage(content, this.model, "toolUse"));
		this.thinking = [];
		this.text = "";
		this.tools = [];
		return 1;
	}
}

/** Resolves one probe run; injectable so tests do not spawn Claude. */
export type ProbeRunner = (mode: Exclude<DelegationMode, "off">) => Promise<string | undefined>;

export function registerClaudeDelegate(
	pi: ExtensionAPI,
	store: DelegationStore,
	workspace = DEFAULT_WORKSPACE,
	runProbe?: ProbeRunner,
	runTask: typeof runClaudeTask = runClaudeTask,
): { whenIdle(): Promise<void> } {
	// Labels mirror codex-fast: ACB reads extensionStatusLabels["claude-delegate"].
	// The text includes the resolved model version once a run has reported it.
	const statusText = (mode: DelegationMode) =>
		delegationLabel(mode, store.readModel(mode), resolveEffort(mode, store.readEffort(mode)));
	// This chat's sticky mode: while set, ordinary messages go to Claude Code
	// instead of the driver model. Restored from session entries on start.
	let sticky: Exclude<DelegationMode, "off"> | undefined;
	// Runs are serialised so follow-ups resume the same Claude session in order.
	let queue: Promise<void> = Promise.resolve();

	// "claude-sticky" is set only while this chat is on Claude Code, so ACB's
	// settings toggle can show and flip the per-chat state.
	const setStatus = (mode: DelegationMode, ctx: StatusContext) => {
		ctx.ui.setStatus("claude-delegate", statusText(mode));
		ctx.ui.setStatus("claude-sticky", sticky ? statusText(sticky) : undefined);
	};
	const restoreStatus = (ctx: StatusContext) => setStatus(store.readMode(), ctx);

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
				sessionKey: sessionKey(ctx),
				signal: signal ?? undefined,
				onText: (tail) => {
					const now = Date.now();
					if (now - lastUpdate < 1500) return;
					lastUpdate = now;
					onUpdate?.({ content: [{ type: "text", text: tail }], details: {} });
				},
			});

			if (outcome.models[0]) {
				const statusCtx = ctx as unknown as StatusContext | undefined;
				if (statusCtx?.ui) restoreStatus(statusCtx);
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

	/**
	 * Direct passthrough: the prompt goes to headless Claude Code without a
	 * driver-model turn. The prompt is recorded first (so it stays in the
	 * history even if the run fails); the result follows as a note.
	 */
	const delegateDirect = (
		task: string,
		mode: Exclude<DelegationMode, "off">,
		ctx: StatusContext & { ui: { notify(message: string, type?: string): void } },
		key: string,
	): Promise<void> => {
		const label = statusText(mode);
		pi.sendMessage({
			customType: PROMPT_MESSAGE_TYPE,
			content: task,
			display: true,
			details: { target: "Claude Code", label },
		});
		const run = async () => {
			ctx.ui.notify(`Sending to Claude Code (${label})…`, "info");
			const trace = new RunTrace(ctx, mode);
			const startedAt = Date.now();
			// The status label doubles as a heartbeat: elapsed time, the tool in
			// flight and how long the stream has been quiet, so a stuck run is
			// visibly different from a busy one (there is no time limit).
			const beat = () => {
				const elapsed = formatElapsed(Date.now() - startedAt);
				const quiet = Date.now() - trace.lastEventAt;
				const doing = trace.pendingTools[0] ?? "working";
				const warn = quiet >= QUIET_WARNING_MS ? ` · ⚠ quiet ${formatElapsed(quiet)}` : "";
				ctx.ui.setStatus("claude-progress", `${label} · ${doing} · ${elapsed}${warn}`);
			};
			const heartbeat = setInterval(beat, HEARTBEAT_MS);
			beat();
			try {
				const { outcome, label: resolved } = await performDelegation(store, workspace, runTask, {
					task,
					mode,
					sessionKey: key,
					onEvent: (event) => {
						trace.handle(event);
						beat();
					},
				});
				const primaryModel = outcome.models[0];
				if (outcome.isError) {
					const failure = outcome.resultText ?? "Delegated task failed.";
					ctx.ui.notify(failure, "error");
					mirrorReplyToSession(ctx, `⚠ ${failure}`, primaryModel ?? mode, trace.trailingThinking);
					return;
				}
				const footer = primaryModel ? `\n\n— ${resolved} (\`${primaryModel}\`)` : "";
				const reply = `${outcome.resultText ?? "Task finished with no summary text."}${footer}`;
				// ACB renders extension display notes for customType "note"
				// (display:true, no triggerTurn). The assistant mirror right after
				// it is what persists the chat; ACB's history drops the note then.
				pi.sendMessage({ customType: "note", content: reply, display: true });
				mirrorReplyToSession(ctx, reply, primaryModel ?? mode, trace.trailingThinking);
			} catch (error) {
				const failure = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(failure, "error");
				mirrorReplyToSession(ctx, `⚠ ${failure}`, mode, trace.trailingThinking);
			} finally {
				clearInterval(heartbeat);
				ctx.ui.setStatus("claude-progress", undefined);
				// Restore the steady-state label (now with the resolved version).
				restoreStatus(ctx);
			}
		};
		const next = queue.then(run);
		queue = next.catch(() => undefined);
		return next;
	};

	pi.registerCommand("cc", {
		description:
			"send a task straight to headless Claude Code: /cc [opus|sonnet|haiku] <task>; /cc on|off keeps this chat on Claude Code",
		handler: async (rawArgs, ctx) => {
			const control = parseCcControl(rawArgs);
			if (control?.kind === "status") {
				ctx.ui.notify(
					sticky
						? `This chat sends every message to Claude Code (${statusText(sticky)}). /cc off returns it to pi.`
						: "This chat uses pi. /cc on sends every message to Claude Code.",
					"info",
				);
				return;
			}
			if (control?.kind === "off") {
				if (sticky) pi.appendEntry(STICKY_ENTRY_TYPE, { mode: "off" });
				sticky = undefined;
				restoreStatus(ctx);
				ctx.ui.notify("Claude Code mode off — this chat is back on pi.", "info");
				return;
			}
			if (control?.kind === "on") {
				const current = store.readMode();
				const mode = control.mode ?? (current === "off" ? "sonnet" : current);
				sticky = mode;
				pi.appendEntry(STICKY_ENTRY_TYPE, { mode });
				restoreStatus(ctx);
				ctx.ui.notify(
					`Claude Code mode on (${statusText(mode)}) — every message in this chat goes to Claude Code until /cc off.`,
					"info",
				);
				return;
			}

			const { mode: requested, task } = parseCcArgs(rawArgs);
			if (!task) {
				ctx.ui.notify("Usage: /cc [opus|sonnet|haiku] <task>, or /cc on|off|status", "warning");
				return;
			}
			const mode = requested ?? sticky ?? store.readMode();
			if (mode === "off") {
				ctx.ui.notify(
					"Claude Code delegation is off. Pick a model with /claude, or prefix the task: /cc sonnet <task>.",
					"warning",
				);
				return;
			}
			await delegateDirect(task, mode, ctx, sessionKey(ctx));
		},
	});

	pi.on("input", (event, ctx) => {
		// Extension-injected prompts, skills/templates and mid-run steering
		// keep their normal pi route; only plain typed messages are diverted.
		if (!sticky || event.source === "extension") return { action: "continue" };
		if (event.streamingBehavior || event.text.trimStart().startsWith("/")) {
			return { action: "continue" };
		}
		const task = event.text.trim();
		if (!task) return { action: "continue" };
		// Not awaited: pi acknowledges the prompt now and the run reports
		// through the prompt bubble, status label and result note.
		void delegateDirect(task, sticky, ctx, sessionKey(ctx));
		return { action: "handled" };
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
		sticky = restoreStickyMode(ctx.sessionManager?.getEntries?.() ?? []);
		restoreStatus(ctx);
		syncToolAvailability(mode);
	});

	return { whenIdle: () => queue };
}

export default function claudeDelegate(pi: ExtensionAPI): void {
	registerClaudeDelegate(pi, new FileDelegationStore());
}
