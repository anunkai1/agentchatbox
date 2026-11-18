/** Voice request and playback journalling belong in Pi, not the browser/ACB server. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RelayEvent } from "../../src/shared/relay.js";

export const VOICE_CONTEXT = "acb-relay-voice-context";
export const VOICE_REQUEST = "acb-relay-voice-request";
export const VOICE_RESULT = "acb-relay-voice-result";
const ID = /^[a-zA-Z0-9-]{1,80}$/;
interface Context {
	id: string;
	user?: string;
	heard?: string;
}
interface Request {
	id: string;
	text: string;
}
interface Result {
	id: string;
	text: string;
	error?: boolean;
	report?: boolean;
}

function textOf(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((p) => p?.type === "text")
		.map((p) => p.text ?? "")
		.join("");
}
function boundedHistory(values: unknown[], limit: number): string {
	const recent = values.slice(-12);
	while (recent.length && Buffer.byteLength(JSON.stringify(recent), "utf8") > limit) recent.shift();
	return JSON.stringify(recent);
}

export class RelayVoiceJournal {
	private contexts = new Map<string, Context>();
	private requests = new Map<string, Result | undefined>();
	private queue: Request[] = [];
	private active?: Request;
	private reply = "";
	private replyFailed = false;
	private enabled = false;
	constructor(
		private pi: ExtensionAPI,
		private emit: (event: RelayEvent) => void,
		private flush: (ctx: ExtensionContext) => void,
	) {}

	restore(ctx: ExtensionContext): void {
		this.contexts.clear();
		this.requests.clear();
		this.queue = [];
		this.active = undefined;
		this.reply = "";
		this.replyFailed = false;
		this.enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			const data = entry.data as Context & Result;
			if (!data || !ID.test(data.id ?? "")) continue;
			if (entry.customType === VOICE_CONTEXT) this.remember(data);
			if (entry.customType === VOICE_REQUEST) this.requests.set(data.id, undefined);
			if (entry.customType === VOICE_RESULT) this.requests.set(data.id, data);
		}
		// Never replay a pending/uncertain owner request after restart or reattachment.
	}
	private remember(value: Context): void {
		this.contexts.set(value.id, { ...this.contexts.get(value.id), ...value });
		while (this.contexts.size > 20) this.contexts.delete(this.contexts.keys().next().value!);
	}
	history(): string {
		return boundedHistory([...this.contexts.values()], 3500);
	}
	runStarted(): void {
		this.reply = "";
		this.replyFailed = false;
	}
	observe(message: { role: string; content?: unknown; stopReason?: string }): void {
		if (message.role !== "assistant") return;
		if (message.stopReason === "toolUse") {
			this.reply = "";
			this.replyFailed = true;
			return;
		}
		this.replyFailed = message.stopReason === "error" || message.stopReason === "aborted";
		const text = textOf(message);
		this.reply =
			Buffer.byteLength(text, "utf8") > 7000
				? "Relay produced a long response. Read the full saved Relay chat before acting; it has not all been spoken."
				: text;
	}
	async handle(action: string, id: string, encoded: string, ctx: ExtensionContext): Promise<void> {
		this.enabled = true;
		if (!ID.test(id ?? "") || !/^[A-Za-z0-9_-]{1,24000}$/.test(encoded))
			throw new Error("Invalid voice bridge message");
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!payload || typeof payload !== "object" || Array.isArray(payload))
			throw new Error("Invalid voice bridge payload");
		if (action === "voice-context" || action === "voice-heard") {
			const max = action === "voice-context" ? 4000 : 16000;
			if (
				Object.keys(payload).join() !== "text" ||
				typeof payload.text !== "string" ||
				payload.text.length > max
			)
				throw new Error("Invalid voice transcript");
			if (action === "voice-context" && this.contexts.get(id)?.user === undefined) {
				const file = ctx.sessionManager.getSessionFile();
				if (!file) throw new Error("Voice history requires a saved Pi Relay session");
				if (!existsSync(file)) {
					// Same guarded SessionManager sink as /voicetest: materialise the
					// first real utterance without launching a tool/model run.
					const sink = ctx.sessionManager as unknown as {
						appendMessage?: (message: unknown) => unknown;
					};
					if (!sink.appendMessage)
						throw new Error("Voice transcripts cannot be saved: Pi's session API changed");
					sink.appendMessage({
						role: "user",
						content: [{ type: "text", text: payload.text }],
						timestamp: Date.now(),
					});
					if (!existsSync(file)) throw new Error("Voice transcript could not be saved");
				}
			}
			const value = { id, [action === "voice-context" ? "user" : "heard"]: payload.text };
			this.pi.appendEntry(VOICE_CONTEXT, value);
			this.remember(value);
			const saved = ctx.sessionManager.getSessionFile();
			if (saved && existsSync(saved))
				this.emit({ kind: "voice_context", ...this.contexts.get(id)! });
			return; // Context is historical evidence; never an owner run/approval.
		}
		if (action !== "voice-request" || Object.keys(payload).length)
			throw new Error("Invalid voice hand-off");
		if (this.requests.has(id)) {
			const previous = this.requests.get(id);
			if (previous) this.emit({ kind: "voice_result", ...previous });
			else if (this.active?.id === id || this.queue.some((r) => r.id === id))
				this.emit({ kind: "voice_pending", id });
			else
				this.emit({
					kind: "voice_result",
					id,
					error: true,
					text: "Previous voice submission is uncertain. Inspect the saved Relay chat and work before repeating it.",
				});
			return;
		}
		const text = this.contexts.get(id)?.user?.trim();
		if (!text) throw new Error("No owner utterance; nothing submitted to Relay");
		if (this.queue.length >= 8) throw new Error("Relay request queue is full; nothing submitted");
		const request = { id, text };
		this.pi.appendEntry(VOICE_REQUEST, request);
		this.flush(ctx);
		this.requests.set(id, undefined);
		this.queue.push(request);
		this.emit({ kind: "voice_pending", id });
		this.pump(ctx);
	}
	private pump(ctx: ExtensionContext): void {
		if (this.active || !ctx.isIdle()) return;
		const next = this.queue.shift();
		if (!next) return;
		this.active = next;
		this.runStarted();
		// Only the captured owner utterance becomes input, never playback evidence.
		this.pi.sendUserMessage(next.text);
	}
	settled(ctx: ExtensionContext): void {
		if (!this.enabled) return;
		const request = this.active;
		if (request || this.reply || this.replyFailed) {
			const error = this.replyFailed || !this.reply;
			const result: Result = {
				id: request?.id ?? `report-${randomUUID()}`,
				text: error
					? "Relay did not finish normally. Inspect the saved chat and work before retrying; completed effects may remain."
					: this.reply,
				...(error ? { error: true } : {}),
				...(!request ? { report: true } : {}),
			};
			this.pi.appendEntry(VOICE_RESULT, result);
			this.flush(ctx);
			if (request) this.requests.set(request.id, result);
			this.emit({ kind: "voice_result", ...result });
		}
		this.active = undefined;
		this.runStarted();
		this.pump(ctx);
	}
}
