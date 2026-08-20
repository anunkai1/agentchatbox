export const LOCAL_AI_STATUS_KEY = "local-ai";
export const LOCAL_PROVIDER = "local";
export const LOCAL_MODEL_ID = "qwen3.8-27b-ud-q3";

export type LocalAiState = "qwen" | "image" | "video" | "stopped" | "offline";

/** Convert the server4 controller's human-readable status into a short UI label. */
export function parseLocalAiState(output: string, exitCode = 0): LocalAiState {
	if (exitCode !== 0) return "offline";
	if (/Qwen API\s*:\s*ready/i.test(output)) return "qwen";
	if (/FLUX API\s*:\s*ready/i.test(output)) return "image";
	if (/LTX-2\.5\s*:\s*(?:ready|active|busy)/i.test(output)) return "video";
	return "stopped";
}

export function localAiLabel(state: LocalAiState): string {
	switch (state) {
		case "qwen":
			return "Qwen active";
		case "image":
			return "Image active";
		case "video":
			return "Video active";
		case "offline":
			return "Server4 offline";
		case "stopped":
			return "Local AI stopped";
	}
}
