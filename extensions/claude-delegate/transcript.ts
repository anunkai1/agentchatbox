import { MIRROR_PROVIDER, NOTE_SOURCE, PROMPT_MESSAGE_TYPE } from "./lib.js";

/**
 * Moving a chat between pi and Claude Code. The two are separate
 * conversations, so each switch has to carry the other's side across:
 * buildCatchUp writes what Claude Code has not seen into its next prompt, and
 * foldClaudeSteps reshapes Claude Code's saved turns for pi's model.
 */

/** Longest catch-up transcript, in characters; older messages drop first. */
export const CATCH_UP_LIMIT = 60_000;
const RESULT_LIMIT = 400;
const SUMMARY_LIMIT = 4000;

interface Block {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

/** The parts of a pi session entry this module reads. */
export interface EntryLike {
	type?: string;
	message?: {
		role?: string;
		provider?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		command?: string;
		output?: string;
		excludeFromContext?: boolean;
	};
	customType?: string;
	content?: unknown;
	details?: unknown;
	summary?: string;
}

function blocksOf(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(content: unknown): string {
	return blocksOf(content)
		.map((block) =>
			block.type === "text" ? (block.text ?? "") : block.type === "image" ? "[image]" : "",
		)
		.filter(Boolean)
		.join("\n")
		.trim();
}

function clip(text: string, limit: number): string {
	const flat = text.trim();
	return flat.length > limit
		? `${flat.slice(0, limit)}… [${flat.length - limit} more characters]`
		: flat;
}

function briefArgs(args: unknown): string {
	try {
		return clip(JSON.stringify(args) ?? "", 200);
	} catch {
		return "";
	}
}

function isOurNote(details: unknown): boolean {
	return (details as { source?: unknown } | undefined)?.source === NOTE_SOURCE;
}

/** Ids of the tool calls Claude Code made, so their results can be told apart from pi's. */
function claudeToolIds(
	messages: Iterable<{ role?: string; provider?: string; content?: unknown }>,
) {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || message.provider !== MIRROR_PROVIDER) continue;
		for (const block of blocksOf(message.content)) {
			if (block.type === "toolCall" && typeof block.id === "string") ids.add(block.id);
		}
	}
	return ids;
}

/**
 * Every reply is saved twice, as a display note and as the assistant message
 * that persists the chat, so a reloaded chat holds both. A note is a duplicate
 * when the very next message repeats its text. A running chat holds only the
 * note (the assistant copy goes to pi's session file, not to the live
 * conversation), so a note with no twin is the reply itself.
 */
function isDuplicateNote(
	customType: string | undefined,
	content: unknown,
	next: { role?: string; provider?: string; content?: unknown } | undefined,
): boolean {
	return (
		customType === "note" &&
		next?.role === "assistant" &&
		next.provider === MIRROR_PROVIDER &&
		textOf(next.content) === textOf(content)
	);
}

/** `Claude Code:` lines for one assistant message: its text and one line per tool call. */
function assistantLines(label: string, content: unknown): string[] {
	const lines: string[] = [];
	const text = textOf(blocksOf(content).filter((block) => block.type === "text"));
	if (text) lines.push(`${label}: ${text}`);
	for (const block of blocksOf(content)) {
		if (block.type === "toolCall")
			lines.push(`[${label} tool call: ${block.name} ${briefArgs(block.arguments)}]`);
	}
	return lines;
}

/**
 * What Claude Code has not seen of this chat, as text for the front of its
 * next prompt. A resumed Claude conversation already holds everything up to
 * its last turn, so only pi's messages since then are sent; a fresh one gets
 * the whole chat, its own earlier turns included. Returns undefined when
 * there is nothing to add.
 */
export function buildCatchUp(
	entries: readonly EntryLike[],
	options: { fresh: boolean; sessionFile?: string; limit?: number },
): string | undefined {
	const all = entries.map((entry) => entry.message ?? {});
	const claudeIds = claudeToolIds(all);
	const isClaude = (entry: EntryLike, index: number): boolean => {
		if (entry.type === "custom_message") {
			return (
				entry.customType === PROMPT_MESSAGE_TYPE ||
				(entry.customType === "note" && isOurNote(entry.details)) ||
				isDuplicateNote(entry.customType, entry.content, entries[index + 1]?.message)
			);
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) return false;
		if (message.role === "assistant") return message.provider === MIRROR_PROVIDER;
		return message.role === "toolResult" && claudeIds.has(message.toolCallId ?? "");
	};

	let start = 0;
	if (!options.fresh) {
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			if (isClaude(entries[i], i)) {
				start = i + 1;
				break;
			}
		}
	}

	const chunks: string[] = [];
	for (let i = start; i < entries.length; i += 1) {
		const entry = entries[i];
		const message = entry.message;
		const claude = isClaude(entry, i);
		const lines: string[] = [];
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.summary)
				lines.push(`[Summary of earlier conversation: ${clip(entry.summary, SUMMARY_LIMIT)}]`);
		} else if (entry.type === "custom_message") {
			if (entry.customType === PROMPT_MESSAGE_TYPE) {
				lines.push(`User (to Claude Code): ${textOf(entry.content)}`);
			} else if (!claude) {
				const text = textOf(entry.content);
				if (text) lines.push(`[${entry.customType}] ${clip(text, RESULT_LIMIT)}`);
			}
		} else if (entry.type === "message" && message) {
			if (message.role === "user") {
				lines.push(`User: ${textOf(message.content)}`);
			} else if (message.role === "assistant") {
				lines.push(...assistantLines(claude ? "Claude Code" : "Assistant", message.content));
			} else if (message.role === "toolResult") {
				lines.push(
					`[${claude ? "Claude Code " : ""}tool result (${message.toolName ?? "tool"}): ${clip(textOf(message.content), RESULT_LIMIT)}]`,
				);
			} else if (message.role === "bashExecution" && !message.excludeFromContext) {
				lines.push(`[User ran: ${message.command}] ${clip(message.output ?? "", RESULT_LIMIT)}`);
			}
		}
		if (lines.length > 0) chunks.push(lines.join("\n"));
	}
	if (chunks.length === 0) return undefined;

	// Keep the newest messages when the transcript is too long.
	const limit = options.limit ?? CATCH_UP_LIMIT;
	let kept = chunks.length;
	let size = 0;
	while (kept > 0 && size + chunks[kept - 1].length + 2 <= limit) {
		size += chunks[kept - 1].length + 2;
		kept -= 1;
	}
	const shown = chunks.slice(kept);
	const omitted = kept;

	return [
		options.fresh
			? "Earlier in this same chat, the owner talked with the pi assistant (a different AI), and possibly with you in an earlier conversation you no longer have. This is that history."
			: "Since your last reply in this chat, the owner talked with the pi assistant (a different AI). This is that conversation, which you have not seen.",
		"It is background only: do not redo anything already done, and act on the Task at the end.",
		"--- chat history ---",
		...(omitted > 0 ? [`[${omitted} earlier messages omitted]`] : []),
		shown.join("\n\n"),
		"--- end of chat history ---",
		...(options.sessionFile
			? [`Full chat log (JSONL; Read it if you need more detail): ${options.sessionFile}`]
			: []),
	].join("\n");
}

interface ContextMessage {
	role?: string;
	provider?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	toolCallId?: string;
	stopReason?: string;
}

/**
 * The saved Claude Code turns as pi's model should read them. Each reply is
 * saved twice, so the duplicate display note goes; Claude Code's own tool
 * calls (names pi does not have) fold into plain text with their results;
 * its thinking is dropped; and the owner's `/cc` prompt is marked as sent to
 * Claude Code so pi can tell who answered.
 */
export function foldClaudeSteps<T extends ContextMessage>(messages: readonly T[]): T[] {
	if (
		!messages.some((m) => m.provider === MIRROR_PROVIDER || m.customType === PROMPT_MESSAGE_TYPE)
	) {
		return messages.slice();
	}
	const claudeIds = claudeToolIds(messages);
	const results = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "toolResult" && claudeIds.has(message.toolCallId ?? "")) {
			results.set(message.toolCallId as string, clip(textOf(message.content), RESULT_LIMIT));
		}
	}

	const out: T[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role === "toolResult" && claudeIds.has(message.toolCallId ?? "")) continue;
		if (
			message.role === "custom" &&
			isDuplicateNote(message.customType, message.content, messages[i + 1])
		) {
			continue;
		}
		if (message.role === "custom" && message.customType === "note" && isOurNote(message.details)) {
			// A live chat's only copy of Claude Code's reply: present it as the reply.
			out.push({
				role: "assistant",
				provider: MIRROR_PROVIDER,
				api: MIRROR_PROVIDER,
				model: MIRROR_PROVIDER,
				content: [{ type: "text", text: textOf(message.content) }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: (message as { timestamp?: number }).timestamp ?? Date.now(),
			} as unknown as T);
			continue;
		}
		if (message.role === "custom" && message.customType === PROMPT_MESSAGE_TYPE) {
			out.push({ ...message, content: `[Sent to Claude Code] ${textOf(message.content)}` });
			continue;
		}
		if (message.role === "assistant" && message.provider === MIRROR_PROVIDER) {
			const parts: string[] = [];
			for (const block of blocksOf(message.content)) {
				if (block.type === "text" && block.text) parts.push(block.text);
				if (block.type === "toolCall") {
					const result = results.get(block.id ?? "");
					parts.push(
						`[Claude Code ran ${block.name} ${briefArgs(block.arguments)}${result ? ` → ${result}` : ""}]`,
					);
				}
			}
			const text = parts.join("\n\n");
			if (!text) continue;
			const previous = out.at(-1);
			if (previous?.role === "assistant" && previous.provider === MIRROR_PROVIDER) {
				// A run's steps read as one turn, not a run of assistant messages.
				out[out.length - 1] = {
					...previous,
					content: [{ type: "text", text: `${textOf(previous.content)}\n\n${text}` }],
				};
			} else {
				out.push({ ...message, content: [{ type: "text", text }], stopReason: "stop" });
			}
			continue;
		}
		out.push(message);
	}
	return out;
}
