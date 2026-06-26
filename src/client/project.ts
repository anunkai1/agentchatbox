/**
 * Project the server's transcript replay (SDK `Message[]`) into the
 * renderer's flat `PersistedMessage[]` cache.
 *
 * Extracted from main.ts as a pure module so the projection logic —
 * especially the interrupted-session / dangling-tool-call handling —
 * is unit-testable without spinning up the client boot/DOM.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { PersistedMessage } from "./state.js";

/**
 * Tool calls and their results are correlated by `toolCallId`: each
 * inline `toolCall` block on an assistant message becomes a `tool`
 * row, joined to its matching `toolResult` (which pi writes as a
 * separate later message). This is what makes interrupted sessions
 * render correctly — when an assistant turn ends in `toolUse` but the
 * session died before any `toolResult` was persisted, those calls must
 * NOT show as "running…" (nothing is executing them). They're marked
 * `interrupted` and the renderer paints "⚠ interrupted" instead.
 *
 * Previously this was a 1:1 map that dropped the assistant's toolCall
 * blocks entirely and emitted a row per toolResult with stub
 * `args: "(replayed)"`. That both lost the real tool args and made
 * dangling calls silently vanish — or, if pi re-emitted them live on
 * resume (it re-runs pending tool calls), spin forever.
 */
export function projectTranscript(messages: Message[]): PersistedMessage[] {
	// Index toolResults by toolCallId so each toolCall block can look up
	// its own result regardless of message ordering.
	const resultsById = new Map<string, { text: string; isError: boolean }>();
	for (const m of messages) {
		if (m.role === "toolResult") {
			resultsById.set(m.toolCallId, {
				text: extractText(m.content),
				isError: Boolean(m.isError),
			});
		}
	}

	const out: PersistedMessage[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			out.push({ kind: "user", text: extractText(m.content) });
		} else if (m.role === "assistant") {
			const content = Array.isArray(m.content) ? m.content : [];
			out.push({
				kind: "assistant",
				text: extractText(content),
				thinking: extractThinking(content),
			});
			// Emit a tool row for each toolCall block on this assistant
			// message, correlated with its toolResult if one exists.
			for (const block of content) {
				if (
					!block ||
					typeof block !== "object" ||
					(block as { type?: string }).type !== "toolCall"
				) {
					continue;
				}
				const tc = block as { id: string; name: string; arguments: unknown };
				const r = resultsById.get(tc.id);
				if (r) {
					out.push({
						kind: "tool",
						name: tc.name,
						args: tc.arguments,
						result: r.text,
						isError: r.isError,
					});
				} else {
					// Dangling tool call — no result was ever written. The
					// session was interrupted mid-turn; mark it so the
					// renderer shows "interrupted" instead of spinning.
					out.push({
						kind: "tool",
						name: tc.name,
						args: tc.arguments,
						interrupted: true,
					});
				}
			}
		}
		// toolResult messages are consumed by the toolCall correlation
		// above; don't emit separate rows (avoids the old "(replayed)"
		// args duplication and keeps each tool to a single row).
	}
	return out;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: { type?: string }) => b && b.type === "text")
			.map((b: { text?: string }) => b.text ?? "")
			.join("");
	}
	return "";
}

function extractThinking(content: unknown): string {
	if (Array.isArray(content)) {
		return content
			.filter((b: { type?: string }) => b && b.type === "thinking")
			.map((b: { thinking?: string }) => b.thinking ?? "")
			.join("");
	}
	return "";
}
