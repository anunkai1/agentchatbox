/**
 * usage-guard decision logic — pure, unit-tested.
 *
 * Pi derives the current context size from the *last assistant message's*
 * usage: `totalTokens`, else `input + output + cacheRead + cacheWrite`
 * (pi-ai utils/estimate.ts, `calculateContextTokens`). Two consumers trust it:
 *
 *  - compaction (`shouldCompact`: context > window - reserveTokens), and
 *  - the per-request output budget (`clampMaxTokensToContext`:
 *    `min(maxTokens, max(1, contextWindow - estimate - 4096))`).
 *
 * A provider that reports *cumulative* cache reads for a whole agent loop
 * breaks both. The Antigravity ACP provider sums `cachedReadTokens` over every
 * internal step, so one real turn reports totalTokens ≈ 4.1M on a 1M-token
 * model although the true context was ≈ 180k. Pi then compacts on a healthy
 * turn and clamps the next request to a one-token output budget, so the model
 * stops with stopReason "length" after a token or two. Each truncated attempt
 * is discarded by pi's overflow recovery — which leaves the inflated message as
 * the newest usage again — so auto-continue retries into the same wall and the
 * session wedges until the user intervenes.
 *
 * A reported context larger than the model's own window cannot describe the
 * context, so it is not evidence of anything. Zeroing the token counts makes pi
 * skip that message and fall back to its character-based estimate, which is
 * accurate enough for both compaction and output budgeting. Provider-reported
 * cost is preserved: it is real even when the token split is not.
 */

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

/** Context size implied by a usage report — the same precedence pi uses. */
export function reportedContextTokens(usage: UsageLike): number {
	const total = usage.totalTokens;
	if (typeof total === "number" && total > 0) return total;
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Returns a usage with the token counts cleared when the report is impossible
 * for the model's context window, or `null` when it is plausible (leave it
 * alone). Anything unknown (no window, no usage) is left alone.
 */
export function sanitiseUsage<U extends UsageLike>(
	usage: U,
	contextWindow: number | undefined,
): U | null {
	if (!usage || typeof contextWindow !== "number") return null;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	if (reportedContextTokens(usage) <= contextWindow) return null;
	return { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}
