import { stripPiImageMeta } from "../shared/content.js";
import type { PersistedMessage } from "./state.js";

type User = Extract<PersistedMessage, { kind: "user" }>;
export interface DisplayChange {
	message: PersistedMessage;
	added: boolean;
}

/** Display metadata only: never submits, retries or authorises a request. */
export function relayVoiceDisplay(
	messages: PersistedMessage[],
	context: { id: string; user?: string; heard?: string },
	ts?: number,
): DisplayChange[] {
	const changes: DisplayChange[] = [];
	if (
		typeof context.user === "string" &&
		!messages.some((m) => m.kind === "user" && m.relayVoiceId === context.id)
	) {
		const message: User = {
			kind: "user",
			text: context.user,
			via: "Voice",
			relayVoiceId: context.id,
			ts,
		};
		messages.push(message);
		changes.push({ message, added: true });
	}
	if (typeof context.heard === "string" && context.heard.trim()) {
		const previous = messages.find((m) => m.kind === "note" && m.relayVoiceId === context.id);
		if (previous?.kind === "note") {
			if (previous.text !== context.heard) {
				previous.text = context.heard;
				changes.push({ message: previous, added: false });
			}
		} else {
			const message: PersistedMessage = {
				kind: "note",
				text: context.heard,
				ts,
				relayVoiceId: context.id,
				voicePlayback: true,
			};
			messages.push(message);
			changes.push({ message, added: true });
		}
	}
	return changes;
}

/**
 * Normalise server-rewritten attachment links (`/uploads/...`, `upload:...`,
 * or filesystem paths) and Pi's appended `[Image: ...]` coordinate notes so
 * an echoed user/steer message matches the browser's optimistic bubble.
 */
function normalizeUserMessageText(text: string): string {
	return stripPiImageMeta(text)
		.replace(
			/!?\[(image|file):\s*([^\]]*)\]\((?:upload:|[^()\s]*[\\/])([A-Za-z0-9._-]+)\)/g,
			(_full, kind: string, label: string, filename: string) =>
				`[${kind}: ${label.trim()}](upload:${filename})`,
		)
		.replace(/(?:\r?\n)+\[Image:[^\n]*\]/g, "")
		.trim();
}

/** Join an authoritative Pi echo to its optimistic/recognised input once. */
export function userMessageDisplay(
	messages: PersistedMessage[],
	text: string,
	seq: number,
	ts?: number,
): DisplayChange | null {
	const cleanText = stripPiImageMeta(text);
	const normalized = normalizeUserMessageText(cleanText);
	const pending = messages.find(
		(m): m is User =>
			m.kind === "user" && m.seq === undefined && normalizeUserMessageText(m.text) === normalized,
	);
	if (pending) {
		pending.seq = seq;
		pending.ts = ts;
		return { message: pending, added: false };
	}
	// Steering already has its own normal-chat bubble and delivery indicator.
	if (messages.some((m) => m.kind === "steer" && normalizeUserMessageText(m.text) === normalized))
		return null;
	const message: User = { kind: "user", text: cleanText, seq, ts };
	messages.push(message);
	return { message, added: true };
}
