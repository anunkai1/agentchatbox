/**
 * Pure decisions behind a pending spoken-variant request (a Long/Med/Short press
 * or voice mode's automatic Long): which arriving voice-reply answers it, what
 * counts as the extension reporting failure, and which finished reply voice mode
 * should speak. DOM-free so it can be unit-tested.
 */

export type VoiceVariant = "long" | "medium" | "short";

/** The `details` of a voice-reply custom message (one variant plus the echoed --match hint). */
export interface VoiceReplyDetails {
	long?: string;
	medium?: string;
	short?: string;
	match?: string;
}

/**
 * Text to speak when `details` answers the pending request, else null: nothing
 * pending (cancelled, or voice mode turned off), a different variant, or a reply
 * the extension tied to another row than the one pressed.
 */
export function pendingReplyText(
	pending: { variant: VoiceVariant | null; hint: string | null },
	details: VoiceReplyDetails,
): string | null {
	if (!pending.variant) return null;
	if (details.match !== undefined && details.match !== pending.hint) return null;
	return details[pending.variant]?.trim() || null;
}

/**
 * pi-voice-reply reports a failed /voice-last only through `notify` (the command
 * runs outside any agent run, so no agent_end follows). Its failure notices start
 * "Voice reply" or "No assistant message to voice"; the model-fallback warning
 * ("Voice model … failed; used …") comes BEFORE a successful reply and must not
 * match.
 */
export function isVoiceFailureNotice(message: string): boolean {
	return /^(Voice reply\b|No assistant message to voice)/.test(message);
}

/**
 * Timestamp of a finished run's last assistant reply, or null when there is
 * nothing to speak (aborted, errored, or no text). It identifies the reply so
 * voice mode voices each one only once.
 */
export function voiceableReplyStamp(messages: unknown): number | null {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as {
			role?: string;
			stopReason?: string;
			timestamp?: number;
			content?: unknown;
		};
		if (m?.role !== "assistant") continue;
		if (m.stopReason === "error" || m.stopReason === "aborted") return null;
		const hasText =
			Array.isArray(m.content) &&
			m.content.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
		return hasText && typeof m.timestamp === "number" ? m.timestamp : null;
	}
	return null;
}
