/**
 * auto-continue decision logic — pure state machine, unit-tested.
 *
 * The extension (index.ts) is a thin event→state adapter; every decision
 * lives here so the resume policy is testable without a pi process.
 */

/** Max consecutive auto-resumes before pausing and asking the user. */
export const MAX_CONSECUTIVE_RESUMES = 3;

export const CONTINUE_PROMPT =
	"Your previous response was cut off at the output token limit, mid-task. " +
	"Continue from exactly where you left off. Do not repeat work already completed, " +
	"and do not re-read files or re-run commands whose results are already in context.";

export interface AutoContinueState {
	/** stopReason of the most recent assistant message_end (null before the first). */
	lastStopReason: string | null;
	/** Consecutive auto-resumes sent without a clean stop in between. */
	consecutiveResumes: number;
}

export function createAutoContinueState(): AutoContinueState {
	return { lastStopReason: null, consecutiveResumes: 0 };
}

/** Record an assistant message_end. Non-assistant messages are ignored by the caller. */
export function recordAssistantStop(state: AutoContinueState, stopReason: string | null): void {
	state.lastStopReason = stopReason;
}

export type SettledDecision =
	/** Run settled without an output-limit truncation (or no assistant message was seen) → nothing to do. */
	| { action: "none" }
	/** Send the continue prompt; resumeCount is the value to store. */
	| { action: "resume"; resumeCount: number }
	/** Truncated again at/over the budget → notify and pause until a clean stop. */
	| { action: "cap-hit" };

/**
 * Decide what to do at `agent_settled`. Pure: does not mutate state —
 * apply the decision with applyDecision after the send is initiated.
 */
export function decideOnSettle(state: AutoContinueState): SettledDecision {
	if (state.lastStopReason !== "length") return { action: "none" };
	if (state.consecutiveResumes >= MAX_CONSECUTIVE_RESUMES) return { action: "cap-hit" };
	return { action: "resume", resumeCount: state.consecutiveResumes + 1 };
}

/**
 * Store the outcome of a settled decision.
 * - "none" resets the resume budget (a clean stop ends any truncation streak).
 * - "resume" bumps the counter.
 * - "cap-hit" deliberately leaves the counter AT the cap, so the extension
 *   stays paused for the rest of the streak — each further truncated turn
 *   re-notifies until a clean stop resets the budget.
 */
export function applyDecision(state: AutoContinueState, decision: SettledDecision): void {
	state.lastStopReason = null;
	if (decision.action === "none") {
		state.consecutiveResumes = 0;
	} else if (decision.action === "resume") {
		state.consecutiveResumes = decision.resumeCount;
	}
}
