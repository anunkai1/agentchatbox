import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import {
	AcbSessions,
	buildBrief,
	chatLink,
	type Delegation,
	type DelegationStatus,
	delegatePrompt,
	formatReport,
	formatStatusList,
	lastAssistant,
	listDelegations,
	type ModelChoice,
	parseDelegateArgs,
	readDelegation,
	readDelivered,
	resolveModelToken,
	telegramText,
	writeDelegation,
	writeDelivered,
} from "./lib.js";

const PUBLIC_URL = process.env.ACB_PUBLIC_URL ?? "https://agent.mavali.top";
const REPORT_TOOL = "delegation_report";

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
			"Use only when the owner asks to delegate, hand off or run something in the background, or accepts your suggestion to.",
			"cwd is the folder of the repository the task belongs to: look it up in /home/lepton/infra/apps/REGISTRY.md (host/server config is /home/lepton/infra); for tasks that are not about code use this chat's folder. If it is unclear, ask the owner first.",
			"The worker cannot see this conversation, so the task must be a complete brief.",
			"Afterwards tell the owner in one line, with the link, and end your turn. The worker's report arrives here as a new message.",
		].join(" "),
		parameters: Type.Object({
			title: Type.String({ description: "Short chat title, e.g. 'Fix journal page'" }),
			task: Type.String({ description: "Complete, self-contained brief for the worker" }),
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
						text: `Worker started: ${chatLink(record.title, id)} in ${cwd} (${workerModel.provider}/${workerModel.modelId}). Tell the owner in one line with that link, then end your turn.`,
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "delegate_message",
		label: "Message worker",
		description:
			"Send a follow-up instruction to a worker started with delegate (its id is in the /s/<id> link). It continues in its own chat and reports again.",
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
		description:
			"Worker chats only: report to the chat that delegated this task, then end your turn. done = finished (what changed, checks passed, anything open); needs_input = you need the owner's decision (the question); failed = cannot finish (why).",
		parameters: Type.Object({
			status: Type.Union([
				Type.Literal("done"),
				Type.Literal("needs_input"),
				Type.Literal("failed"),
			]),
			summary: Type.String({ description: "Short report for the main chat" }),
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
			ctx.ui.notify(
				`Could not reach the main chat: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	pi.registerCommand("delegate", {
		description:
			"/delegate [model] <task> hands a task to a worker chat; /delegate status lists the last 10",
		handler: async (rawArgs, ctx) => {
			const args = parseDelegateArgs(rawArgs);
			switch (args.kind) {
				case "usage":
					ctx.ui.notify("Usage: /delegate [model] <task>, or /delegate status", "warning");
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
	});
}
