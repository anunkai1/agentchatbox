/**
 * usage-guard — pi extension
 *
 * Drops impossible context-usage reports so pi never budgets output (or
 * compacts) from a provider that counts cache reads cumulatively. See lib.ts
 * for the failure this prevents; this file is only the event adapter.
 *
 * Two surfaces, both needed:
 *  - `message_end` keeps a newly finished assistant message honest, so the
 *    transcript itself never records an impossible context.
 *  - `context` is the request-time safety net for transcripts that already
 *    contain one (written before this extension existed, or by a provider
 *    version that reports cumulative counts). Without it such a session keeps
 *    clamping its own output budget to a single token.
 *
 * Plausible usage passes through untouched, so per-turn token and cost
 * accounting is unaffected.
 */
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";
import {
	reportedContextTokens,
	type SanitiseUsageOptions,
	sanitiseUsage,
	type UsageLike,
} from "./lib.js";

interface MaybeUsaged {
	role: string;
	provider?: string;
	usage?: UsageLike;
}

function withoutImpossibleUsage<M extends MaybeUsaged>(
	message: M,
	contextWindow: number | undefined,
	options?: SanitiseUsageOptions,
): M | null {
	if (!message.usage) return null;
	const usage = sanitiseUsage(message.usage, contextWindow, options);
	return usage ? { ...message, usage } : null;
}

export default function registerUsageGuard(pi: ExtensionAPI): void {
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const original = event.message as typeof event.message & MaybeUsaged & { model?: string };
		const projected =
			original.provider === "antigravity-acp"
				? ctx.sessionManager?.buildSessionProjection?.()?.messages
				: undefined;
		const estimatedContextTokens = projected?.reduce(
			(total, message) => total + estimateTokens(message),
			estimateTokens(original),
		);
		const message = withoutImpossibleUsage(original, ctx.model?.contextWindow, {
			provider: original.provider,
			estimatedContextTokens,
		});
		if (!message) return;
		const reported = original.usage ? reportedContextTokens(original.usage) : 0;
		// Rare: only providers that mis-report usage reach this line.
		console.warn(
			`[usage-guard] cleared inflated usage from ${original.provider}/${original.model}: ` +
				`${reported} tokens reported (window=${ctx.model?.contextWindow}, est=${estimatedContextTokens ?? "unknown"})`,
		);
		return { message };
	});

	pi.on("context", (event, ctx) => {
		let changed = false;
		const needsEstimate = event.messages.some(
			(message) =>
				message.role === "assistant" && (message as MaybeUsaged).provider === "antigravity-acp",
		);
		let runningEstimated = 0;
		const messages = event.messages.map((message) => {
			if (needsEstimate) runningEstimated += estimateTokens(message);
			if (message.role !== "assistant") return message;
			const typed = message as typeof message & MaybeUsaged;
			const sanitised = withoutImpossibleUsage(typed, ctx.model?.contextWindow, {
				provider: typed.provider,
				estimatedContextTokens: runningEstimated,
			});
			if (!sanitised) return message;
			changed = true;
			return sanitised;
		});
		return changed ? { messages } : undefined;
	});
}
