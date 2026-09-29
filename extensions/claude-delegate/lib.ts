import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DelegationMode = "off" | "opus" | "sonnet" | "haiku";

export const DELEGATION_MODES: readonly DelegationMode[] = ["off", "opus", "sonnet", "haiku"];

/**
 * Alias order used to resolve wire model ids, cheapest first. `off` has no
 * model, so the probe never includes it.
 */
export const PROBE_MODES: readonly Exclude<DelegationMode, "off">[] = ["haiku", "sonnet", "opus"];

export const MODE_LABELS: Record<DelegationMode, string> = {
	off: "Off",
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
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

/** Status text ACB shows, including the resolved model version when known. */
export function delegationLabel(mode: DelegationMode, modelId?: string): string {
	const base = MODE_LABELS[mode];
	if (!modelId) return base;
	const pretty = prettyModelName(modelId);
	return pretty.toLowerCase().startsWith(base.toLowerCase()) ? pretty : `${base} (${pretty})`;
}

/** Claude Code accepts these short aliases for --model. */
export function modelAlias(mode: DelegationMode): "opus" | "sonnet" | "haiku" {
	switch (mode) {
		case "opus":
			return "opus";
		case "haiku":
			return "haiku";
		default:
			return "sonnet";
	}
}

export function parseDelegationMode(raw: string): DelegationMode | undefined {
	const value = raw.trim().toLowerCase();
	if (value === "0" || value === "off" || value === "disable" || value === "disabled") return "off";
	if (value === "1" || value === "on" || value === "enable" || value === "enabled") return "sonnet";
	const match = DELEGATION_MODES.find((mode) => mode === value);
	return match;
}

export interface DelegationStore {
	readMode(): DelegationMode;
	writeMode(mode: DelegationMode): void;
	readClaudeSession(key: string): string | undefined;
	writeClaudeSession(key: string, claudeSessionId: string): void;
	clearClaudeSession(key: string): void;
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
			return parseDelegationMode(readFileSync(this.modePath, "utf8")) ?? "off";
		} catch {
			return "off";
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

	clearClaudeSession(key: string): void {
		const map = this.readSessions();
		delete map[key];
		this.writeSessions(map);
	}

	readModel(mode: DelegationMode): string | undefined {
		if (mode === "off") return undefined;
		try {
			const raw = JSON.parse(readFileSync(this.modelsPath, "utf8")) as Record<string, unknown>;
			const value = raw?.[mode];
			return typeof value === "string" && value.length > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	}

	writeModel(mode: DelegationMode, modelId: string): void {
		if (mode === "off" || !modelId) return;
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
	cwd: string;
	env: Record<string, string>;
}

/**
 * Short, harmless task used to resolve which wire model an alias maps to.
 * Output is discarded; only the reported model id is kept.
 */
export const PROBE_TASK = "Reply with exactly: ok";

export interface SpawnOptions {
	task: string;
	mode: DelegationMode;
	resumeSessionId?: string;
	newSessionId?: string;
	cwd?: string;
	extraEnv?: Record<string, string>;
}

/** Compose the headless `claude -p` invocation for one delegated task. */
export function buildClaudeSpawn(options: SpawnOptions): ClaudeSpawnPlan {
	const args = [
		"-p",
		buildPrompt(options.task),
		"--output-format",
		"stream-json",
		"--verbose",
		"--dangerously-skip-permissions",
		"--model",
		modelAlias(options.mode),
	];
	if (options.resumeSessionId) {
		args.push("--resume", options.resumeSessionId);
	} else if (options.newSessionId) {
		args.push("--session-id", options.newSessionId);
	}
	const workspace = options.cwd ?? join(homedir(), ".config", "browser-harness", "agent-workspace");
	const env: Record<string, string> = {
		...(options.extraEnv ?? {}),
		BH_DOMAIN_SKILLS: "1",
	};
	return { args, cwd: workspace, env };
}

export type StreamEvent =
	| { kind: "init"; claudeSessionId: string; model?: string }
	| { kind: "text"; text: string; model?: string }
	| {
			kind: "result";
			text?: string;
			isError: boolean;
			usage?: Record<string, unknown>;
			models?: string[];
	  };

interface RawStreamEvent {
	type?: string;
	subtype?: string;
	session_id?: unknown;
	model?: unknown;
	message?: { model?: unknown; content?: Array<{ type?: string; text?: unknown }> };
	result?: unknown;
	is_error?: unknown;
	usage?: unknown;
	modelUsage?: unknown;
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
			if (line) {
				const event = this.parseLine(line);
				if (event) events.push(event);
			}
			newline = this.buffer.indexOf("\n");
		}
		return events;
	}

	parseLine(line: string): StreamEvent | undefined {
		let raw: RawStreamEvent;
		try {
			raw = JSON.parse(line) as RawStreamEvent;
		} catch {
			return undefined; // Non-JSON noise (banners, warnings) is ignored.
		}
		if (raw.type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") {
			return {
				kind: "init",
				claudeSessionId: raw.session_id,
				model: typeof raw.model === "string" ? raw.model : undefined,
			};
		}
		if (raw.type === "assistant" && Array.isArray(raw.message?.content)) {
			const text = raw.message.content
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => String(block.text))
				.join("\n")
				.trim();
			const model = typeof raw.message?.model === "string" ? raw.message.model : undefined;
			if (text) return { kind: "text", text, model };
			if (model) return { kind: "text", text: "", model };
			return undefined;
		}
		if (raw.type === "result") {
			return {
				kind: "result",
				text: typeof raw.result === "string" ? raw.result : undefined,
				isError: raw.is_error === true,
				usage:
					raw.usage && typeof raw.usage === "object"
						? (raw.usage as Record<string, unknown>)
						: undefined,
				models: resultModels(raw.modelUsage),
			};
		}
		return undefined;
	}
}

/** Collect the model ids reported in a result event's `modelUsage` map. */
function resultModels(modelUsage: unknown): string[] | undefined {
	if (modelUsage === null || typeof modelUsage !== "object" || Array.isArray(modelUsage)) {
		return undefined;
	}
	const models = new Set<string>();
	for (const [key, value] of Object.entries(modelUsage as Record<string, unknown>)) {
		const canonical =
			value !== null && typeof value === "object"
				? (value as Record<string, unknown>).canonicalModel
				: undefined;
		models.add(typeof canonical === "string" && canonical.length > 0 ? canonical : key);
	}
	return models.size > 0 ? [...models] : undefined;
}

/** Cap streamed progress text so onUpdate payloads stay small. */
export function progressTail(text: string, limit = 1200): string {
	const clean = text.trim();
	if (clean.length <= limit) return clean;
	return `…${clean.slice(-limit)}`;
}
