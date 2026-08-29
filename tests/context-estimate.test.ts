import { beforeEach, describe, expect, it } from "vitest";
import {
	reconcileContextUsage,
	resetContextEstimate,
	seedPostCompactionEstimate,
} from "../src/client/context-estimate.js";

describe("post-compaction context estimate", () => {
	beforeEach(() => resetContextEstimate());

	it("survives pi's expected unknown snapshot immediately after compaction", () => {
		const seeded = seedPostCompactionEstimate(24_000, 100_000);
		expect(seeded).toEqual({ tokens: 24_000, contextWindow: 100_000, percent: 24 });

		expect(reconcileContextUsage({ tokens: null, contextWindow: 100_000, percent: null })).toEqual(
			seeded,
		);
	});

	it("is replaced by the first numeric ground-truth snapshot", () => {
		seedPostCompactionEstimate(24_000, 100_000);
		const exact = { tokens: 25_500, contextWindow: 100_000, percent: 25.5 };
		expect(reconcileContextUsage(exact)).toEqual(exact);
		expect(reconcileContextUsage({ tokens: null, contextWindow: 100_000, percent: null })).toEqual({
			tokens: null,
			contextWindow: 100_000,
			percent: null,
		});
	});

	it("does not carry a seed into a different context window or session reset", () => {
		seedPostCompactionEstimate(24_000, 100_000);
		const switched = { tokens: null, contextWindow: 200_000, percent: null };
		expect(reconcileContextUsage(switched)).toEqual(switched);

		seedPostCompactionEstimate(24_000, 100_000);
		resetContextEstimate();
		const resumed = { tokens: null, contextWindow: 100_000, percent: null };
		expect(reconcileContextUsage(resumed)).toEqual(resumed);
	});
});
