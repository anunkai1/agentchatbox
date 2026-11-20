/**
 * usage-guard — discard impossible context-usage reports.
 *
 * Two layers, matching the extension's own split:
 * - lib.ts: the pure decision (reported size vs the model's window).
 * - index.ts: the pi event adapter, driven with a fake ExtensionAPI.
 *
 * Regression context: an Antigravity ACP turn reported totalTokens 4,087,626
 * on a 1M-token model. Pi budgets output as
 * `min(maxTokens, max(1, window - estimate - 4096))`, so that message clamped
 * the next request to one token; the model stopped with stopReason "length"
 * after "The", auto-continue retried into the same wall, and the chat wedged.
 */
import { describe, expect, it, vi } from "vitest";
import registerUsageGuard from "../extensions/usage-guard/index.js";
import {
	estimateMessageTokens,
	reportedContextTokens,
	sanitiseUsage,
} from "../extensions/usage-guard/lib.js";

const plausible = {
	input: 170_746,
	output: 5_368,
	cacheRead: 3_911_512,
	cacheWrite: 0,
	totalTokens: 4_087_626,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 },
};

describe("reportedContextTokens", () => {
	it("prefers totalTokens, like pi", () => {
		expect(reportedContextTokens(plausible)).toBe(4_087_626);
	});

	it("falls back to the sum when totalTokens is absent or zero", () => {
		expect(reportedContextTokens({ ...plausible, totalTokens: 0 })).toBe(4_087_626);
	});
});

describe("estimateMessageTokens", () => {
	it("counts images as 1200 tokens instead of raw base64 bytes", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "text", text: "abcd" },
				{ type: "image", data: "x".repeat(4_000_000), mimeType: "image/png" },
			],
		};
		expect(estimateMessageTokens(msg)).toBe(1201);
	});
});

describe("sanitiseUsage", () => {
	it("clears a context larger than the model's window", () => {
		const result = sanitiseUsage(plausible, 1_000_000);
		expect(result).toMatchObject({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		});
	});

	it("keeps provider-reported cost when clearing the split", () => {
		expect(sanitiseUsage(plausible, 1_000_000)?.cost).toEqual(plausible.cost);
	});

	it("leaves a plausible report untouched", () => {
		const healthy = { ...plausible, cacheRead: 9_512, totalTokens: 185_626 };
		expect(sanitiseUsage(healthy, 1_000_000)).toBeNull();
	});

	it("leaves a report that exactly fills the window untouched", () => {
		const full = { ...plausible, cacheRead: 0, totalTokens: 1_000_000 };
		expect(sanitiseUsage(full, 1_000_000)).toBeNull();
	});

	it("clears below-window cumulative multi-step inflation from antigravity-acp", () => {
		const earlyCompactionTrigger = {
			...plausible,
			input: 250_832,
			output: 1_030,
			cacheRead: 731_447,
			totalTokens: 983_309,
		};
		expect(
			sanitiseUsage(earlyCompactionTrigger, 1_000_000, {
				provider: "antigravity-acp",
				estimatedContextTokens: 218_912,
			}),
		).toMatchObject({ totalTokens: 0, cacheRead: 0, cost: plausible.cost });

		// Genuine full context stays untouched so real compaction still runs.
		expect(
			sanitiseUsage(earlyCompactionTrigger, 1_000_000, {
				provider: "antigravity-acp",
				estimatedContextTokens: 850_000,
			}),
		).toBeNull();

		// Other providers below window are untouched.
		expect(
			sanitiseUsage(earlyCompactionTrigger, 1_000_000, {
				provider: "openai",
				estimatedContextTokens: 218_912,
			}),
		).toBeNull();
	});

	it("does nothing without a usable window", () => {
		expect(sanitiseUsage(plausible, undefined)).toBeNull();
		expect(sanitiseUsage(plausible, 0)).toBeNull();
		expect(sanitiseUsage(plausible, Number.NaN)).toBeNull();
	});

	it("does not mutate the original usage", () => {
		sanitiseUsage(plausible, 1_000_000);
		expect(plausible.totalTokens).toBe(4_087_626);
	});
});

describe("usage-guard extension", () => {
	function harness(contextWindow = 1_000_000, projectedMessages?: unknown[]) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(name, handler);
				return () => {};
			},
		} as never;
		registerUsageGuard(pi);
		const ctx = {
			model: { contextWindow },
			...(projectedMessages
				? { sessionManager: { buildSessionProjection: () => ({ messages: projectedMessages }) } }
				: {}),
		};
		return {
			emit: (event: unknown) => handlers.get("message_end")?.(event, ctx),
			handlers,
		};
	}

	function assistant(usage: typeof plausible) {
		return {
			type: "message_end",
			message: {
				role: "assistant",
				provider: "antigravity-acp",
				model: "gemini-3.8-flash",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
				usage,
			},
		};
	}

	it("registers a message_end handler", () => {
		expect(harness().handlers.has("message_end")).toBe(true);
	});

	it("replaces an assistant message carrying impossible usage", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = harness().emit(assistant(plausible)) as {
			message: { usage: { totalTokens: number } };
		};
		expect(result.message.usage.totalTokens).toBe(0);
		vi.restoreAllMocks();
	});

	it("clears inflated antigravity-acp below-window usage on message_end when transcript is small", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const inflatedBelowWindow = {
			...plausible,
			input: 65_795,
			output: 6_069,
			cacheRead: 434_790,
			totalTokens: 506_654,
		};
		const result = harness(1_000_000, [{ role: "user", content: "small prompt" }]).emit(
			assistant(inflatedBelowWindow),
		) as { message: { usage: { totalTokens: number } } };
		expect(result.message.usage.totalTokens).toBe(0);
		vi.restoreAllMocks();
	});

	it("returns nothing for a plausible report, so pi keeps the exact numbers", () => {
		const healthy = { ...plausible, cacheRead: 9_512, totalTokens: 185_626 };
		expect(harness().emit(assistant(healthy))).toBeUndefined();
	});

	it("ignores non-assistant messages", () => {
		const event = { type: "message_end", message: { role: "user", content: "hi" } };
		expect(harness().emit(event)).toBeUndefined();
	});
});

describe("usage-guard context safety net", () => {
	function harness(contextWindow = 1_000_000) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerUsageGuard({
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(name, handler);
				return () => {};
			},
		} as never);
		const ctx = { model: { contextWindow } };
		return (messages: unknown[]) =>
			handlers.get("context")?.({ type: "context", messages }, ctx) as
				| { messages: { usage?: { totalTokens: number } }[] }
				| undefined;
	}

	const poisonedMessage = { role: "assistant", content: [], stopReason: "stop", usage: plausible };
	const healthyMessage = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { ...plausible, cacheRead: 9_512, totalTokens: 185_626 },
	};

	it("heals a transcript that already carries impossible usage", () => {
		const result = harness()([{ role: "user", content: "hi" }, poisonedMessage]);
		expect(result?.messages[1].usage?.totalTokens).toBe(0);
	});

	it("heals below-window inflated antigravity-acp messages in context replay", () => {
		const inflatedMessage = {
			role: "assistant",
			provider: "antigravity-acp",
			content: [{ type: "text", text: "ok" }],
			stopReason: "stop",
			usage: { ...plausible, input: 120_000, cacheRead: 480_000, totalTokens: 600_000 },
		};
		const result = harness()([{ role: "user", content: "hi" }, inflatedMessage]);
		expect(result?.messages[1].usage?.totalTokens).toBe(0);
	});

	it("returns nothing when the whole transcript is plausible, leaving pi's numbers exact", () => {
		expect(harness()([{ role: "user", content: "hi" }, healthyMessage])).toBeUndefined();
	});

	it("keeps non-assistant messages as they are", () => {
		const user = { role: "user", content: "hi" };
		const result = harness()([user, poisonedMessage]);
		expect(result?.messages[0]).toBe(user);
	});
});
