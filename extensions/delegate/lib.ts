import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATUSES = ["working", "needs_input", "done", "failed", "stopped"] as const;
export type DelegationStatus = (typeof STATUSES)[number];

export const STATUS_ICONS: Record<DelegationStatus, string> = {
	working: "🟢",
	needs_input: "❓",
	done: "✅",
	failed: "❌",
	stopped: "⏹",
};

export const STATUS_LABELS: Record<DelegationStatus, string> = {
	working: "working",
	needs_input: "needs you",
	done: "done",
	failed: "failed",
	stopped: "stopped",
};

export interface ModelChoice {
	provider: string;
	modelId: string;
	thinkingLevel: string;
}

/** One delegated task. Its id is the worker chat's session id. */
export interface Delegation {
	id: string;
	title: string;
	task: string;
	cwd: string;
	parentSessionId: string;
	/** Used to resume the parent if its chat has been closed. */
	parentModel: ModelChoice;
	workerModel: ModelChoice;
	status: DelegationStatus;
	summary?: string;
	createdAt: string;
	updatedAt: string;
	/** Bumped on every report; the parent delivers each number once. */
	reportSeq: number;
}

export function delegationsDir(): string {
	return process.env.ACB_DELEGATIONS_DIR ?? join(homedir(), ".config", "acb", "delegations");
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function readDelegation(id: string, dir = delegationsDir()): Delegation | null {
	if (!ID_RE.test(id)) return null;
	try {
		return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as Delegation;
	} catch {
		return null;
	}
}

/** One file per delegation: parent and worker are separate pi processes. */
export function writeDelegation(record: Delegation, dir = delegationsDir()): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `${record.id}.json`);
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, file);
}

export function listDelegations(limit: number, dir = delegationsDir()): Delegation[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return names
		.map((name) => readDelegation(name.slice(0, -5), dir))
		.filter((record): record is Delegation => record !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, limit);
}

export function chatLink(title: string, id: string): string {
	return `[${title.replace(/[[\]]/g, "")}](/s/${id})`;
}

export function ago(fromIso: string, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - Date.parse(fromIso)) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

function folderName(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

export function formatStatusList(records: Delegation[], now = Date.now()): string {
	if (records.length === 0) return "No delegations yet.";
	const lines = records.map(
		(r) =>
			`- ${STATUS_ICONS[r.status]} ${chatLink(r.title, r.id)} · ${folderName(r.cwd)} · ${ago(r.createdAt, now)}`,
	);
	return `**Last ${records.length} delegation${records.length === 1 ? "" : "s"}**\n\n${lines.join("\n")}`;
}

/** The first message of a worker chat. The worker cannot see the parent chat. */
export function buildBrief(
	record: Pick<Delegation, "title" | "task" | "cwd" | "parentSessionId">,
): string {
	return [
		`Delegated from ${chatLink("main chat", record.parentSessionId)}.`,
		"",
		`**Task: ${record.title}**`,
		"",
		record.task.trim(),
		"",
		"---",
		`You are a worker in ${record.cwd}. Do the task, then call delegation_report:`,
		"- `done` when finished: what changed, which checks passed, anything still open;",
		"- `needs_input` when you need the owner's decision, with the question;",
		"- `failed` when you cannot finish, with the reason.",
		"The owner may also message you here directly.",
	].join("\n");
}

export function formatReport(record: Delegation): string {
	return [
		`**Worker report** · ${STATUS_ICONS[record.status]} ${STATUS_LABELS[record.status]} · ${chatLink(record.title, record.id)}`,
		"",
		record.summary?.trim() || "(no summary)",
		"",
		"_This is a worker's report, not a message from the owner. Check it against what was asked, then tell the owner the outcome, send the worker more work with delegate_message, start the next step, or ask the owner._",
	].join("\n");
}

export function telegramText(record: Delegation, publicUrl: string): string {
	const summary = (record.summary ?? "").trim();
	return [
		`${STATUS_ICONS[record.status]} Worker ${STATUS_LABELS[record.status]}: ${record.title}`,
		summary.length > 600 ? `${summary.slice(0, 600)}…` : summary,
		`${publicUrl}/s/${record.id}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

export type DelegateArgs =
	| { kind: "status" }
	| { kind: "report"; id: string }
	/** `rest` is the task if `first` turns out to name a model. */
	| { kind: "task"; task: string; first: string; rest: string }
	| { kind: "usage" };

export function parseDelegateArgs(raw: string): DelegateArgs {
	const args = raw.trim();
	if (!args) return { kind: "usage" };
	if (args === "status") return { kind: "status" };
	const report = args.match(/^report\s+(\S+)$/);
	if (report) return { kind: "report", id: report[1] };
	const [first, ...rest] = args.split(/\s+/);
	return { kind: "task", task: args, first, rest: rest.join(" ") };
}

interface ModelLike {
	provider: string;
	id: string;
}

/**
 * Match `/delegate <model> <task>`'s first word to an available model: an
 * exact `provider/id` or id, else a unique id containing it. Anything else
 * is part of the task.
 */
export function resolveModelToken<T extends ModelLike>(
	token: string,
	models: readonly T[],
): T | undefined {
	const word = token.toLowerCase();
	const exact = models.find(
		(m) => `${m.provider}/${m.id}`.toLowerCase() === word || m.id.toLowerCase() === word,
	);
	if (exact) return exact;
	if (word.length < 3 || !/^[a-z0-9.-]+$/.test(word)) return undefined;
	const partial = models.filter((m) => m.id.toLowerCase().includes(word));
	const ids = new Set(partial.map((m) => `${m.provider}/${m.id}`));
	return ids.size === 1 ? partial[0] : undefined;
}

export function delegatePrompt(task: string, model?: ModelLike): string {
	const using = model ? ` Use model ${model.provider}/${model.id}.` : "";
	return `Delegate this to a worker with the delegate tool.${using} Pick the right folder first.\n\nTask: ${task}`;
}

/** The newest assistant message on the branch: its text and how it ended. */
export function lastAssistant(entries: readonly unknown[]): {
	text: string;
	error?: string;
	aborted?: boolean;
} {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type?: string;
			message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
		};
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const { content, stopReason, errorMessage } = entry.message;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((b: { type?: string }) => b?.type === "text")
							.map((b: { text?: string }) => b.text ?? "")
							.join("\n")
					: "";
		return {
			text: text.trim(),
			...(stopReason === "error" ? { error: errorMessage || "the model request failed" } : {}),
			...(stopReason === "aborted" ? { aborted: true } : {}),
		};
	}
	return { text: "" };
}

/** The parent records which report it has delivered apart from the worker's file. */
export function readDelivered(id: string, dir = delegationsDir()): number {
	try {
		return Number(readFileSync(join(dir, `${id}.delivered`), "utf8")) || 0;
	} catch {
		return 0;
	}
}

export function writeDelivered(id: string, seq: number, dir = delegationsDir()): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, `${id}.delivered`), String(seq), { mode: 0o600 });
}

/** Client for ACB's /api/internal session routes (src/server/internal-sessions.ts). */
export class AcbSessions {
	constructor(
		private readonly baseUrl = process.env.ACB_INTERNAL_URL,
		private readonly token = process.env.ACB_INTERNAL_TOKEN,
	) {}

	get available(): boolean {
		return Boolean(this.baseUrl && this.token);
	}

	async create(cwd: string, model: ModelChoice): Promise<string> {
		const data = (await this.post("/api/internal/sessions", { cwd, ...model })) as {
			sessionId?: string;
		};
		if (!data.sessionId) throw new Error("ACB did not return a session id");
		return data.sessionId;
	}

	async prompt(sessionId: string, message: string, model: ModelChoice): Promise<void> {
		await this.post(`/api/internal/sessions/${encodeURIComponent(sessionId)}/prompt`, {
			message,
			...model,
		});
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		if (!this.available) throw new Error("delegation only works in ACB chats");
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		if (!response.ok) throw new Error(`ACB: ${data.error ?? `HTTP ${response.status}`}`);
		return data;
	}
}
