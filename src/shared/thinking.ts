/**
 * Thinking levels understood by the current pi RPC protocol, in increasing
 * effort order. Keep this list aligned with pi-agent-core.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Model-level mapping supplied by pi's get_available_models response. */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/**
 * Mirror pi-ai's getSupportedThinkingLevels semantics for model metadata
 * returned over RPC. Standard levels are supported unless explicitly null;
 * extended xhigh/max levels must be explicitly mapped.
 */
export function supportedThinkingLevels(
	reasoning: boolean,
	map?: ThinkingLevelMap,
): ThinkingLevel[] {
	if (!reasoning) return ["off"];

	return THINKING_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}
