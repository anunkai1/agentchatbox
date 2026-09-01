import { describe, expect, it } from "vitest";
import { buildStatusSnapshot } from "../src/server/session-registry.js";

describe("Shed lifecycle projection", () => {
	it("exposes ready transport state without pending sessions", () => {
		const completed = {
			reason: "threshold" as const,
			tokensBefore: 120_000,
			estimatedTokensAfter: 7_000,
			completedAt: 1234,
		};
		const entries = new Map([
			[
				"ready-session",
				{
					ready: true,
					init: {
						provider: "local",
						modelId: "qwen",
						thinkingLevel: "high" as const,
						cwd: "/srv/project",
					},
					busy: true,
					streaming: true,
					compaction: { reason: "overflow" as const, startedAt: 1000 },
					lastCompaction: completed,
				},
			],
			[
				"pending-session",
				{
					ready: false,
					init: { provider: "venice", modelId: "pending", thinkingLevel: "off" as const },
					busy: false,
					streaming: false,
					compaction: null,
					lastCompaction: null,
				},
			],
		]);

		expect(buildStatusSnapshot(entries)).toEqual([
			{
				sessionId: "ready-session",
				cwd: "/srv/project",
				provider: "local",
				modelId: "qwen",
				busy: true,
				streaming: true,
				compaction: { reason: "overflow", startedAt: 1000 },
				lastCompaction: completed,
			},
		]);
	});
});
