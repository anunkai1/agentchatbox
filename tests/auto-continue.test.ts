/**
 * auto-continue — the output-limit auto-resume extension.
 *
 * Two layers, matching the extension's own split:
 * - lib.ts: the pure decision state machine (stop-reason tracking, resume
 *   budget, cap). Tested directly.
 * - index.ts: the pi event adapter. Tested with a fake ExtensionAPI so the
 *   real entry point (event names, notify/send ordering) is covered too.
 */
import { describe, expect, it } from "vitest";
import registerAutoContinue from "../extensions/auto-continue/index.js";
import {
	applyDecision,
	CONTINUE_PROMPT,
	createAutoContinueState,
	decideOnSettle,
	MAX_CONSECUTIVE_RESUMES,
	recordAssistantStop,
} from "../extensions/auto-continue/lib.js";

// ---------------------------------------------------------------------------
// lib.ts — pure state machine
// ---------------------------------------------------------------------------

describe("auto-continue state machine", () => {
	it("does nothing before any assistant message has settled", () => {
		const state = createAutoContinueState();
		expect(decideOnSettle(state)).toEqual({ action: "none" });
	});

	it("does nothing on a clean stop and resets the budget", () => {
		const state = createAutoContinueState();
		recordAssistantStop(state, "stop");
		expect(decideOnSettle(state)).toEqual({ action: "none" });
		applyDecision(state, { action: "none" });
		expect(state.consecutiveResumes).toBe(0);
		expect(state.lastStopReason).toBeNull();
	});

	it("resumes an output-limit truncation with an incrementing count", () => {
		const state = createAutoContinueState();
		recordAssistantStop(state, "length");
		expect(decideOnSettle(state)).toEqual({ action: "resume", resumeCount: 1 });
		applyDecision(state, { action: "resume", resumeCount: 1 });
		recordAssistantStop(state, "length");
		expect(decideOnSettle(state)).toEqual({ action: "resume", resumeCount: 2 });
		applyDecision(state, { action: "resume", resumeCount: 2 });
	});

	it("hits the cap at the budget and stays paused until a clean stop", () => {
		const state = createAutoContinueState();
		for (let i = 1; i <= MAX_CONSECUTIVE_RESUMES; i++) {
			recordAssistantStop(state, "length");
			const decision = decideOnSettle(state);
			expect(decision).toEqual({ action: "resume", resumeCount: i });
			applyDecision(state, decision as { action: "resume"; resumeCount: number });
		}
		// Truncated again: cap-hit, budget stays at the cap.
		recordAssistantStop(state, "length");
		expect(decideOnSettle(state)).toEqual({ action: "cap-hit" });
		applyDecision(state, { action: "cap-hit" });
		expect(state.consecutiveResumes).toBe(MAX_CONSECUTIVE_RESUMES);
		// Still paused on the next truncation…
		recordAssistantStop(state, "length");
		expect(decideOnSettle(state)).toEqual({ action: "cap-hit" });
		// …until a clean stop resets the budget.
		recordAssistantStop(state, "stop");
		applyDecision(state, decideOnSettle(state));
		recordAssistantStop(state, "length");
		expect(decideOnSettle(state)).toEqual({ action: "resume", resumeCount: 1 });
	});

	it("any non-length stop reason resets a resume streak", () => {
		const state = createAutoContinueState();
		for (const reason of ["length", "length"]) {
			recordAssistantStop(state, reason);
			applyDecision(state, decideOnSettle(state));
		}
		expect(state.consecutiveResumes).toBe(2);
		for (const reason of ["aborted", "error", "toolUse"] as const) {
			recordAssistantStop(state, reason);
			applyDecision(state, decideOnSettle(state));
			expect(state.consecutiveResumes).toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------
// index.ts — pi event adapter (fake ExtensionAPI)
// ---------------------------------------------------------------------------

interface FakePi {
	on(name: string, handler: (event: unknown, ctx: FakeCtx) => void): void;
	sendUserMessage(content: string): void;
}
interface FakeCtx {
	ui: { notify(text: string, kind?: string): void };
}

function makeFake() {
	const handlers: Record<string, Array<(event: unknown, ctx: FakeCtx) => void>> = {};
	const sent: string[] = [];
	const notifications: Array<{ text: string; kind?: string }> = [];
	const pi: FakePi = {
		on(name, handler) {
			(handlers[name] ??= []).push(handler);
		},
		sendUserMessage(content) {
			sent.push(content);
		},
	};
	const ctx: FakeCtx = {
		ui: { notify: (text, kind) => notifications.push({ text, kind }) },
	};
	const emit = (name: string, event: unknown) => (handlers[name] ?? []).forEach((h) => h(event, ctx));
	return {
		pi,
		sent,
		notifications,
		assistantEnd: (stopReason: string) =>
			emit("message_end", {
				type: "message_end",
				message: { role: "assistant", stopReason, content: [] },
			}),
		toolEnd: () => emit("message_end", { type: "message_end", message: { role: "toolResult", content: "x" } }),
		settled: () => emit("agent_settled", { type: "agent_settled" }),
	};
}

function runScenario(steps: Array<["stop", string] | ["tool"] | ["settle"]>): {
	sent: string[];
	notifications: Array<{ text: string; kind?: string }>;
} {
	const fake = makeFake();
	registerAutoContinue(fake.pi as unknown as Parameters<typeof registerAutoContinue>[0]);
	for (const [kind, value] of steps) {
		if (kind === "stop") fake.assistantEnd(value);
		else if (kind === "tool") fake.toolEnd();
		else fake.settled();
	}
	return { sent: fake.sent, notifications: fake.notifications };
}

describe("auto-continue pi adapter", () => {
	it("sends the continue prompt once per truncated turn, with the resume count", () => {
		const { sent, notifications } = runScenario([
			["stop", "length"],
			["settle"],
			["stop", "length"],
			["settle"],
		]);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toBe(CONTINUE_PROMPT);
		expect(sent[1]).toBe(CONTINUE_PROMPT);
		expect(notifications[0]?.text).toContain("1/3");
		expect(notifications[1]?.text).toContain("2/3");
	});

	it("stays silent on clean stops", () => {
		const { sent, notifications } = runScenario([
			["stop", "stop"],
			["settle"],
			["stop", "length"],
			["settle"],
			["stop", "stop"],
			["settle"],
		]);
		expect(sent).toHaveLength(1);
		expect(notifications).toHaveLength(1); // only the single auto-continue info
	});

	it("pauses after the budget with a warning, and a clean stop re-arms it", () => {
		const { sent, notifications } = runScenario([
			["stop", "length"],
			["settle"],
			["stop", "length"],
			["settle"],
			["stop", "length"],
			["settle"],
			["stop", "length"], // over budget
			["settle"],
			["stop", "stop"], // user's manual 'continue' finished the job
			["settle"],
			["stop", "length"],
			["settle"], // budget re-armed → 1/3 again
		]);
		expect(sent).toHaveLength(4);
		const kinds = notifications.map((n) => n.kind);
		expect(kinds.filter((k) => k === "warning")).toHaveLength(1);
		expect(notifications.at(-1)?.text).toContain("1/3");
	});

	it("ignores non-assistant message_end events", () => {
		const { sent } = runScenario([
			["tool"],
			["stop", "length"],
			["tool"], // must not clobber the length stop reason
			["settle"],
		]);
		expect(sent).toHaveLength(1);
	});
});
