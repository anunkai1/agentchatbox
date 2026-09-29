import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	buildClaudeSpawn,
	capToolResult,
	DEFAULT_EFFORT,
	DEFAULT_WORKSPACE,
	DELEGATION_MODES,
	type DelegationMode,
	type DelegationStore,
	delegationLabel,
	FileDelegationStore,
	normaliseToolArgs,
	parseDelegationMode,
	type StreamEvent,
	StreamParser,
	stdinUserMessage,
} from "./lib.js";
/**
 * Custom message carrying the prompt the owner sent to Claude Code. ACB draws
 * it as a user bubble so /cc and sticky-mode prompts survive in the history.
 */
export const PROMPT_MESSAGE_TYPE = "claude-prompt";
/** Session entry recording this chat's sticky mode; the last entry wins. */
export const STICKY_ENTRY_TYPE = "claude-sticky";

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

/** Parse `/cc [opus|sonnet|haiku] <task>`; the model token is optional. */
export function parseCcArgs(raw: string): { mode?: DelegationMode; task: string } {
	const trimmed = raw.trim();
	const [first, ...rest] = trimmed.split(/\s+/);
	const asMode = first ? parseDelegationMode(first.toLowerCase()) : undefined;
	if (asMode && rest.length > 0) {
		return { mode: asMode, task: rest.join(" ") };
	}
	return { task: trimmed };
}

export type CcControl =
	| { kind: "on"; mode?: DelegationMode }
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
	if (!mode) return undefined;
	return { kind: "on", mode };
}

/** Read this chat's sticky mode back from its session entries. */
export function restoreStickyMode(
	entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
): DelegationMode | undefined {
	let sticky: DelegationMode | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STICKY_ENTRY_TYPE) continue;
		const raw = (entry.data as { mode?: unknown } | undefined)?.mode;
		const mode = typeof raw === "string" ? parseDelegationMode(raw) : undefined;
		sticky = mode;
	}
	return sticky;
}

/**
 * The stdin of a live run. Follow-ups written here reach Claude Code at its
 * next step (after the tool in flight), like pi's steering. Replayed prompts
 * count as consumed; once a turn ends with nothing pending the channel closes
 * stdin so the run exits, and later messages start a new, resumed run.
 */
export class SteerChannel {
	sent = 0;
	consumed = 0;
	private write?: (line: string) => void;
	private end?: () => void;
	private closed = false;

	attach(write: (line: string) => void, end: () => void): void {
		this.write = write;
		this.end = end;
	}

	/** Messages written but not yet taken in by Claude Code. */
	get pending(): number {
		return Math.max(0, this.sent - this.consumed);
	}

	/** Pending follow-ups, not counting the run's own first prompt. */
	get queuedFollowUps(): number {
		return Math.max(0, this.sent - Math.max(this.consumed, 1));
	}

	send(text: string): boolean {
		if (this.closed || !this.write) return false;
		this.write(stdinUserMessage(text));
		this.sent += 1;
		return true;
	}

	/** A turn finished: close unless a follow-up still waits to be taken in. */
	turnEnded(): void {
		if (this.pending === 0) this.close();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.end?.();
	}
}

export interface DelegationRequest {
	task: string;
	mode: DelegationMode;
	/** Chat the run belongs to; keys Claude session continuity. */
	sessionKey: string;
	/** Live stdin for follow-ups while this run is going. */
	channel?: SteerChannel;
	/** Every parsed stream event (thinking, tool calls and results included). */
	onEvent?: (event: StreamEvent) => void;
}

export interface DelegationOutcome {
	outcome: SpawnOutcome;
	label: string;
}

/** Run one delegation: session continuity, effort, spawn, and model/session bookkeeping. */
export async function performDelegation(
	store: DelegationStore,
	workspace: string,
	runTask: typeof runClaudeTask,
	request: DelegationRequest,
): Promise<DelegationOutcome> {
	const key = request.sessionKey;
	const resumeId = store.readClaudeSession(key);
	const newSessionId = resumeId ? undefined : randomUUID();
	mkdirSync(workspace, { recursive: true });

	const mode = request.mode;

	const plan = buildClaudeSpawn({
		task: request.task,
		mode,
		resumeSessionId: resumeId,
		newSessionId,
		effort: DEFAULT_EFFORT[mode],
	});

	const outcome = await runTask(plan.args, {
		cwd: plan.cwd,
		env: {
			...plan.env,
			BH_TAB_SCOPE: `claude:${key}`,
			PATH: `${homedir()}/.npm-global/bin:${homedir()}/.local/bin:${process.env.PATH ?? ""}`,
		},
		prompt: plan.prompt,
		channel: request.channel,
		onEvent: request.onEvent,
	});

	if (outcome.claudeSessionId) store.writeClaudeSession(key, outcome.claudeSessionId);
	if (outcome.model) store.writeModel(mode, outcome.model);

	return {
		outcome,
		label: delegationLabel(mode, outcome.model ?? store.readModel(mode), DEFAULT_EFFORT[mode]),
	};
}

interface SpawnOutcome {
	resultText?: string;
	isError: boolean;
	claudeSessionId?: string;
	/** The wire model id Claude Code reported for the run. */
	model?: string;
}

/**
 * Pi exports PI_SESSION_ID only to bash children, not to extensions, so the
 * chat's own session id is the key whenever a context is available.
 */
function sessionKey(ctx: unknown): string {
	const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
		?.sessionManager;
	return manager?.getSessionId?.() || process.env.PI_SESSION_ID || "default";
}

/**
 * Run one headless `claude -p` task. Every parsed event goes through onEvent,
 * so ACB shows live progress while Claude works. There is no time limit: long
 * sessions are expected. With a prompt, stdin stays open as a SteerChannel for
 * follow-ups; the outcome carries the last turn's result.
 */
export function runClaudeTask(
	args: string[],
	options: {
		cwd: string;
		env: Record<string, string>;
		onEvent?: (event: StreamEvent) => void;
		/** First stream-json stdin message; without it stdin is closed. */
		prompt?: string;
		channel?: SteerChannel;
		/** Override the executable (tests use a stub that emits stream-json). */
		bin?: string;
	},
): Promise<SpawnOutcome> {
	return new Promise((resolve, reject) => {
		const bin = options.bin ?? (platform() === "win32" ? "claude.cmd" : "claude");
		const child = spawn(bin, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: [options.prompt === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});

		const channel = options.channel ?? new SteerChannel();
		if (options.prompt !== undefined && child.stdin) {
			const stdin = child.stdin;
			// A run that exits early must not crash pi on a late write.
			stdin.on("error", () => channel.close());
			channel.attach(
				(line) => stdin.write(line),
				() => stdin.end(),
			);
			channel.send(options.prompt);
		}

		const parser = new StreamParser();

		let stderr = "";
		let lastText = "";
		let claudeSessionId: string | undefined;

		let resultEvent: { text?: string; isError: boolean } | undefined;
		// The first model reported (init/assistant) is the primary; later ones
		// are subagents.
		let model: string | undefined;

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			for (const event of parser.feed(chunk)) {
				options.onEvent?.(event);
				if (event.kind === "init") {
					claudeSessionId = event.claudeSessionId;
					model ??= event.model;
				} else if (event.kind === "text") {
					model ??= event.model;
					if (event.text) lastText = event.text;
				} else if (event.kind === "prompt") {
					channel.consumed += 1;
				} else if (event.kind === "result") {
					resultEvent = { text: event.text, isError: event.isError };
					channel.turnEnded();
				}
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-4000);
		});

		child.on("error", (error) => {
			channel.close();
			reject(new Error(`Failed to start claude: ${error.message}`));
		});

		child.on("close", (code, signalName) => {
			channel.close();
			const outcome: SpawnOutcome = {
				resultText: resultEvent?.text ?? (lastText || undefined),
				isError: resultEvent?.isError === true || (code !== 0 && !resultEvent),
				claudeSessionId,
				model,
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
		private readonly fallbackModel: string,
	) {
		this.model = fallbackModel;
	}

	/** Tool calls started but not yet answered, oldest first. */
	get pendingTools(): string[] {
		return [...this.pending.values()];
	}

	/** Thinking not yet attached to a saved step; goes on the turn's reply. */
	takeTrailingThinking(): string[] {
		const thinking = this.thinking;
		this.thinking = [];
		this.text = "";
		return thinking;
	}

	/** The model id Claude Code reported, once it has. */
	get reportedModel(): string | undefined {
		return this.model === this.fallbackModel ? undefined : this.model;
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

export function registerClaudeDelegate(
	pi: ExtensionAPI,
	store: DelegationStore,
	workspace = DEFAULT_WORKSPACE,
	runTask: typeof runClaudeTask = runClaudeTask,
): { whenIdle(): Promise<void> } {
	// ACB reads extensionStatusLabels["claude-delegate"] for the default model.
	// The text includes the resolved model version once a run has reported it.
	const statusText = (mode: DelegationMode) =>
		delegationLabel(mode, store.readModel(mode), DEFAULT_EFFORT[mode]);
	// This chat's sticky mode: while set, ordinary messages go to Claude Code
	// instead of the driver model. Restored from session entries on start.
	let sticky: DelegationMode | undefined;
	// Runs are serialised so messages that miss a live run resume the same
	// Claude session in order.
	let queue: Promise<void> = Promise.resolve();

	// "claude-sticky" is set only while this chat is on Claude Code, so ACB's
	// settings toggle can show and flip the per-chat state.
	const restoreStatus = (ctx: StatusContext) => {
		ctx.ui.setStatus("claude-delegate", statusText(store.readMode()));
		ctx.ui.setStatus("claude-sticky", sticky ? statusText(sticky) : undefined);
	};

	// The run currently going, so a follow-up can join it instead of queueing.
	let live:
		| { key: string; mode: DelegationMode; channel: SteerChannel; beat: () => void }
		| undefined;

	/**
	 * Direct passthrough: the prompt goes to headless Claude Code without a
	 * driver-model turn. The prompt is recorded first (so it stays in the
	 * history even if the run fails); each turn's result follows as a note.
	 * While a run for this chat and model is live, the prompt is written into
	 * it as a follow-up, and Claude Code takes it in at its next step.
	 */
	const delegateDirect = (
		task: string,
		mode: DelegationMode,
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
		if (live && live.key === key && live.mode === mode && live.channel.send(task)) {
			live.beat();
			ctx.ui.notify(
				"Added to the running Claude Code task; it picks this up at its next step.",
				"info",
			);
			return Promise.resolve();
		}
		const run = async () => {
			ctx.ui.notify(`Sending to Claude Code (${label})…`, "info");
			const trace = new RunTrace(ctx, mode);
			const channel = new SteerChannel();
			const startedAt = Date.now();
			let replies = 0;
			// The status label doubles as a heartbeat: elapsed time, the tool in
			// flight, follow-ups not yet taken in and how long the stream has been
			// quiet, so a stuck run is visibly different from a busy one (there is
			// no time limit).
			const beat = () => {
				const elapsed = formatElapsed(Date.now() - startedAt);
				const quiet = Date.now() - trace.lastEventAt;
				const doing = trace.pendingTools[0] ?? "working";
				const waiting = channel.queuedFollowUps;
				const queued = waiting > 0 ? ` · ⟳ ${waiting} queued` : "";
				const warn = quiet >= QUIET_WARNING_MS ? ` · ⚠ quiet ${formatElapsed(quiet)}` : "";
				ctx.ui.setStatus("claude-progress", `${label} · ${doing} · ${elapsed}${queued}${warn}`);
			};
			const fail = (failure: string, model: string) => {
				ctx.ui.notify(failure, "error");
				mirrorReplyToSession(ctx, `⚠ ${failure}`, model, trace.takeTrailingThinking());
			};
			const reply = (text: string | undefined, model: string | undefined) => {
				const resolved = delegationLabel(
					mode,
					model ?? store.readModel(mode),
					DEFAULT_EFFORT[mode],
				);
				const footer = model ? `\n\n— ${resolved} (\`${model}\`)` : "";
				const content = `${text ?? "Task finished with no summary text."}${footer}`;
				// ACB renders extension display notes for customType "note"
				// (display:true, no triggerTurn). The assistant mirror right after
				// it is what persists the chat; ACB's history drops the note then.
				pi.sendMessage({ customType: "note", content, display: true });
				mirrorReplyToSession(ctx, content, model ?? mode, trace.takeTrailingThinking());
			};
			live = { key, mode, channel, beat };
			const heartbeat = setInterval(beat, HEARTBEAT_MS);
			beat();
			try {
				const { outcome } = await performDelegation(store, workspace, runTask, {
					task,
					mode,
					sessionKey: key,
					channel,
					onEvent: (event) => {
						trace.handle(event);
						// A follow-up taken in after a turn ended starts another
						// turn, so every turn's result gets its own reply.
						if (event.kind === "result") {
							replies += 1;
							if (event.isError)
								fail(event.text ?? "Delegated task failed.", trace.reportedModel ?? mode);
							else reply(event.text, trace.reportedModel);
						}
						beat();
					},
				});
				if (replies > 0) return;
				if (outcome.isError) {
					fail(outcome.resultText ?? "Delegated task failed.", outcome.model ?? mode);
					return;
				}
				reply(outcome.resultText, outcome.model);
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error), mode);
			} finally {
				channel.close();
				if (live?.channel === channel) live = undefined;
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
				const mode = control.mode ?? store.readMode();
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
			await delegateDirect(task, requested ?? sticky ?? store.readMode(), ctx, sessionKey(ctx));
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

	// Chooses the model `/cc` uses when none is named (Sonnet until chosen).
	pi.registerCommand("claude", {
		description: "choose the default Claude Code model for /cc (opus/sonnet/haiku)",
		handler: async (rawArgs, ctx) => {
			const command = rawArgs.trim().toLowerCase();
			const current = store.readMode();

			let next: DelegationMode | undefined;
			if (!command || command === "menu") {
				// Menu entries carry the resolved version, so map them back by index
				// rather than re-parsing the label text.
				const entries = DELEGATION_MODES.map((mode) => ({
					mode,
					label: `${mode === current ? "✓ " : ""}${delegationLabel(mode, store.readModel(mode))}`,
				}));
				const selected = await ctx.ui.select(
					"Default Claude Code model",
					entries.map((entry) => entry.label),
				);
				next = entries.find((entry) => entry.label === selected)?.mode;
			} else if (command === "status") {
				ctx.ui.notify(`Default Claude Code model is ${statusText(current)}.`, "info");
				return;
			} else {
				next = parseDelegationMode(command);
				if (!next) {
					ctx.ui.notify("Usage: /claude [opus|sonnet|haiku|status|menu]", "warning");
					return;
				}
			}
			if (!next) return;

			store.writeMode(next);
			restoreStatus(ctx);
			ctx.ui.notify(`Default Claude Code model set to ${statusText(next)}.`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sticky = restoreStickyMode(ctx.sessionManager?.getEntries?.() ?? []);
		restoreStatus(ctx);
	});

	return { whenIdle: () => queue };
}

export default function claudeDelegate(pi: ExtensionAPI): void {
	registerClaudeDelegate(pi, new FileDelegationStore());
}
