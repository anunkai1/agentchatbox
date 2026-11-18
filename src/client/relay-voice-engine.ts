/** Browser/device preference, not a migration of saved chats. */
export const RELAY_VOICE_ENGINE_KEY = "acb-relay-voice-engine";
export const DEFAULT_RELAY_VOICE_ENGINE = "zonos3";
export const TRIAL_VOICE_ENGINE_KEY = "acb-relay-trial-engine";
export type RelayVoiceEngine = "kokoro" | "zonos3" | "legacy";
export type TrialVoiceEngine = Exclude<RelayVoiceEngine, "legacy">;
export function resolveRelayVoiceEngine(
	saved: unknown,
	explicit?: RelayVoiceEngine,
): RelayVoiceEngine {
	if (explicit) return explicit;
	return saved === "kokoro" || saved === "legacy" ? saved : DEFAULT_RELAY_VOICE_ENGINE;
}

/** Only rewrite a device's engine preference; never touch saved conversation IDs. */
export function readVoicePreference<E extends RelayVoiceEngine>(
	key: string,
	resolve: (saved: unknown) => E,
	explicit?: E,
	storage?: Pick<Storage, "getItem" | "setItem">,
): E {
	let engine = explicit ?? resolve(undefined);
	try {
		const prefs = storage ?? localStorage;
		const saved = prefs.getItem(key);
		engine = explicit ?? resolve(saved);
		if (explicit || saved === "lfm-tts" || saved === "server4") prefs.setItem(key, engine);
	} catch {
		/* Keep the resolved engine if storage is unavailable or read-only. */
	}
	return engine;
}

export function resolveTrialVoiceEngine(saved: unknown): TrialVoiceEngine {
	return saved === "kokoro" ? saved : DEFAULT_RELAY_VOICE_ENGINE;
}
