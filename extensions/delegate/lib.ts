import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
	/** Claude Code model (opus/sonnet/haiku) when the worker runs in Claude Code mode. */
	claude?: string;
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

export interface DelegationFilter {
	worker?: string;
	query?: string;
	cwd?: string;
	parentSessionId?: string;
}

/** Filter before taking the last N, so older workers can be found by topic. */
export function listDelegations(
	limit: number,
	dir = delegationsDir(),
	filter: DelegationFilter = {},
): Delegation[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const words = filter.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
	return names
		.map((name) => readDelegation(name.slice(0, -5), dir))
		.filter((record): record is Delegation => record !== null)
		.filter(
			(r) =>
				(!filter.worker || r.id === filter.worker) &&
				(!filter.cwd || r.cwd === filter.cwd) &&
				(!filter.parentSessionId || r.parentSessionId === filter.parentSessionId) &&
				words.every((word) => `${r.title}\n${r.task}`.toLowerCase().includes(word)),
		)
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

export const STATUS_NOTE =
	"Recorded status only, not live progress: working is saved at worker creation or turn start, not proof that it is still running. Records can be stale after interruptions; summaries are the last recorded reports and may predate the current turn. Do not infer results or detailed progress.";

export const BRIEF_GUIDANCE =
	"The worker cannot see this conversation. Write a self-contained brief with sections: Goal and why; Known facts (relevant paths, errors and the owner's words); Done when (required checks and the evidence to return). Include only supplied or verified facts, not invented details. Investigate gaps where possible; ask the owner only if genuinely blocked, not when the task is already clear.";

export const DISPATCH_GUIDANCE = [
	"Delegate only when the owner explicitly asks to delegate, hand off or run work in the background, or accepts your suggestion; ordinary requests are not approval.",
	"Before spawning, use delegate_status to find relevant existing workers by topic. Prefer delegate_message for the same topic to retain context; compare the title, task and parent chat, not just the repository. Do not reuse an unrelated worker merely because it shares a repo.",
	"For an explicitly delegated request with independent tasks, split and dispatch them independently/concurrently where appropriate. Do not split tightly dependent work unnecessarily. After all dispatches, briefly give the owner the session links and end your turn; do not wait or poll for completion.",
];

export const REPORT_GUIDANCE =
	"Report result first, then evidence (changes and checks actually run), then open questions; be concise, normally under 300 words. For needs_input, state the exact decision/question, relevant findings and options or a recommendation. For failed, state the blocker, partial work/checks and the next useful step. Never claim unperformed checks or guess results.";

export function formatStatusList(records: Delegation[], now = Date.now()): string {
	if (records.length === 0) return "No delegations yet.";
	const lines = records.map(
		(r) =>
			`- ${STATUS_ICONS[r.status]} ${chatLink(r.title, r.id)} · ${r.status} (recorded) · ${r.cwd} · updated ${ago(r.updatedAt, now)} · ${chatLink("parent", r.parentSessionId)}`,
	);
	return `**Last ${records.length} delegation${records.length === 1 ? "" : "s"}**\n\n${lines.join("\n")}\n\n_${STATUS_NOTE}_`;
}

/** The first message of a worker chat. The worker cannot see the parent chat. */
export function buildBrief(
	record: Pick<Delegation, "title" | "task" | "cwd" | "parentSessionId" | "claude">,
): string {
	// Claude Code cannot call pi tools, so it reports with a closing status line.
	const report = record.claude
		? [
				`Claude Code starts in its own workspace: work in ${record.cwd}, and first read the AGENTS.md there (if any) and follow it.`,
				"Do the task. When you stop, end your final reply with exactly one of these lines:",
				"- `Status: done` when finished: what changed, which checks passed, anything still open;",
				"- `Status: needs_input` when you need the owner's decision, with the question;",
				"- `Status: failed` when you cannot finish, with the reason.",
			]
		: [
				"Do the task, then call delegation_report:",
				"- `done` when finished: what changed, which checks passed, anything still open;",
				"- `needs_input` when you need the owner's decision, with the question;",
				"- `failed` when you cannot finish, with the reason.",
			];
	return [
		`Delegated from ${chatLink("main chat", record.parentSessionId)}.`,
		"",
		`**Task: ${record.title}**`,
		"",
		record.task.trim(),
		"",
		"---",
		`You are a worker in ${record.cwd}. Work from the goal and reason, known facts, and definition of done above. Investigate missing details rather than inventing facts or asking the owner unnecessarily when the task is clear.`,
		"You are not alone. Other workers may be editing this repository; preserve their changes and do not undo them.",
		...report,
		"Your report also reaches the owner on Telegram, so do not message them yourself.",
		REPORT_GUIDANCE,
		"The owner may also message you here directly.",
	].join("\n");
}

/** How the reviewing chat sends a worker more work: a pi tool, or cli.ts for Claude Code. */
const NEXT_STEP = {
	pi: "continue the same topic with delegate_message",
	cli: "continue the same topic with `node /home/lepton/agentchatbox/extensions/delegate/cli.ts message <worker id>` (message on stdin)",
};

export function formatReport(record: Delegation, via: keyof typeof NEXT_STEP = "pi"): string {
	return [
		`**Worker report** · ${STATUS_ICONS[record.status]} ${STATUS_LABELS[record.status]} · ${chatLink(record.title, record.id)}`,
		"",
		record.summary?.trim() || "(no summary)",
		"",
		`_This is a worker's report, not a message from the owner. Check its result and evidence against the brief; do not invent missing evidence. Then tell the owner the outcome, ${NEXT_STEP[via]}, take an already approved next step, or ask the owner a necessary question. Worker id: ${record.id}_`,
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
	| { kind: "start"; id: string }
	/** `rest` is the task if `first` turns out to name a model. */
	| { kind: "task"; task: string; first: string; rest: string }
	| { kind: "usage" };

export function parseDelegateArgs(raw: string): DelegateArgs {
	const args = raw.trim();
	if (!args) return { kind: "usage" };
	if (args === "status") return { kind: "status" };
	const report = args.match(/^report\s+(\S+)$/);
	if (report) return { kind: "report", id: report[1] };
	const start = args.match(/^start\s+(\S+)$/);
	if (start) return { kind: "start", id: start[1] };
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
	return [
		`Delegate this request with the delegate tool or delegate_message for an existing worker.${using} Pick the right folder first.`,
		...DISPATCH_GUIDANCE,
		BRIEF_GUIDANCE,
		"",
		`Task: ${task}`,
	].join("\n");
}

/** The newest assistant message on the branch: its text and how it ended. */
export function lastAssistant(entries: readonly unknown[]): {
	text: string;
	error?: string;
	aborted?: boolean;
	/** Cut off at the output limit, which auto-continue may resume. */
	cutOff?: boolean;
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
			...(stopReason === "length" ? { cutOff: true } : {}),
		};
	}
	return { text: "" };
}

const STATUS_LINE = /^\W*status\W*[:-][\s*_`]*(done|needs[_ ]input|failed)\b.*$/gim;

/** A Claude Code worker's closing `Status: …` line, and its reply without it. */
export function parseStatusLine(text: string): {
	status?: Exclude<DelegationStatus, "working" | "stopped">;
	summary: string;
} {
	const matches = [...text.matchAll(STATUS_LINE)];
	const last = matches.at(-1);
	if (!last || last.index === undefined) return { summary: text.trim() };
	const word = last[1].toLowerCase().replace(" ", "_") as "done" | "needs_input" | "failed";
	const summary = `${text.slice(0, last.index)}${text.slice(last.index + last[0].length)}`.trim();
	return { status: word, summary };
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
// No constructor parameter properties: cli.ts runs this file with Node's
// built-in TypeScript stripping, which only removes erasable syntax.
export class AcbSessions {
	private readonly baseUrl = process.env.ACB_INTERNAL_URL;
	private readonly token = process.env.ACB_INTERNAL_TOKEN;

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

export interface WorkerClient {
	create(cwd: string, model: ModelChoice): Promise<string>;
	prompt(sessionId: string, message: string, model: ModelChoice): Promise<void>;
}

/**
 * Start a worker chat. Used by the delegate tool and by cli.ts (Claude Code).
 * The worker's own copy of the extension sends the brief on `/delegate start`.
 */
export async function startWorker(
	acb: WorkerClient,
	request: Pick<
		Delegation,
		"title" | "task" | "cwd" | "parentSessionId" | "parentModel" | "workerModel" | "claude"
	>,
): Promise<Delegation> {
	const cwd = resolve(request.cwd);
	if (!isAbsolute(request.cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`${request.cwd} is not an existing folder`);
	}
	const id = await acb.create(cwd, request.workerModel);
	const now = new Date().toISOString();
	const record: Delegation = {
		...request,
		id,
		title: request.title.trim(),
		cwd,
		status: "working",
		createdAt: now,
		updatedAt: now,
		reportSeq: 0,
	};
	if (!record.claude) delete record.claude;
	writeDelegation(record);
	await acb.prompt(id, `/delegate start ${id}`, request.workerModel);
	return record;
}

/** Send an existing worker a follow-up; it continues in its own chat and reports again. */
export async function messageWorker(
	acb: WorkerClient,
	id: string,
	message: string,
): Promise<Delegation> {
	const record = readDelegation(id);
	if (!record) throw new Error(`no worker with id ${id}`);
	await acb.prompt(record.id, message, record.workerModel);
	return record;
}

export function workerLabel(record: Pick<Delegation, "claude" | "workerModel">): string {
	return record.claude
		? `Claude Code ${record.claude}`
		: `${record.workerModel.provider}/${record.workerModel.modelId}`;
}
