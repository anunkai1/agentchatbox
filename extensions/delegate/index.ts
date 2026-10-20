import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import {
	AcbSessions,
	BRIEF_GUIDANCE,
	buildBrief,
	chatLink,
	type Delegation,
	type DelegationStatus,
	DISPATCH_GUIDANCE,
	delegatePrompt,
	delegationsDir,
	formatReport,
	formatStatusList,
	lastAssistant,
	listDelegations,
	type ModelChoice,
	parseDelegateArgs,
	REPORT_GUIDANCE,
	readDelegation,
	readDelivered,
	resolveModelToken,
	STATUS_NOTE,
	STATUSES,
	telegramText,
	writeDelegation,
	writeDelivered,
} from "./lib.js";

const PUBLIC_URL = process.env.ACB_PUBLIC_URL ?? "https://agent.mavali.top";
const REPORT_TOOL = "delegation_report";

/** Keep status pages small; the saved record remains available for full context. */
function statusExcerpt(text: string): string {
	return text.length <= 1_000
		? text
		: `${text.slice(0, 1_000)}… [truncated; read recordPath for full text]`;
}

function sendTelegram(text: string): void {
	try {
		spawn("ai-telegram-send", [text], { stdio: "ignore", detached: true })
			.on("error", () => {})
			.unref();
	} catch {
		/* a missed Telegram must never break the worker */
	}
}

/**
 * Delegation: a main chat hands a task to a worker, which is an ordinary ACB
 * chat in the task's folder. The worker reports back by waking the main chat
 * with `/delegate report <id>` through ACB; the owner also gets a Telegram.
 * Records live in ~/.config/acb/delegations/<worker id>.json.
 */
export default function registerDelegate(
	pi: ExtensionAPI,
	acb = new AcbSessions(),
	notifyOwner: (text: string) => void = sendTelegram,
): void {
	let pendingReport: { status: DelegationStatus; summary: string } | null = null;
	let publishedThisRun = false;

	const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
	const self = (ctx: ExtensionContext) => readDelegation(sessionId(ctx));

	function currentModel(ctx: ExtensionContext): ModelChoice {
		if (!ctx.model) throw new Error("this chat has no model selected");
		return {
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinkingLevel: pi.getThinkingLevel(),
		};
	}

	function pickModel(ctx: ExtensionContext, name: string, thinkingLevel: string): ModelChoice {
		const slash = name.indexOf("/");
		const model =
			(slash > 0
				? ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1))
				: undefined) ?? resolveModelToken(name, ctx.modelRegistry.getAvailable());
		if (!model) throw new Error(`unknown model "${name}"`);
		return { provider: model.provider, modelId: model.id, thinkingLevel };
	}

	/** Save the worker's status in its JSONL (the sidebar reads it) and tell ACB. */
	function publish(ctx: ExtensionContext, record: Delegation): void {
		pi.appendEntry("delegation", {
			status: record.status,
			parentSessionId: record.parentSessionId,
		});
		ctx.ui.setStatus("delegation", record.status);
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Start a worker: a separate ACB chat that does a task in the background while this chat stays free.",
			...DISPATCH_GUIDANCE,
			"cwd is the folder of the repository the task belongs to: look it up in /home/lepton/infra/apps/REGISTRY.md (host/server config is /home/lepton/infra); for tasks that are not about code use this chat's folder. If it is unclear, ask the owner first.",
			BRIEF_GUIDANCE,
			"The worker's report arrives here as a new message. Omit model unless the owner specified one; workers inherit this chat's model and thinking level.",
		].join(" "),
		promptGuidelines: [...DISPATCH_GUIDANCE, BRIEF_GUIDANCE],
		parameters: Type.Object({
			title: Type.String({ description: "Short chat title, e.g. 'Fix journal page'" }),
			task: Type.String({ description: BRIEF_GUIDANCE }),
			cwd: Type.String({ description: "Absolute path of the folder the worker runs in" }),
			model: Type.Optional(
				Type.String({ description: "provider/model-id, only if the owner asked for a model" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = resolve(params.cwd);
			if (!isAbsolute(params.cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
				throw new Error(`${params.cwd} is not an existing folder`);
			}
			const parentModel = currentModel(ctx);
			const workerModel = params.model
				? pickModel(ctx, params.model, parentModel.thinkingLevel)
				: parentModel;
			const id = await acb.create(cwd, workerModel);
			const now = new Date().toISOString();
			const record: Delegation = {
				id,
				title: params.title.trim(),
				task: params.task,
				cwd,
				parentSessionId: sessionId(ctx),
				parentModel,
				workerModel,
				status: "working",
				createdAt: now,
				updatedAt: now,
				reportSeq: 0,
			};
			writeDelegation(record);
			await acb.prompt(id, buildBrief(record), workerModel);
			return {
				content: [
					{
						type: "text",
						text: `Worker started: ${chatLink(record.title, id)} in ${cwd} (${workerModel.provider}/${workerModel.modelId}). After all independent tasks in the approved request are dispatched, give the owner the links and end your turn.`,
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "delegate_status",
		label: "Worker status",
		description:
			"List or look up ACB delegation records to answer worker-status questions factually or find a same-topic worker before spawning. Defaults to the last 10 across chats; filters apply before paging. Includes original task, repo, parent and worker links, recorded status and timestamps. Long task/report text is excerpted; read recordPath for full context. This does not observe live activity or detailed progress.",
		promptGuidelines: [
			"Use delegate_status for worker-status questions and before spawning to find same-topic workers; never guess results or progress. A recorded working status is not proof that a process is still running.",
		],
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		parameters: Type.Object({
			worker: Type.Optional(Type.String({ description: "Exact worker session id" })),
			query: Type.Optional(
				Type.String({
					description: "Case-insensitive words to match in the title and original task",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Exact absolute repository/folder path" })),
			parentSessionId: Type.Optional(
				Type.String({ description: "Only workers delegated by this parent session id" }),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
			offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
		}),
		outputSchema: Type.Object({
			note: Type.String(),
			total: Type.Integer(),
			offset: Type.Integer(),
			nextOffset: Type.Union([Type.Integer(), Type.Null()]),
			workers: Type.Array(
				Type.Object({
					id: Type.String(),
					title: Type.String(),
					task: Type.String(),
					recordPath: Type.String(),
					cwd: Type.String(),
					parentSessionId: Type.String(),
					url: Type.String(),
					parentUrl: Type.String(),
					status: Type.Union(STATUSES.map((status) => Type.Literal(status))),
					createdAt: Type.String(),
					updatedAt: Type.String(),
					summary: Type.Union([Type.String(), Type.Null()]),
				}),
			),
		}),
		async execute(_id, params) {
			const records = listDelegations(Infinity, undefined, params);
			const offset = params.offset ?? 0;
			const end = offset + (params.limit ?? 10);
			const data = {
				note: STATUS_NOTE,
				total: records.length,
				offset,
				nextOffset: end < records.length ? end : null,
				workers: records.slice(offset, end).map((r) => ({
					id: r.id,
					title: r.title,
					task: statusExcerpt(r.task),
					recordPath: join(delegationsDir(), `${r.id}.json`),
					cwd: r.cwd,
					parentSessionId: r.parentSessionId,
					url: `/s/${r.id}`,
					parentUrl: `/s/${r.parentSessionId}`,
					status: r.status,
					createdAt: r.createdAt,
					updatedAt: r.updatedAt,
					summary: r.summary === undefined ? null : statusExcerpt(r.summary),
				})),
			};
			return {
				content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				structuredContent: data,
				details: data,
			};
		},
	});

	pi.registerTool({
		name: "delegate_message",
		label: "Message worker",
		description:
			"Send a follow-up instruction to an existing worker (find its id and original task with delegate_status). Prefer this for the same topic instead of spawning a new conversation: it retains context and reports again to its original parent. Do not pick an unrelated worker just because it shares a repo.",
		parameters: Type.Object({
			worker: Type.String({ description: "Worker chat id" }),
			message: Type.String({ description: "The instruction" }),
		}),
		async execute(_id, params) {
			const record = readDelegation(params.worker);
			if (!record) throw new Error(`no worker with id ${params.worker}`);
			await acb.prompt(record.id, params.message, record.workerModel);
			return {
				content: [{ type: "text", text: `Sent to ${chatLink(record.title, record.id)}.` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: REPORT_TOOL,
		label: "Report to main chat",
		description: `Worker chats only: report to the chat that delegated this task, then end your turn. done = finished; needs_input = you need the owner's decision; failed = cannot finish. ${REPORT_GUIDANCE}`,
		parameters: Type.Object({
			status: Type.Union([
				Type.Literal("done"),
				Type.Literal("needs_input"),
				Type.Literal("failed"),
			]),
			summary: Type.String({ description: REPORT_GUIDANCE }),
		}),
		defaultActive: false,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!self(ctx)) throw new Error("only worker chats can report");
			pendingReport = { status: params.status, summary: params.summary };
			return {
				content: [
					{ type: "text", text: "Report saved; it is sent when you stop. End your turn now." },
				],
				details: undefined,
				terminate: true,
			};
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (self(ctx) && !pi.getActiveTools().includes(REPORT_TOOL)) {
			pi.setActiveTools([...pi.getActiveTools(), REPORT_TOOL]);
		}
	});

	// Every worker run starts with a user message: the brief, the owner, or
	// a delegate_message. By then pi has written the chat to disk.
	pi.on("message_end", async (event, ctx) => {
		if (publishedThisRun || event.message.role !== "user") return;
		const record = self(ctx);
		if (!record) return;
		publishedThisRun = true;
		record.status = "working";
		record.updatedAt = new Date().toISOString();
		writeDelegation(record);
		if (!pi.getSessionName()) pi.setSessionName(record.title);
		publish(ctx, record);
	});

	pi.on("agent_settled", async (event, ctx) => {
		const record = self(ctx);
		const report = pendingReport;
		pendingReport = null;
		publishedThisRun = false;
		if (!record) return;
		const last = lastAssistant(ctx.sessionManager.getBranch());
		// `aborted` is on the event from pi 1.3; older pi only marks the message.
		const aborted = (event as { aborted?: boolean }).aborted === true || last.aborted === true;
		record.status = aborted
			? "stopped"
			: (report?.status ?? (last.error ? "failed" : "needs_input"));
		record.summary = report?.summary ?? last.error ?? last.text;
		record.updatedAt = new Date().toISOString();
		if (record.status !== "stopped") record.reportSeq++;
		writeDelegation(record);
		publish(ctx, record);
		if (record.status === "stopped") return;
		notifyOwner(telegramText(record, PUBLIC_URL));
		try {
			await acb.prompt(record.parentSessionId, `/delegate report ${record.id}`, record.parentModel);
		} catch (error) {
			// Usually the chat limit. Nobody may be watching this worker, so
			// tell the owner directly.
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not reach the main chat: ${reason}`, "warning");
			notifyOwner(
				`⚠️ Worker "${record.title}" could not report to the main chat: ${reason}\n\n${PUBLIC_URL}/s/${record.id}`,
			);
		}
	});

	const delegateCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description:
			"/delegate (or /d) [model] <task> hands a task to a worker chat; /delegate status lists the last 10",
		handler: async (rawArgs, ctx) => {
			const args = parseDelegateArgs(rawArgs);
			switch (args.kind) {
				case "usage":
					ctx.ui.notify("Usage: /d [model] <task>, or /d status", "warning");
					return;
				case "status":
					pi.sendMessage({
						customType: "note",
						content: formatStatusList(listDelegations(10)),
						display: true,
					});
					return;
				case "report": {
					// Sent by a worker through ACB. Deliver each report once, only
					// to the chat that delegated it.
					const record = readDelegation(args.id);
					if (!record || record.parentSessionId !== sessionId(ctx)) return;
					if (record.reportSeq <= readDelivered(record.id)) return;
					writeDelivered(record.id, record.reportSeq);
					pi.sendMessage(
						{
							customType: "note",
							content: formatReport(record),
							display: true,
							details: { source: "delegate", worker: record.id },
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					return;
				}
				case "task": {
					const model = args.rest
						? resolveModelToken(args.first, ctx.modelRegistry.getAvailable())
						: undefined;
					const prompt = delegatePrompt(model ? args.rest : args.task, model);
					if (ctx.isIdle()) pi.sendUserMessage(prompt);
					else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
			}
		},
	};
	pi.registerCommand("delegate", delegateCommand);
	pi.registerCommand("d", delegateCommand);
}
