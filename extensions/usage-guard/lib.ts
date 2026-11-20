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

export interface SanitiseUsageOptions {
	provider?: string;
	estimatedContextTokens?: number;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateContentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const item = block as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") {
			chars += item.text.length;
		} else if (item.type === "thinking" && typeof item.thinking === "string") {
			chars += item.thinking.length;
		} else if (item.type === "toolCall") {
			if (typeof item.name === "string") chars += item.name.length;
			if (item.arguments !== undefined) {
				try {
					chars += JSON.stringify(item.arguments).length;
				} catch {
					/* ignore unserializable args */
				}
			}
		} else if (item.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a single message using Pi's chars/4 heuristic
 * (matching pi-coding-agent's `estimateTokens`, treating images as 1200 tokens
 * rather than counting base64 payload size).
 */
export function estimateMessageTokens(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const msg = message as Record<string, unknown>;
	let chars = 0;
	switch (msg.role) {
		case "system": {
			chars += estimateContentChars(msg.content);
			if (msg.sections && typeof msg.sections === "object") {
				for (const val of Object.values(msg.sections as Record<string, unknown>)) {
					if (typeof val === "string") chars += val.length;
				}
			}
			if (msg.toolsAdded !== undefined) {
				try {
					chars += JSON.stringify(msg.toolsAdded).length;
				} catch {
					/* ignore */
				}
			}
			return Math.ceil(chars / 4);
		}
		case "user":
		case "assistant":
		case "custom":
		case "toolResult":
			chars = estimateContentChars(msg.content);
			return Math.ceil(chars / 4);
		case "bashExecution":
			chars =
				(typeof msg.command === "string" ? msg.command.length : 0) +
				(typeof msg.output === "string" ? msg.output.length : 0);
			return Math.ceil(chars / 4);
		case "branchSummary":
		case "compactionSummary":
			chars = typeof msg.summary === "string" ? msg.summary.length : 0;
			return Math.ceil(chars / 4);
		default:
			return 0;
	}
}

export function estimateMessagesTokens(messages: readonly unknown[]): number {
	let total = 0;
	for (const message of messages) total += estimateMessageTokens(message);
	return total;
}

/** Context size implied by a usage report — the same precedence pi uses. */
export function reportedContextTokens(usage: UsageLike): number {
	const total = usage.totalTokens;
	if (typeof total === "number" && total > 0) return total;
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Returns a usage with the token counts cleared when the report is impossible
 * for the model's context window (or implausibly inflated by multi-step
 * cumulative accounting in `antigravity-acp`), or `null` when it is plausible.
 */
export function sanitiseUsage<U extends UsageLike>(
	usage: U,
	contextWindow: number | undefined,
	options?: SanitiseUsageOptions,
): U | null {
	if (!usage || typeof contextWindow !== "number") return null;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	const reported = reportedContextTokens(usage);
	if (reported <= 0) return null;
	if (reported > contextWindow) {
		return { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	}
	// Antigravity ACP sums input + cacheRead across every internal step of a
	// multi-step agent loop into one assistant message. That often lands at
	// 400k-990k on a 1M model when real context is <250k, tripping Pi's auto-
	// compaction and output clamping prematurely.
	if (
		options?.provider === "antigravity-acp" &&
		typeof options.estimatedContextTokens === "number" &&
		Number.isFinite(options.estimatedContextTokens) &&
		options.estimatedContextTokens >= 0
	) {
		const plausibleCeiling = Math.max(
			options.estimatedContextTokens * 1.8,
			options.estimatedContextTokens + 150_000,
		);
		if (reported > plausibleCeiling) {
			return { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		}
	}
	return null;
}
