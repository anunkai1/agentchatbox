import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateSummaryWithUsage } = vi.hoisted(() => ({
	generateSummaryWithUsage: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ generateSummaryWithUsage }));

import registerLocalQwenCompaction from "../extensions/local-qwen-compaction/index.js";

type CompactHandler = (event: any, ctx: any) => Promise<any>;

function register(): CompactHandler {
	let handler: CompactHandler | undefined;
	registerLocalQwenCompaction({
		on(name: string, candidate: CompactHandler) {
			if (name === "session_before_compact") handler = candidate;
		},
	} as any);
	if (!handler) throw new Error("session_before_compact handler was not registered");
	return handler;
}

function fixture() {
	const controller = new AbortController();
	const model = {
		provider: "local",
		id: "qwen3.8-27b-ud-q3",
		maxTokens: 32_768,
		reasoning: true,
	};
	const event = {
		customInstructions: "retain deployment details",
		signal: controller.signal,
		preparation: {
			messagesToSummarize: [{ role: "user", content: "history" }],
			turnPrefixMessages: [{ role: "assistant", content: [] }],
			previousSummary: "previous",
			firstKeptEntryId: "kept-1",
			tokensBefore: 90_000,
			fileOps: {
				read: new Set(["z.ts", "changed.ts", "a.ts"]),
				written: new Set(["changed.ts"]),
				edited: new Set(["edited.ts"]),
			},
		},
	};
	const ctx = {
		model,
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn().mockResolvedValue({
				ok: true,
				apiKey: "test-key",
				headers: { "x-test": "yes", "x-remove": null },
				env: { TEST: "1" },
			}),
		},
	};
	return { controller, model, event, ctx };
}

describe("local Qwen compaction extension", () => {
	beforeEach(() => generateSummaryWithUsage.mockReset());

	it("leaves other models on pi's standard compactor", async () => {
		const handler = register();
		const { event, ctx } = fixture();
		ctx.model = { ...ctx.model, provider: "openai" };

		expect(await handler(event, ctx)).toBeUndefined();
		expect(generateSummaryWithUsage).not.toHaveBeenCalled();
	});

	it("uses one bounded non-reasoning summary and preserves compaction metadata", async () => {
		generateSummaryWithUsage.mockResolvedValue({
			text: "checkpoint\n",
			usage: { input: 10, output: 5 },
		});
		const handler = register();
		const { model, event, ctx } = fixture();

		const result = await handler(event, ctx);
		expect(generateSummaryWithUsage).toHaveBeenCalledOnce();
		const args = generateSummaryWithUsage.mock.calls[0];
		expect(args[0]).toEqual([
			{ role: "user", content: "history" },
			{ role: "assistant", content: [] },
		]);
		expect(args[1]).toBe(model);
		expect(args[2]).toBe(2_560);
		expect(args[4]).toEqual({ "x-test": "yes" });
		expect(args[6]).toContain("retain deployment details");
		expect(args[7]).toBe("previous");
		expect(args[8]).toBe("off");
		expect(result).toEqual({
			compaction: {
				summary:
					"checkpoint\n\n<read-files>\na.ts\nz.ts\n</read-files>\n\n<modified-files>\nchanged.ts\nedited.ts\n</modified-files>",
				firstKeptEntryId: "kept-1",
				tokensBefore: 90_000,
				usage: { input: 10, output: 5 },
				details: {
					readFiles: ["a.ts", "z.ts"],
					modifiedFiles: ["changed.ts", "edited.ts"],
				},
			},
		});
	});
});
