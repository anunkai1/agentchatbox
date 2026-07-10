/**
 * Project the server's transcript replay (SDK `Message[]`) into the
 * renderer's flat `PersistedMessage[]` cache.
 *
 * Extracted from main.ts as a pure module so the projection logic —
 * especially the interrupted-session / dangling-tool-call handling —
 * is unit-testable without spinning up the client boot/DOM.
 */

import type { Message } from "@earendil-works/pi-ai";
import { extractText } from "../shared/content.js";
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
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "user") {
			out.push({ kind: "user", text: extractText(m.content), seq: i + 1 });
		} else if (m.role === "assistant") {
			const content = Array.isArray(m.content) ? m.content : [];
			out.push({
				kind: "assistant",
				text: extractText(content),
				thinking: extractThinking(content),
				seq: i + 1,
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
		// Custom messages (e.g. the pi-voice-reply extension's
		// customType:"voice-reply") carry role "custom", but the SDK's
		// `Message.role` union doesn't list it, so narrow via a cast rather
		// than comparing `m.role === "custom"` (which TS correctly flags as
		// unreachable and would silently drop voice replies on resume).
		const cm = m as { customType?: string };
		if (cm.customType === "voice-reply") {
			// Merge the variant(s) this custom message carries onto the most
			// recent assistant entry, without clearing previously-set ones.
			// A session can carry SEVERAL voice-reply custom messages (one
			// per /voice-last <variant> press), and each must accumulate onto
			// the same assistant row so its buttons + read-along box all work.
			const details = (m as { details?: { long?: string; medium?: string; short?: string } }).details ?? {};
			for (let j = out.length - 1; j >= 0; j--) {
				const prev = out[j];
				if (prev.kind === "assistant") {
					if (details.long !== undefined) prev.voiceLong = details.long;
					if (details.medium !== undefined) prev.voiceMedium = details.medium;
					if (details.short !== undefined) prev.voiceShort = details.short;
					break;
				}
			}
		}
	}
	return out;
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
