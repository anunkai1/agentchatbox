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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitiseUsage, type UsageLike } from "./lib.js";

interface MaybeUsaged {
	role: string;
	usage?: UsageLike;
}

function withoutImpossibleUsage<M extends MaybeUsaged>(
	message: M,
	contextWindow: number | undefined,
): M | null {
	if (!message.usage) return null;
	const usage = sanitiseUsage(message.usage, contextWindow);
	return usage ? { ...message, usage } : null;
}

export default function registerUsageGuard(pi: ExtensionAPI): void {
	pi.on("message_end", (event, ctx) => {
		const original = event.message;
		if (original.role !== "assistant") return;
		const message = withoutImpossibleUsage(original, ctx.model?.contextWindow);
		if (!message) return;
		// Rare: only providers that mis-report usage reach this line.
		console.warn(
			`[usage-guard] cleared impossible usage from ${original.provider}/${original.model}: ` +
				`${original.usage.totalTokens} tokens reported for a ${ctx.model?.contextWindow}-token window`,
		);
		return { message };
	});

	pi.on("context", (event, ctx) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "assistant") return message;
			const sanitised = withoutImpossibleUsage(message, ctx.model?.contextWindow);
			if (!sanitised) return message;
			changed = true;
			return sanitised;
		});
		return changed ? { messages } : undefined;
	});
}
