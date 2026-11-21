const RELAY_VOICE_ENGINE_KEY = "acb-relay-voice-engine";
const TRIAL_VOICE_ENGINE_KEY = "acb-relay-trial-engine";
export type TrialVoiceEngine = "kokoro" | "zonos3";
type VoiceStorage = Pick<Storage, "getItem" | "setItem">;

/** Migrate only the browser's engine preference, not its saved conversation. */
export function migrateRelayVoicePreference(storage?: VoiceStorage): void {
	try {
		const prefs = storage ?? localStorage;
		const saved = prefs.getItem(RELAY_VOICE_ENGINE_KEY);
		if (saved !== null && saved !== "zonos3") prefs.setItem(RELAY_VOICE_ENGINE_KEY, "zonos3");
	} catch {
		/* Relay still uses ZONOS3-Mini if storage is unavailable or read-only. */
	}
}

export function readTrialVoicePreference(
	explicit?: TrialVoiceEngine,
	storage?: VoiceStorage,
): TrialVoiceEngine {
	let engine = explicit ?? "zonos3";
	try {
		const prefs = storage ?? localStorage;
		const saved = prefs.getItem(TRIAL_VOICE_ENGINE_KEY);
		engine = explicit ?? (saved === "kokoro" ? "kokoro" : "zonos3");
		if (explicit || saved === "lfm-tts" || saved === "server4")
			prefs.setItem(TRIAL_VOICE_ENGINE_KEY, engine);
	} catch {
		/* Keep the resolved trial engine if storage is unavailable or read-only. */
	}
	return engine;
}
