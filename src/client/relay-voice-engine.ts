const RELAY_VOICE_ENGINE_KEY = "acb-relay-voice-engine";
const TRIAL_VOICE_ENGINE_KEY = "acb-relay-trial-engine";
type VoiceStorage = Pick<Storage, "getItem" | "setItem">;

/** Migrate only the browser's engine preference, not its saved conversation. */
export function migrateVoicePreference(mode: "relay" | "trial", storage?: VoiceStorage): void {
	const key = mode === "relay" ? RELAY_VOICE_ENGINE_KEY : TRIAL_VOICE_ENGINE_KEY;
	try {
		const prefs = storage ?? localStorage;
		const saved = prefs.getItem(key);
		if (saved !== null && saved !== "zonos3") prefs.setItem(key, "zonos3");
	} catch {
		/* Voice still uses ZONOS3-Mini if storage is unavailable or read-only. */
	}
}
