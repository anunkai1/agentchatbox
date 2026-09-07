/**
 * Client preference persistence.
 *
 * Some UI settings are purely client-side — the server knows nothing
 * about them, so on a page refresh they would reset to their defaults.
 * TTS settings are keyed per pi session, while display settings are
 * device-local defaults. This means a new chat on this device keeps the
 * user's display choice, but another device starts with the defaults.
 *
 * What's persisted here (client-owned only):
 *   - ttsVoice   (selected Kokoro voice, per session)
 *   - ttsSpeed   (playback rate, per session)
 *   - showThinking / showToolCalls (device-local display defaults)
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
 * Keys: `acb:prefs:<sessionId>` for session settings and
 * `acb:prefs:display-defaults` for device-local display settings.
 * Failures (private mode, quota, corrupt JSON) are swallowed — prefs
 * are a nicety, never a correctness requirement.
 */

const PREFIX = "acb:prefs:";
const DISPLAY_DEFAULTS_KEY = "acb:prefs:display-defaults";

export interface SessionPrefs {
	ttsVoice?: string | null;
	ttsSpeed?: number;
	/** Legacy fields retained so old per-session prefs can be migrated. */
	showThinking?: boolean;
	showToolCalls?: boolean;
}

interface DisplayPrefs {
	showThinking?: boolean;
	showToolCalls?: boolean;
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

function loadDisplayDefaults(): DisplayPrefs {
	try {
		const raw = localStorage.getItem(DISPLAY_DEFAULTS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as DisplayPrefs;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function saveDisplayDefaults(prefs: DisplayPrefs): void {
	try {
		const merged = { ...loadDisplayDefaults(), ...prefs };
		localStorage.setItem(DISPLAY_DEFAULTS_KEY, JSON.stringify(merged));
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
 * state.sessionId changes (boot URL-read, ready, transcript). TTS prefs
 * are session-specific; display prefs come from this device's defaults.
 * A legacy per-session display preference is used once as a migration
 * fallback, preserving the user's existing choice on first load.
 */
export function applySessionPrefs(): void {
	const id = state.sessionId;
	if (!id) return;

	// Defaults are deliberately hidden. Reset before loading so switching to
	// a session cannot inherit transient choices from the previous session.
	state.showThinking = false;
	state.showToolCalls = false;
	const prefs = loadPrefs(id);
	if (typeof prefs.ttsVoice === "string") state.ttsVoice = prefs.ttsVoice;
	if (typeof prefs.ttsSpeed === "number" && Number.isFinite(prefs.ttsSpeed)) {
		state.ttsSpeed = prefs.ttsSpeed;
	}

	const display = loadDisplayDefaults();
	const hasLegacyDisplay =
		typeof prefs.showThinking === "boolean" || typeof prefs.showToolCalls === "boolean";
	if (typeof display.showThinking === "boolean") state.showThinking = display.showThinking;
	else if (typeof prefs.showThinking === "boolean") state.showThinking = prefs.showThinking;
	if (typeof display.showToolCalls === "boolean") state.showToolCalls = display.showToolCalls;
	else if (typeof prefs.showToolCalls === "boolean") state.showToolCalls = prefs.showToolCalls;

	// Migrate the first legacy session preference encountered to the device
	// defaults, so the setting is not lost when upgrading this client.
	if (!Object.keys(display).length && hasLegacyDisplay) {
		saveDisplayDefaults({
			showThinking: state.showThinking,
			showToolCalls: state.showToolCalls,
		});
	}
}

/** Persist the current client-owned prefs. Display settings are device-wide,
 * so this remains useful even before a new session has received its id. */
export function saveSessionPrefs(): void {
	saveDisplayDefaults({
		showThinking: state.showThinking,
		showToolCalls: state.showToolCalls,
	});

	const id = state.sessionId;
	if (!id) return;
	savePrefs(id, {
		ttsVoice: state.ttsVoice,
		ttsSpeed: state.ttsSpeed,
	});
}
