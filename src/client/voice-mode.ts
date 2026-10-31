/** Device-local recording behaviour; manual speak buttons work in every mode. */
export type VoiceMode = "off" | "send" | "reply";

export const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
	off: "Off",
	send: "V",
	reply: "V+",
};

export const VOICE_MODE_DESCRIPTIONS: Record<VoiceMode, string> = {
	off: "Voice mode off: transcribe recordings without sending",
	send: "V: auto-submit recordings without reading replies aloud",
	reply: "V+: auto-submit recordings and read replies aloud",
};

export function nextVoiceMode(mode: VoiceMode): VoiceMode {
	return mode === "off" ? "send" : mode === "send" ? "reply" : "off";
}

/** Preserve the old boolean setting's behaviour when upgrading. */
export function parseVoiceMode(value: unknown): VoiceMode {
	if (value === true || value === "reply") return "reply";
	return value === "send" ? "send" : "off";
}
