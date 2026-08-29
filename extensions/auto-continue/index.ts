/**
 * auto-continue — pi extension
 *
 * Resumes turns that were cut off by the model's output token limit.
 *
 * Background: when an assistant turn ends with stopReason "length" the work is
 * incomplete, but pi has no built-in auto-retry for that case (its overflow
 * retry only fires for hard context-overflow errors, i.e. "length" with zero
 * output). The agent simply goes idle and the user has to type "continue".
 *
 * This extension closes the gap at the lowest reliable point pi exposes: the
 * `agent_settled` event, which fires exactly once after a run has fully
 * settled — after any automatic retries and compaction, and only when no
 * queued continuation will run. At that moment `_isAgentRunActive` is already
 * false, so `pi.sendUserMessage(...)` (without `deliverAs`) starts a fresh
 * prompt run instead of queueing. The new run's preflight check compacts the
 * context first if it is still over the threshold, so resuming works in both
 * the over-threshold and under-threshold cases. No races: everything that
 * could continue the run has already run before settled fires.
 *
 * All policy (stop-reason tracking, resume budget, cap) lives in lib.ts as a
 * pure, unit-tested state machine; this file is only the event adapter.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyDecision,
	CONTINUE_PROMPT,
	createAutoContinueState,
	decideOnSettle,
	MAX_CONSECUTIVE_RESUMES,
	recordAssistantStop,
} from "./lib.js";

export default function registerAutoContinue(pi: ExtensionAPI): void {
	const state = createAutoContinueState();

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message && message.role === "assistant") {
			recordAssistantStop(state, message.stopReason ?? null);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		const decision = decideOnSettle(state);
		if (decision.action === "none") {
			applyDecision(state, decision);
			return;
		}

		if (decision.action === "cap-hit") {
			applyDecision(state, decision);
			ctx.ui.notify(
				"Output limit hit on consecutive turns — auto-continue paused. " +
					"Send 'continue' to resume manually, or run /compact to shrink the context.",
				"warning",
			);
			return;
		}

		ctx.ui.notify(
			`Response hit the output limit — auto-continuing ` +
				`(${decision.resumeCount}/${MAX_CONSECUTIVE_RESUMES})…`,
			"info",
		);
		// We are settled → idle, so this starts a fresh prompt run whose
		// preflight compacts the context first if it is still over threshold.
		// sendUserMessage is fire-and-forget at the extension surface; the
		// runtime wrapper emits an extension error event if it rejects.
		pi.sendUserMessage(CONTINUE_PROMPT);
		applyDecision(state, decision);
	});
}
