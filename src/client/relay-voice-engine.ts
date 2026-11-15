/** Browser/device preference, not a migration of saved chats. */
export const RELAY_VOICE_ENGINE_KEY = "acb-relay-voice-engine";
export const DEFAULT_RELAY_VOICE_ENGINE = "kokoro";
export type RelayVoiceEngine = "kokoro" | "zonos3" | "server4" | "lfm-tts" | "legacy";
export function resolveRelayVoiceEngine(
	saved: unknown,
	explicit?: RelayVoiceEngine,
): RelayVoiceEngine {
	if (explicit) return explicit;
	return saved === "kokoro" ||
		saved === "zonos3" ||
		saved === "server4" ||
		saved === "lfm-tts" ||
		saved === "legacy"
		? saved
		: DEFAULT_RELAY_VOICE_ENGINE;
}
