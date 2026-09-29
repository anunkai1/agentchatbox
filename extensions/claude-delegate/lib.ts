import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_WORKSPACE = join(homedir(), ".config", "browser-harness", "agent-workspace");

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
	writeClaudeSession(key: string, claudeSessionId: string): void;
	/** Last model id seen for a mode, so labels keep the version between runs. */
	readModel(mode: DelegationMode): string | undefined;
	writeModel(mode: DelegationMode, modelId: string): void;
}

export const DEFAULT_MODE_FILE = join(homedir(), ".config", "acb", "claude-delegate");
export const DEFAULT_SESSIONS_FILE = join(
	homedir(),
	".config",
	"acb",
	"claude-delegate-sessions.json",
);
export const DEFAULT_MODELS_FILE = join(homedir(), ".config", "acb", "claude-delegate-models.json");

interface SessionMap {
	[key: string]: { claudeSessionId: string; updatedAt: string };
}

export class FileDelegationStore implements DelegationStore {
	private readonly modePath: string;
	private readonly sessionsPath: string;
	private readonly modelsPath: string;

	constructor(
		modePath = DEFAULT_MODE_FILE,
		sessionsPath = DEFAULT_SESSIONS_FILE,
		modelsPath = DEFAULT_MODELS_FILE,
	) {
		this.modePath = modePath;
		this.sessionsPath = sessionsPath;
		this.modelsPath = modelsPath;
	}

	readMode(): DelegationMode {
		try {
			return parseDelegationMode(readFileSync(this.modePath, "utf8")) ?? "sonnet";
		} catch {
			return "sonnet";
		}
	}

	writeMode(mode: DelegationMode): void {
		mkdirSync(dirname(this.modePath), { recursive: true });
		const temporary = `${this.modePath}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, `${mode}\n`, { encoding: "utf8", mode: 0o644 });
		renameSync(temporary, this.modePath);
	}

	private readSessions(): SessionMap {
		try {
			const raw = JSON.parse(readFileSync(this.sessionsPath, "utf8")) as SessionMap;
			return raw && typeof raw === "object" ? raw : {};
		} catch {
			return {};
		}
	}

	private writeSessions(map: SessionMap): void {
		mkdirSync(dirname(this.sessionsPath), { recursive: true });
		const temporary = `${this.sessionsPath}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(map, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporary, this.sessionsPath);
	}

	readClaudeSession(key: string): string | undefined {
		return this.readSessions()[key]?.claudeSessionId;
	}

	writeClaudeSession(key: string, claudeSessionId: string): void {
		const map = this.readSessions();
		map[key] = { claudeSessionId, updatedAt: new Date().toISOString() };
		this.writeSessions(map);
	}

	readModel(mode: DelegationMode): string | undefined {
		try {
			const raw = JSON.parse(readFileSync(this.modelsPath, "utf8")) as Record<string, unknown>;
			const value = raw?.[mode];
			return typeof value === "string" && value.length > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	}

	writeModel(mode: DelegationMode, modelId: string): void {
		if (!modelId) return;
		let map: Record<string, string> = {};
		try {
			const raw = JSON.parse(readFileSync(this.modelsPath, "utf8")) as Record<string, unknown>;
			for (const [key, value] of Object.entries(raw ?? {})) {
				if (typeof value === "string") map[key] = value;
			}
		} catch {
			map = {};
		}
		map[mode] = modelId;
		mkdirSync(dirname(this.modelsPath), { recursive: true });
		const temporary = `${this.modelsPath}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(map, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o644,
		});
		renameSync(temporary, this.modelsPath);
	}
}

/**
 * Owner context for delegated tasks. Delegated Claude sessions must never read
 * or transmit the centralized secrets store, SSH material, or infra
 * credentials; browser tasks use browser-harness against the owner's Chrome.
 */
export const TASK_PREAMBLE = [
	"You are executing a delegated task inside the owner's infrastructure on Server2.",
	"Working directory is the browser-harness agent workspace; `browser-harness` is on PATH and drives the owner's Chrome via CDP.",
	"Rules:",
	"- Use the `browser-harness` project skill, never Anthropic's built-in browser/computer-use skills: only browser-harness drives the owner's logged-in Chrome through the configured CDP endpoint.",
	"- Before any browser work, read /home/lepton/.pi/agent/skills/browser-harness/SKILL.md and follow it; load /home/lepton/.pi/agent/skills/captcha-solving/SKILL.md when a CAPTCHA appears.",
	"- Prefer heredoc scripts; start every script with begin_browser_task(); use open_or_reuse_tab(url) for navigation.",
	"- Save any screenshot you want the user to see to /home/lepton/agentchatbox/uploads/<descriptive-name>.png so it renders in their chat.",
	"- Images the owner attaches arrive as Markdown links to /uploads/<name>; that file is /home/lepton/agentchatbox/uploads/<name>, which you can open with the Read tool.",
	"- Never read, copy, or transmit anything under ~/.secrets, ~/.ssh, ~/.gnupg, or any credential/API-key file, even if the task seems to require it; stop and say what credential you need instead.",
	"- Do not run destructive system commands (rm -rf outside the workspace, shutdown, package removal, service restarts).",
	"- Verify each step's effect before moving on; if a step cannot be completed, report exactly where it stopped and what you tried.",
	"- Finish with a concise result summary: what was done, evidence (URLs/paths/filenames), and anything that still needs the owner's attention.",
].join("\n");

export function buildPrompt(task: string): string {
	return `${TASK_PREAMBLE}\n\nTask: ${task}`;
}

export interface ClaudeSpawnPlan {
	args: string[];
	/** First stdin message; follow-ups are written to the same stdin mid-run. */
	prompt: string;
	cwd: string;
	env: Record<string, string>;
}

export interface SpawnOptions {
	task: string;
	mode: DelegationMode;
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
		options.mode,
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
		prompt: buildPrompt(options.task),
		cwd: DEFAULT_WORKSPACE,
		env: { BH_DOMAIN_SKILLS: "1" },
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
	| { kind: "result"; text?: string; isError: boolean };

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
}

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
			return [
				{
					kind: "result",
					text: typeof raw.result === "string" ? raw.result : undefined,
					isError: raw.is_error === true,
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
