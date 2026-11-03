import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { transportStoppedSince } from "../../src/shared/transport-state.js";
import { PROMPT_MESSAGE_TYPE } from "../claude-delegate/lib.js";
import { sendTelegram } from "../delegate/index.js";
import {
	isDelegatedSession,
	RECOVERY_INSTRUCTION,
	readRecovery,
	type SessionRecovery,
	writeRecovery,
} from "./lib.js";

interface ClaudeActivity {
	ctx: ExtensionContext;
	mode?: string;
	task?: string;
	ownerRequest?: boolean;
	cancelled?: boolean;
}

/** All run/permission policy is Pi-owned. ACB only supplies durable transport receipts. */
export default function registerSessionRecovery(
	pi: ExtensionAPI,
	notify = (record: SessionRecovery) => {
		if (record.model)
			sendTelegram(
				`${record.notice}\n\n${process.env.ACB_PUBLIC_URL ?? record.origin}/s/${record.id}`,
				record.id,
				record.model,
			);
	},
): void {
	const origin = process.env.ACB_INTERNAL_URL;
	const bootId = process.env.ACB_BOOT_ID;
	const available = Boolean(origin && bootId && process.env.ACB_SESSION_RECOVERY !== "0");
	let shuttingDown = false;
	let autoContinuing = false;
	const inputs: { id: string; owner: boolean }[] = [];
	let ambiguousInput = false;
	let persistedOwner: { id: string; timestamp: number } | undefined;
	const id = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
	const eligible = (ctx: ExtensionContext) => available && !isDelegatedSession(id(ctx));
	const current = (ctx: ExtensionContext) => (eligible(ctx) ? readRecovery(id(ctx)) : null);
	const terminate = () => {
		shuttingDown = true;
	};

	pi.on("session_start", () => {
		shuttingDown = false;
		if (available) process.prependListener("SIGTERM", terminate);
	});
	pi.on("session_shutdown", (event, ctx) => {
		shuttingDown = true;
		process.off("SIGTERM", terminate);
		if (event.reason !== "quit" && event.reason !== "reload") {
			const record = current(ctx);
			if (record?.status === "running") {
				record.status = "stopped";
				writeRecovery(record);
			}
		}
	});

	function base(ctx: ExtensionContext): SessionRecovery {
		return {
			version: 1,
			id: id(ctx),
			origin: origin!,
			cwd: ctx.cwd,
			enabled: true,
			status: "idle",
			requestId: null,
			anchorId: null,
			bootId: bootId!,
			startedAt: 0,
			model: null,
			used: false,
		};
	}
	function activate(
		ctx: ExtensionContext,
		owner?: { requestId: string; anchorId: string },
		claude?: string,
	): void {
		if (!eligible(ctx) || shuttingDown || !ctx.model) return;
		const record = current(ctx) ?? base(ctx);
		if (!record.enabled) return;
		const before = JSON.stringify(record);
		if (owner) {
			record.origin = origin!;
			record.cwd = ctx.cwd;
			record.requestId = owner.requestId;
			record.anchorId = owner.anchorId;
			record.used = false;
			record.startedAt = Date.now();
			delete record.notice;
			delete record.waitingForInput;
		} else if (
			record.origin !== origin ||
			!record.requestId ||
			record.status === "needs_input" ||
			record.status === "stopped"
		)
			return;
		record.status = "running";
		record.bootId = bootId!;
		record.model = {
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinkingLevel: pi.getThinkingLevel(),
		};
		if (claude) record.claude = claude;
		else delete record.claude;
		if (JSON.stringify(record) !== before) writeRecovery(record);
	}

	pi.on("input", (event, ctx) => {
		if (!eligible(ctx)) return;
		if (event.source !== "extension" && ctx.isIdle() && !event.streamingBehavior) {
			inputs.length = 0;
			ambiguousInput = false;
		}
		inputs.push({ id: randomUUID(), owner: event.source !== "extension" });
	});
	pi.on("message_end", (event, ctx) => {
		if (!eligible(ctx) || event.message.role !== "user") return;
		// Pi does not persist input provenance; steering/follow-up queues can
		// reorder and expand text. Homogeneous input is unambiguous. Mixed
		// owner/synthetic queues must never accidentally rearm an allowance.
		if (inputs.some((input) => input.owner) && inputs.some((input) => !input.owner)) {
			ambiguousInput = true;
			inputs.length = 0;
			persistedOwner = undefined;
		}
		const input = inputs.shift();
		if (input?.owner && !ambiguousInput)
			persistedOwner = { id: input.id, timestamp: event.message.timestamp };
	});
	pi.on("context", (_event, ctx) => {
		if (!eligible(ctx) || shuttingDown) return;
		// message_end extension hooks precede persistence in Pi. Context is the
		// first universal pre-model boundary with the user entry actually saved.
		const entry = persistedOwner
			? [...ctx.sessionManager.getBranch()]
					.reverse()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.timestamp === persistedOwner!.timestamp,
					)
			: undefined;
		const owner =
			entry && persistedOwner ? { requestId: persistedOwner.id, anchorId: entry.id } : undefined;
		persistedOwner = undefined;
		activate(ctx, owner);
	});

	function claudeActivity(activity: ClaudeActivity): void {
		const { ctx } = activity;
		if (!eligible(ctx)) return;
		inputs.length = 0;
		ambiguousInput = false;
		persistedOwner = undefined;
		let owner: { requestId: string; anchorId: string } | undefined;
		if (activity.ownerRequest) {
			// Claude records its prompt before announcing execution. Do not enrol
			// an unpersisted prompt (e.g. overlapping native/Claude execution).
			const entry = [...ctx.sessionManager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === PROMPT_MESSAGE_TYPE &&
						entry.content === activity.task,
				);
			if (!entry) {
				const record = current(ctx);
				if (record?.enabled && record.status === "running") {
					record.status = "needs_input";
					record.notice =
						"Overlapping execution started before its prompt was saved. If interrupted, inspect this chat and continue manually.";
					writeRecovery(record);
				}
				return;
			}
			owner = { requestId: randomUUID(), anchorId: entry.id };
		}
		activate(ctx, owner, activity.mode);
	}
	pi.events.on("claude-delegate:run-start", (event) => claudeActivity(event as ClaudeActivity));
	pi.events.on("claude-delegate:follow-up", (event) => claudeActivity(event as ClaudeActivity));

	function settle(ctx: ExtensionContext, stopped: boolean, claude: boolean): void {
		if (shuttingDown) return;
		const record = current(ctx);
		if (record?.status !== "running" || Boolean(record.claude) !== claude) return;
		record.status =
			stopped || transportStoppedSince(record.origin, record.id, record.startedAt)
				? "stopped"
				: "idle";
		delete record.waitingForInput;
		writeRecovery(record);
	}
	pi.on("agent_settled", (event, ctx) => {
		const requestId = current(ctx)?.requestId;
		setImmediate(() => {
			const continuing = autoContinuing;
			autoContinuing = false;
			try {
				if (continuing || !ctx.isIdle() || current(ctx)?.requestId !== requestId) return;
				settle(ctx, (event as { aborted?: boolean }).aborted === true, false);
				if (!shuttingDown) {
					inputs.length = 0;
					ambiguousInput = false;
					persistedOwner = undefined;
				}
			} catch {
				ctx.ui.notify(
					"Could not save restart-recovery completion state. Inspect this chat manually if interrupted.",
					"warning",
				);
			}
		});
	});
	pi.events.on("auto-continue:resume", () => {
		autoContinuing = true;
	});
	pi.events.on("claude-delegate:run-end", (event) => {
		const activity = event as ClaudeActivity;
		settle(activity.ctx, activity.cancelled === true, true);
	});
	function waiting(ctx: ExtensionContext, value: boolean): void {
		const record = current(ctx);
		if (shuttingDown || record?.status !== "running") return;
		record.waitingForInput = value;
		writeRecovery(record);
	}
	pi.on("ui_prompt_start", (_event, ctx) => waiting(ctx, true));
	pi.on("ui_prompt_end", (_event, ctx) => waiting(ctx, false));

	function attention(record: SessionRecovery, notice: string): void {
		record.status = "needs_input";
		record.notice = notice;
		writeRecovery(record);
		pi.sendMessage(
			{
				customType: "session-recovery-notice",
				content: notice,
				display: true,
				details: { requestId: record.requestId },
			},
			{ triggerTurn: false },
		);
		notify(record);
	}
	pi.registerCommand("recovery", {
		description:
			"Restart recovery for this chat: /recovery status|off|on (on applies to subsequent owner requests)",
		handler: async (args, ctx) => {
			if (!eligible(ctx)) {
				ctx.ui.notify(
					"Normal-session recovery is unavailable here; delegated workers use their own policy.",
					"info",
				);
				return;
			}
			const [command = "status", requestId] = args.trim().split(/\s+/).filter(Boolean);
			const record = current(ctx) ?? base(ctx);
			if (command === "off" || command === "on") {
				record.enabled = command === "on";
				if (record.enabled) {
					record.status = "idle";
					record.requestId = null;
					record.anchorId = null;
					record.used = false;
				}
				inputs.length = 0;
				persistedOwner = undefined;
				writeRecovery(record);
				ctx.ui.notify(
					record.enabled
						? "Restart recovery on for subsequent owner requests."
						: "Restart recovery off for this chat.",
					"info",
				);
				return;
			}
			if (command === "status") {
				ctx.ui.notify(
					`Restart recovery ${record.enabled ? "on" : "off"}; ${record.status}; automatic attempt ${record.used ? "used" : "unused"}.${record.notice ? ` ${record.notice}` : ""}`,
					"info",
				);
				return;
			}
			if (requestId !== record.requestId) return;
			if (command === "notice" && record.status === "needs_input" && record.notice) {
				const duplicate = ctx.sessionManager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "session-recovery-notice" &&
							(entry.details as { requestId?: string } | undefined)?.requestId === requestId,
					);
				if (!duplicate)
					pi.sendMessage(
						{
							customType: "session-recovery-notice",
							content: record.notice,
							display: true,
							details: { requestId },
						},
						{ triggerTurn: false },
					);
				return;
			}
			if (
				command !== "resume" ||
				record.origin !== origin ||
				!ctx.isIdle() ||
				inputs.length > 0 ||
				!record.enabled ||
				record.status !== "running" ||
				record.used ||
				record.waitingForInput ||
				record.bootId === bootId ||
				transportStoppedSince(record.origin, record.id, record.startedAt)
			)
				return;
			if (
				!record.anchorId ||
				!ctx.sessionManager.getBranch().some((entry) => entry.id === record.anchorId)
			) {
				attention(
					record,
					"The interrupted request is not on this session's active branch. Inspect the chat and continue manually.",
				);
				return;
			}
			// Consume before triggering anything; a crash can never rearm this request.
			record.used = true;
			record.bootId = bootId!;
			writeRecovery(record);
			if (record.claude) {
				let accepted = false;
				pi.events.emit("claude-delegate:start", {
					ctx,
					mode: record.claude,
					task: RECOVERY_INSTRUCTION,
					accept: () => {
						accepted = true;
					},
				});
				if (accepted) return;
				attention(record, "Could not restore Claude Code. Continue this chat manually.");
				return;
			}
			pi.sendMessage(
				{
					customType: "session-recovery",
					content: RECOVERY_INSTRUCTION,
					display: true,
					details: { requestId },
				},
				{ triggerTurn: true },
			);
		},
	});
}
