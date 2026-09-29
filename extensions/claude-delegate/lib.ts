import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_WORKSPACE = join(homedir(), ".config", "browser-harness", "agent-workspace");

/**
 * Custom message carrying the prompt the owner sent to Claude Code. ACB draws
 * it as a user bubble so /cc and sticky-mode prompts survive in the history.
 */
export const PROMPT_MESSAGE_TYPE = "claude-prompt";
/** Provider tag on the assistant messages that mirror a Claude Code reply. */
export const MIRROR_PROVIDER = "claude-code";
/** `details.source` on the display notes this extension sends. */
export const NOTE_SOURCE = "claude-delegate";

export type DelegationMode = "opus" | "sonnet" | "haiku";

export const DELEGATION_MODES: readonly DelegationMode[] = ["opus", "sonnet", "haiku"];

export const MODE_LABELS: Record<DelegationMode, string> = {
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
};

/** Claude Code's own default is `medium`; the owner wants `high` for agentic browser work. */
export type EffortLevel = "high";

/** Haiku 4.5 has no effort parameter, so it stays undefined. */
export const DEFAULT_EFFORT: Record<DelegationMode, EffortLevel | undefined> = {
	opus: "high",
	sonnet: "high",
	haiku: undefined,
};

/**
 * Turn a wire model id into a short human label: `claude-opus-5-5` →
 * `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`.
 */
export function prettyModelName(id: string): string {
	const raw = id.replace(/^claude-/, "");
	const parts = raw.split("-");
	const family = parts.shift() ?? raw;
	const version = parts.filter((part) => /^\d+$/.test(part) && part.length <= 2);
	const label = family.length > 0 ? family.charAt(0).toUpperCase() + family.slice(1) : raw;
	return version.length > 0 ? `${label} ${version.join(".")}` : label;
}

/** Status text ACB shows: resolved version, plus effort when one applies. */
export function delegationLabel(
	mode: DelegationMode,
	modelId?: string,
	effort?: EffortLevel,
): string {
	const base = MODE_LABELS[mode];
	const versioned = (() => {
		if (!modelId) return base;
		const pretty = prettyModelName(modelId);
		return pretty.toLowerCase().startsWith(base.toLowerCase()) ? pretty : `${base} (${pretty})`;
	})();
	return effort ? `${versioned} · ${effort}` : versioned;
}

export function parseDelegationMode(raw: string): DelegationMode | undefined {
	const value = raw.trim().toLowerCase();
	return DELEGATION_MODES.find((mode) => mode === value);
}

export interface DelegationStore {
	/** The model `/cc` uses when none is named; Sonnet until chosen. */
	readMode(): DelegationMode;
	writeMode(mode: DelegationMode): void;
	readClaudeSession(key: string): string | undefined;
	/** `pin` records the model id this chat's conversation runs on for a mode. */
	writeClaudeSession(
		key: string,
		claudeSessionId: string,
		pin?: { mode: DelegationMode; model: string },
	): void;
	/** Forget a chat's Claude session so its next run starts a fresh conversation. */
	clearClaudeSession(key: string): void;
	/**
	 * The model id a chat's Claude conversation started on, per mode. Resuming
	 * with it keeps a conversation on one model when an alias moves on.
	 */
	readPinnedModel(key: string, mode: DelegationMode): string | undefined;
	/** Last model id seen for a mode, so labels keep the version between runs. */
	readModel(mode: DelegationMode): string | undefined;
	writeModel(mode: DelegationMode, modelId: string): void;
}

export const DEFAULT_MODE_FILE = join(homedir(), ".config", "acb", "claude-delegate");
/** One file per chat, so chats finishing together never overwrite each other. */
export const DEFAULT_SESSIONS_DIR = join(homedir(), ".config", "acb", "claude-delegate-sessions");
/** The single-file map older versions wrote; still read as a fallback. */
export const LEGACY_SESSIONS_FILE = join(
	homedir(),
	".config",
	"acb",
	"claude-delegate-sessions.json",
);
/** One file per mode, for the same reason. */
export const DEFAULT_MODELS_DIR = join(homedir(), ".config", "acb", "claude-delegate-models");

interface SessionRecord {
	claudeSessionId: string;
	updatedAt: string;
	models?: Record<string, string>;
}

/** Chat keys become file names, so keep them to a safe character set. */
function safeName(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
}

function writeAtomic(path: string, content: string, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, content, { encoding: "utf8", mode });
	renameSync(temporary, path);
}

export class FileDelegationStore implements DelegationStore {
	constructor(
		private readonly modePath = DEFAULT_MODE_FILE,
		private readonly sessionsDir = DEFAULT_SESSIONS_DIR,
		private readonly modelsDir = DEFAULT_MODELS_DIR,
		private readonly legacySessionsPath: string | undefined = LEGACY_SESSIONS_FILE,
	) {}

	readMode(): DelegationMode {
		try {
			return parseDelegationMode(readFileSync(this.modePath, "utf8")) ?? "sonnet";
		} catch {
			return "sonnet";
		}
	}

	writeMode(mode: DelegationMode): void {
		writeAtomic(this.modePath, `${mode}\n`, 0o644);
	}

	private sessionPath(key: string): string {
		return join(this.sessionsDir, `${safeName(key)}.json`);
	}

	private readRecord(key: string): SessionRecord | undefined {
		try {
			const raw = JSON.parse(readFileSync(this.sessionPath(key), "utf8")) as SessionRecord;
			if (raw && typeof raw.claudeSessionId === "string") return raw;
		} catch {
			// fall through to the legacy map
		}
		if (!this.legacySessionsPath) return undefined;
		try {
			const legacy = JSON.parse(readFileSync(this.legacySessionsPath, "utf8")) as Record<
				string,
				SessionRecord
			>;
			const entry = legacy?.[key];
			return entry && typeof entry.claudeSessionId === "string" ? entry : undefined;
		} catch {
			return undefined;
		}
	}

	readClaudeSession(key: string): string | undefined {
		return this.readRecord(key)?.claudeSessionId || undefined;
	}

	writeClaudeSession(
		key: string,
		claudeSessionId: string,
		pin?: { mode: DelegationMode; model: string },
	): void {
		const previous = this.readRecord(key);
		// Pins belong to one conversation; a new Claude session starts with none.
		const models = previous?.claudeSessionId === claudeSessionId ? { ...previous.models } : {};
		if (pin?.model) models[pin.mode] = pin.model;
		const record: SessionRecord = { claudeSessionId, updatedAt: new Date().toISOString(), models };
		writeAtomic(this.sessionPath(key), `${JSON.stringify(record, null, "\t")}\n`, 0o600);
	}

	clearClaudeSession(key: string): void {
		rmSync(this.sessionPath(key), { force: true });
		// The legacy fallback would otherwise bring the cleared session back.
		if (this.legacySessionsPath && this.readRecord(key)) {
			writeAtomic(
				this.sessionPath(key),
				`${JSON.stringify({ claudeSessionId: "", updatedAt: new Date().toISOString() })}\n`,
				0o600,
			);
		}
	}

	readPinnedModel(key: string, mode: DelegationMode): string | undefined {
		const value = this.readRecord(key)?.models?.[mode];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	}

	readModel(mode: DelegationMode): string | undefined {
		try {
			const value = readFileSync(join(this.modelsDir, mode), "utf8").trim();
			return value || undefined;
		} catch {
			return undefined;
		}
	}

	writeModel(mode: DelegationMode, modelId: string): void {
		if (!modelId) return;
		writeAtomic(join(this.modelsDir, mode), `${modelId}\n`, 0o644);
	}
}

/**
 * Owner context for Claude Code runs. It carries the same rules as ACB's pi
 * assistant (the two AGENTS.md files) plus the facts that differ for Claude
 * Code: which browser skill to use and how files reach the chat.
 */
export const TASK_PREAMBLE = [
	"You are the owner's assistant, running from their AgentChatBox (ACB) chat on Server2.",
	"Follow the same rules as ACB's own assistant: /home/lepton/AGENTS.md (already loaded) and /home/lepton/agentchatbox/AGENTS.md.",
	"- For browser work, use the `browser-harness` project skill, never Anthropic's built-in browser/computer-use skills: only browser-harness drives the owner's logged-in Chrome.",
	"- Save files the owner should see, such as screenshots, to /home/lepton/agentchatbox/uploads/<descriptive-name> and link them as /uploads/<descriptive-name>; images render in the chat.",
	"- Images the owner attaches arrive as Markdown links to /uploads/<name>; open /home/lepton/agentchatbox/uploads/<name> with the Read tool.",
].join("\n");

/**
 * The first message of a conversation carries the owner context. A resumed
 * conversation already holds it, so later runs send the bare task.
 */
export function buildPrompt(task: string, resumed = false, catchUp?: string): string {
	const body = catchUp ? `${catchUp}\n\nTask: ${task}` : resumed ? task : `Task: ${task}`;
	return resumed ? body : `${TASK_PREAMBLE}\n\n${body}`;
}

export interface ClaudeSpawnPlan {
	args: string[];
	/** First stdin message; follow-ups are written to the same stdin mid-run. */
	prompt: string;
	cwd: string;
}

export interface SpawnOptions {
	task: string;
	mode: DelegationMode;
	/** Working directory for the run. */
	workspace?: string;
	/** Chat history Claude Code has not seen yet, placed before the task. */
	catchUp?: string;
	/** Exact model id to run on; defaults to the mode's alias. */
	model?: string;
	resumeSessionId?: string;
	newSessionId?: string;
	/** Passed as --effort; omitted for models without effort support. */
	effort?: EffortLevel;
}

/**
 * Compose the headless `claude -p` invocation for one delegated task. Input is
 * stream-json so follow-ups can be written to stdin while the run is live:
 * Claude Code folds each one in at its next step, like pi's steering. Replayed
 * user messages show when a follow-up has been picked up.
 */
export function buildClaudeSpawn(options: SpawnOptions): ClaudeSpawnPlan {
	const args = [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--replay-user-messages",
		"--verbose",
		"--dangerously-skip-permissions",
		// Without this the API returns thinking blocks with empty text, so
		// there would be nothing to show in ACB's thinking rows. The
		// showThinkingSummaries setting does not apply to headless -p runs.
		"--thinking-display",
		"summarized",
		"--model",
		options.model ?? options.mode,
	];
	if (options.effort) {
		args.push("--effort", options.effort);
	}
	if (options.resumeSessionId) {
		args.push("--resume", options.resumeSessionId);
	} else if (options.newSessionId) {
		args.push("--session-id", options.newSessionId);
	}
	return {
		args,
		prompt: buildPrompt(options.task, Boolean(options.resumeSessionId), options.catchUp),
		cwd: options.workspace ?? DEFAULT_WORKSPACE,
	};
}

export type StreamEvent =
	| { kind: "init"; claudeSessionId: string; model?: string }
	| { kind: "text"; text: string; model?: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool_use"; id: string; name: string; input: unknown }
	| { kind: "tool_result"; id: string; text: string; isError: boolean }
	/** Claude Code echoing a stdin user message it has just taken in. */
	| { kind: "prompt"; text: string }
	| {
			kind: "result";
			text?: string;
			isError: boolean;
			/** `--resume` named a conversation Claude Code no longer has. */
			staleSession?: boolean;
			usage?: RunUsage;
	  };

/** What a turn cost in tokens and time, from the stream's result event. */
export interface RunUsage {
	durationMs?: number;
	turns?: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

/** One stream-json stdin line carrying a user message. */
export function stdinUserMessage(text: string): string {
	return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

interface RawStreamEvent {
	type?: string;
	subtype?: string;
	session_id?: unknown;
	model?: unknown;
	message?: { model?: unknown; content?: unknown };
	result?: unknown;
	is_error?: unknown;
	isReplay?: unknown;
	errors?: unknown;
	duration_ms?: unknown;
	num_turns?: unknown;
	usage?: {
		input_tokens?: unknown;
		output_tokens?: unknown;
		cache_creation_input_tokens?: unknown;
		cache_read_input_tokens?: unknown;
	};
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

/** Incremental parser for `claude -p --output-format stream-json --verbose` stdout. */
export class StreamParser {
	private buffer = "";

	/** Feed one chunk of stdout; returns the events completed by it. */
	feed(chunk: string): StreamEvent[] {
		this.buffer += chunk;
		const events: StreamEvent[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) events.push(...this.parseLine(line));
			newline = this.buffer.indexOf("\n");
		}
		return events;
	}

	parseLine(line: string): StreamEvent[] {
		let raw: RawStreamEvent;
		try {
			raw = JSON.parse(line) as RawStreamEvent;
		} catch {
			return []; // Non-JSON noise (banners, warnings) is ignored.
		}
		if (raw.type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") {
			return [
				{
					kind: "init",
					claudeSessionId: raw.session_id,
					model: typeof raw.model === "string" ? raw.model : undefined,
				},
			];
		}
		if (raw.type === "assistant" && Array.isArray(raw.message?.content)) {
			const blocks = raw.message.content as ContentBlock[];
			const events: StreamEvent[] = [];
			for (const block of blocks) {
				if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
					events.push({ kind: "thinking", text: block.thinking });
				}
			}
			const text = blocks
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => String(block.text))
				.join("\n")
				.trim();
			const model = typeof raw.message?.model === "string" ? raw.message.model : undefined;
			if (text || model) events.push({ kind: "text", text, model });
			for (const block of blocks) {
				if (block?.type === "tool_use" && typeof block.id === "string") {
					events.push({
						kind: "tool_use",
						id: block.id,
						name: typeof block.name === "string" ? block.name : "tool",
						input: block.input,
					});
				}
			}
			return events;
		}
		if (raw.type === "user" && raw.isReplay === true) {
			const content = raw.message?.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? toolResultText(content)
						: "";
			return [{ kind: "prompt", text }];
		}
		if (raw.type === "user" && Array.isArray(raw.message?.content)) {
			const events: StreamEvent[] = [];
			for (const block of raw.message.content as ContentBlock[]) {
				if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
					events.push({
						kind: "tool_result",
						id: block.tool_use_id,
						text: toolResultText(block.content),
						isError: block.is_error === true,
					});
				}
			}
			return events;
		}
		if (raw.type === "result") {
			const errors = Array.isArray(raw.errors) ? raw.errors.map(String) : [];
			const usage = raw.usage
				? {
						durationMs: typeof raw.duration_ms === "number" ? raw.duration_ms : undefined,
						turns: typeof raw.num_turns === "number" ? raw.num_turns : undefined,
						// Cache writes are input the model read, so they count with fresh input.
						inputTokens: num(raw.usage.input_tokens) + num(raw.usage.cache_creation_input_tokens),
						outputTokens: num(raw.usage.output_tokens),
						cacheReadTokens: num(raw.usage.cache_read_input_tokens),
					}
				: undefined;
			return [
				{
					kind: "result",
					text: typeof raw.result === "string" ? raw.result : undefined,
					isError: raw.is_error === true,
					staleSession: errors.some((e) => e.includes("No conversation found")) || undefined,
					usage,
				},
			];
		}
		return [];
	}
}

interface ContentBlock {
	type?: string;
	text?: unknown;
	thinking?: unknown;
	id?: unknown;
	name?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
	content?: unknown;
	is_error?: unknown;
}

/** Flatten a tool_result's content (a string or a list of text blocks). */
function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as ContentBlock | undefined;
			if (block?.type === "text" && typeof block.text === "string") return block.text;
			return block?.type === "image" ? "[image]" : "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Shape a Claude Code tool input for ACB's tool cards: they key on `command`
 * and `path`, so `file_path` is mirrored to `path`; long strings are capped so
 * a big Write does not bloat the chat.
 */
export function normaliseToolArgs(input: unknown, limit = 2000): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return input === undefined ? {} : { value: input };
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		out[key] =
			typeof value === "string" && value.length > limit
				? `${value.slice(0, limit)}… [${value.length - limit} more characters]`
				: value;
	}
	if (typeof out.path !== "string" && typeof out.file_path === "string") out.path = out.file_path;
	return out;
}

/** Cap a persisted/live tool result so a huge dump cannot bloat the chat. */
export const TOOL_RESULT_LIMIT = 4000;
export function capToolResult(text: string, limit = TOOL_RESULT_LIMIT): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… [${text.length - limit} more characters truncated]`;
}

/** A Claude Code process this extension started and has not yet seen exit. */
export interface RunRecord {
	/** Claude Code's pid (also its process-group id: runs are spawned detached). */
	pid: number;
	/** The pi process that owns the run; a run whose owner is gone is an orphan. */
	owner: number;
	/** ACB chat session id the run belongs to. */
	chat: string;
	mode: DelegationMode;
	startedAt: string;
}

export const DEFAULT_RUNS_DIR = join(homedir(), ".config", "acb", "claude-delegate-runs");

/** True when `pid` is alive and (where /proc allows a check) still looks like Claude Code. */
export function isClaudeProcess(pid: number): boolean {
	if (!processAlive(pid)) return false;
	try {
		return /claude/.test(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
	} catch {
		return true; // No /proc (or unreadable): trust the signal check.
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Every process below `root`, from /proc (Linux); empty where /proc is missing. */
export function descendantsOf(root: number): number[] {
	const children = new Map<number, number[]>();
	try {
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			try {
				const stat = readFileSync(`/proc/${name}/stat`, "utf8");
				// "pid (comm) state ppid ...": comm may hold spaces and parentheses.
				const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
				children.set(ppid, [...(children.get(ppid) ?? []), Number(name)]);
			} catch {
				// exited while we looked
			}
		}
	} catch {
		return [];
	}
	const found: number[] = [];
	const queue = [root];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		for (const child of children.get(next) ?? []) {
			found.push(child);
			queue.push(child);
		}
	}
	return found;
}

/**
 * Stop a run and everything it started. Claude Code's Bash tool puts each
 * command in a process group of its own, so signalling Claude Code's group is
 * not enough: the process tree is tracked as well (re-read while waiting, since
 * children reparent to init once their parent dies). Everything gets SIGTERM,
 * then SIGKILL if it is still there after the grace period.
 */
export async function terminateRun(pid: number, graceMs = 5000): Promise<void> {
	const known = new Set<number>([pid]);
	const collect = () => {
		for (const child of descendantsOf(pid)) known.add(child);
	};
	const signalAll = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal); // Claude Code's own group
		} catch {
			// no such group
		}
		for (const member of known) {
			try {
				process.kill(member, signal);
			} catch {
				// already gone
			}
		}
	};
	collect();
	signalAll("SIGTERM");
	const deadline = Date.now() + graceMs;
	while ([...known].some(processAlive) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		collect();
	}
	if ([...known].some(processAlive)) signalAll("SIGKILL");
}

/**
 * The live runs across every chat, one small file per run. It answers "what
 * is running?" for `/cc ps`, lets `/cc stop` reach a run from any chat, and
 * lets a fresh pi process find and reap runs whose owner died.
 */
export class RunRegistry {
	constructor(
		private readonly dir = DEFAULT_RUNS_DIR,
		private readonly alive: (pid: number) => boolean = isClaudeProcess,
		private readonly ownerAlive: (pid: number) => boolean = processAlive,
	) {}

	private path(pid: number): string {
		return join(this.dir, `${pid}.json`);
	}

	add(record: RunRecord): void {
		writeAtomic(this.path(record.pid), `${JSON.stringify(record)}\n`, 0o600);
	}

	remove(pid: number): void {
		rmSync(this.path(pid), { force: true });
	}

	/** Runs that are really still going; records of dead processes are deleted. */
	list(): RunRecord[] {
		let names: string[];
		try {
			names = readdirSync(this.dir).filter((name) => name.endsWith(".json"));
		} catch {
			return [];
		}
		const runs: RunRecord[] = [];
		for (const name of names) {
			try {
				const record = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as RunRecord;
				if (typeof record.pid === "number" && this.alive(record.pid)) runs.push(record);
				else rmSync(join(this.dir, name), { force: true });
			} catch {
				rmSync(join(this.dir, name), { force: true });
			}
		}
		return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}

	/** Stop runs whose owning pi process has died. Returns the pids stopped. */
	async reapOrphans(): Promise<number[]> {
		const orphans = this.list().filter((run) => !this.ownerAlive(run.owner));
		await Promise.all(orphans.map((run) => terminateRun(run.pid)));
		for (const run of orphans) this.remove(run.pid);
		return orphans.map((run) => run.pid);
	}
}
