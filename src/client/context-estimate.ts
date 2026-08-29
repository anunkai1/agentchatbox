/**
 * Local context-fill estimate for the status bar (display only).
 *
 * pi's ground truth (get_session_stats → contextUsage) only reaches the
 * browser at run boundaries (agent_end / ready / modelState /
 * compaction_end), so during a long run the meter sat stale until the run
 * ended. This module mirrors pi's own `estimateContextTokens()` from the
 * events pi is ALREADY streaming, so the meter ticks as the run progresses:
 *
 *   tokens = calculateContextTokens(last valid assistant usage)
 *          + Σ ceil(chars/4) of every context-visible message after it
 *
 * — the exact formula pi uses in AgentSession.getContextUsage() (base =
 * `usage.totalTokens || input + output + cacheRead + cacheWrite`, skipping
 * aborted/error messages; trailing estimated at chars/4, 4800 per image).
 * Because the formula is identical, the local value converges on pi's
 * ground truth as the run ends — and onSessionStats overwrites with pi's
 * value at every boundary anyway, so any drift self-corrects.
 *
 * Transport-layer rule: paint-only. The estimate never feeds back into the
 * agent and drives no behavior — pi remains the single source of truth.
 */

import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai";
import { state } from "./state.js";

/** pi's compaction.js `calculateContextTokens` — same fallback order. */
function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** pi's compaction.js `estimateTextAndImageContentChars`. */
function contentChars(content: string | (TextContent | ImageContent)[]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) chars += block.text.length;
		else if (block.type === "image") chars += 4800; // pi's ESTIMATED_IMAGE_CHARS
	}
	return chars;
}

/** pi's compaction.js `estimateTokens` for assistant messages. */
function assistantChars(m: AssistantMessage): number {
	let chars = 0;
	for (const block of m.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
		else if (block.type === "toolCall")
			chars += block.name.length + JSON.stringify(block.arguments).length;
	}
	return chars;
}

/**
 * calculateContextTokens of the last valid assistant usage seen since the
 * last reset. null = no valid usage yet (page opened mid-session, or right
 * after a reset) — the meter then holds whatever onSessionStats seeded.
 */
let baseTokens: number | null = null;
/** Σ ceil(chars/4) of every context-visible message appended after the base. */
let trailingTokens = 0;

/** Re-derive state.contextUsage from the local estimate (no repaint — the
 *  caller refreshes status, which happens unconditionally on the same event). */
function apply(): void {
	if (baseTokens == null) return;
	const cu = state.contextUsage;
	if (!cu || cu.contextWindow <= 0) return;
	const tokens = baseTokens + trailingTokens;
	if (tokens === cu.tokens) return; // unchanged — avoid a needless reflow
	state.contextUsage = { ...cu, tokens, percent: (tokens / cu.contextWindow) * 100 };
}

/** Call on every assistant `message_end` (main.ts event dispatch). */
export function noteAssistantMessageEnd(m: AssistantMessage): void {
	const base = m.usage ? calculateContextTokens(m.usage) : 0;
	if (m.stopReason !== "aborted" && m.stopReason !== "error" && base > 0) {
		// Mirrors pi: this usage sizes the whole context up to and
		// including this message, so it becomes the new base.
		baseTokens = base;
		trailingTokens = 0;
	} else {
		// No usable usage (error / aborted / retry attempt) — pi counts the
		// message's own text as trailing against the previous valid base.
		trailingTokens += Math.ceil(assistantChars(m) / 4);
	}
	apply();
}

/** Call on `message_start` for user / toolResult / custom messages — the
 *  content that grows the context between assistant turns. */
export function noteContextMessage(
	m: { content?: string | (TextContent | ImageContent)[] },
): void {
	const content = m.content;
	if (typeof content === "string" || Array.isArray(content)) {
		trailingTokens += Math.ceil(contentChars(content) / 4);
		apply();
	}
}

/**
 * The local estimate is invalid from here on: pi's ground truth (delivered
 * via onSessionStats) is the only trustworthy number until the next valid
 * assistant usage arrives. Called on compaction_end (the base is
 * pre-compaction) and on ready (new session / resume / fork / reconnect —
 * the ground-truth stats are requested in the same handler).
 */
export function resetContextEstimate(): void {
	baseTokens = null;
	trailingTokens = 0;
}
