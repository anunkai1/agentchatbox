/**
 * Per-session client preference persistence.
 *
 * Some UI settings are purely client-side — the server knows nothing
 * about them, so on a page refresh they would reset to their defaults.
 * This module persists them to localStorage, keyed per pi session id,
 * so each chat remembers its own TTS voice / speed choice across
 * refreshes and reconnects.
 *
 * What's persisted here (client-owned only):
 *   - ttsVoice   (selected Kokoro/Piper voice)
 *   - ttsSpeed   (playback rate)
 *
 * What is NOT persisted here:
 *   - model + thinking level. Those are server-authoritative (the pi
 *     session owns them; setModel/setThinking change the running agent
 *     and the server reports them back on `ready`). They survive a
 *     refresh via the server as long as you reattach to the same
 *     session (/s/<id> in the URL). Persisting them client-side would
 *     risk fighting the server across devices (pick model A on phone,
 *     desktop's stale localStorage would override).
 *
 * Key shape: `acb:prefs:<sessionId>`. Stored as a small JSON blob.
 * Failures (private mode, quota, corrupt JSON) are swallowed — prefs
 * are a nicety, never a correctness requirement.
 */

const PREFIX = "acb:prefs:";

export interface SessionPrefs {
	ttsVoice?: string | null;
	ttsSpeed?: number;
}

function key(sessionId: string): string {
	return `${PREFIX}${sessionId}`;
}

/** Load the stored prefs for a session. Returns {} if none/corrupt. */
export function loadPrefs(sessionId: string): SessionPrefs {
	if (!sessionId) return {};
	try {
		const raw = localStorage.getItem(key(sessionId));
		if (!raw) return {};
		const parsed = JSON.parse(raw) as SessionPrefs;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Merge-update the stored prefs for a session (only non-null fields stick). */
export function savePrefs(sessionId: string, prefs: SessionPrefs): void {
	if (!sessionId) return;
	try {
		const merged = { ...loadPrefs(sessionId), ...prefs };
		localStorage.setItem(key(sessionId), JSON.stringify(merged));
	} catch {
		/* localStorage unavailable or full — ignore */
	}
}

// ── state glue ─────────────────────────────────────────────────────
// These two bridge the raw load/save above to the app's singleton state.
// Kept here so the persistence concern lives in one module; main.ts and
// the pickers just call applySessionPrefs() / saveCurrentPrefs().

import { state } from "./state.js";

/**
 * Load the current session's stored prefs into `state`. Call whenever
 * state.sessionId changes (boot URL-read, ready, transcript). Safe to
 * call repeatedly — only writes fields that have a stored value, so a
 * session with no saved prefs is left at the defaults.
 */
export function applySessionPrefs(): void {
	const id = state.sessionId;
	if (!id) return;
	const prefs = loadPrefs(id);
	if (typeof prefs.ttsVoice === "string") state.ttsVoice = prefs.ttsVoice;
	if (typeof prefs.ttsSpeed === "number" && Number.isFinite(prefs.ttsSpeed)) {
		state.ttsSpeed = prefs.ttsSpeed;
	}
}

/** Persist the current client-owned prefs for the current session. */
export function saveSessionPrefs(): void {
	const id = state.sessionId;
	if (!id) return;
	savePrefs(id, {
		ttsVoice: state.ttsVoice,
		ttsSpeed: state.ttsSpeed,
	});
}
