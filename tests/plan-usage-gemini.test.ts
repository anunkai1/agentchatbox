import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeBlocks, formatQuota, type QuotaSummary } from "../extensions/plan-usage/gemini.js";

const tempDirs: string[] = [];

function makeLogDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "acb-gemini-logs-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("activeBlocks", () => {
	it("scans rotated ACP warning logs and tracks the newest active block per model", () => {
		const dir = makeLogDir();
		const now = Date.parse("2026-11-15T03:20:00Z") / 1000;

		const olderLog = join(dir, "agy_acp_server.par.host.user.log.WARNING.20261115-100000.100");
		const newerLog = join(dir, "agy_acp_server.par.host.user.log.WARNING.20261115-131753.200");

		// Older log holds blocks from before an ACP server restart, plus an expired entry.
		writeFileSync(
			olderLog,
			[
				"W1115 09:00:00.000 100 local_connection.py:526] metadata:map[model:gemini-3-flash quotaResetTimeStamp:2026-11-15T01:00:00Z uiMessage:true]",
				"W1115 10:00:00.000 100 local_connection.py:526] metadata:map[model:gemini-4-argon-high quotaResetTimeStamp:2026-11-21T12:00:57Z uiMessage:true]",
				"W1115 10:05:00.000 100 local_connection.py:526] metadata:map[model:claude-opus-5-5-high quotaResetTimeStamp:2026-11-15T07:00:00Z]",
			].join("\n"),
		);
		// Newer log from restarted ACP has no 429s yet.
		writeFileSync(newerLog, "W1115 13:17:53.000 200 startup.py:10] Server started\n");

		utimesSync(olderLog, now - 600, now - 600);
		utimesSync(newerLog, now - 10, now - 10);

		const blocks = activeBlocks(now, { dir });
		expect(blocks).toEqual([
			{ model: "claude-opus-5-5-high", resetsAt: Date.parse("2026-11-15T07:00:00Z") / 1000 },
			{ model: "gemini-4-argon-high", resetsAt: Date.parse("2026-11-21T12:00:57Z") / 1000 },
		]);
	});

	it("prefers the newest log file when the same model has an updated reset timestamp", () => {
		const dir = makeLogDir();
		const now = Date.parse("2026-11-15T03:20:00Z") / 1000;

		const olderLog = join(dir, "agy_acp_server.par.host.user.log.WARNING.20261115-100000.100");
		const newerLog = join(dir, "agy_acp_server.par.host.user.log.WARNING.20261115-120000.200");

		writeFileSync(
			olderLog,
			"W1115 10:00:00.000 100 local_connection.py:526] model:claude-sonnet-5-5-high quotaResetTimeStamp:2026-11-15T06:00:00Z\n",
		);
		writeFileSync(
			newerLog,
			"W1115 12:00:00.000 200 local_connection.py:526] model:claude-sonnet-5-5-high quotaResetTimeStamp:2026-11-15T08:30:00Z\n",
		);

		utimesSync(olderLog, now - 600, now - 600);
		utimesSync(newerLog, now - 60, now - 60);

		expect(activeBlocks(now, { dir })).toEqual([
			{ model: "claude-sonnet-5-5-high", resetsAt: Date.parse("2026-11-15T08:30:00Z") / 1000 },
		]);
	});
});

describe("formatQuota", () => {
	const now = Date.parse("2026-11-15T03:20:00Z") / 1000;

	const sampleSummary: QuotaSummary = {
		groups: [
			{
				displayName: "Gemini Models",
				buckets: [
					{
						bucketId: "gemini-weekly",
						displayName: "Weekly Limit Remaining",
						window: "weekly",
						resetTime: "2026-11-19T21:54:01Z",
						remainingFraction: 0.37737367,
					},
					{
						bucketId: "gemini-5h",
						displayName: "Five Hour Limit Remaining",
						window: "5h",
						resetTime: "2026-11-15T08:19:59Z",
						remainingFraction: 1,
					},
				],
			},
			{
				displayName: "Claude and GPT models",
				buckets: [
					{
						bucketId: "3p-weekly",
						displayName: "Weekly Limit Remaining",
						window: "weekly",
						resetTime: "2026-11-22T03:19:59Z",
						remainingFraction: 1,
					},
					{
						bucketId: "3p-5h",
						displayName: "Five Hour Limit Remaining",
						window: "5h",
						resetTime: "2026-11-15T08:19:59Z",
						remainingFraction: 1,
					},
				],
			},
			{
				displayName: "Gemini 4 Argon",
				buckets: [
					{
						bucketId: "gemini-argon-wtu-weekly",
						displayName: "Gemini 4 Argon Weekly Limit",
						window: "weekly",
						resetTime: "2026-11-22T03:19:59Z",
						remainingFraction: 1,
					},
				],
			},
		],
	};

	it("marks unused rolling windows as starting on use and places Argon 429s under Argon", () => {
		const lines = formatQuota(sampleSummary, now, [
			{ model: "gemini-4-argon-high", resetsAt: Date.parse("2026-11-21T12:00:57Z") / 1000 },
		]);

		expect(lines).toEqual([
			"**📊 /gemini-usage** — Antigravity (Gemini)",
			"_Gemini Models_",
			"Weekly Limit Remaining: 38% left · resets 20/11 07:54 AEST (in 4d 18h)",
			"Five Hour Limit Remaining: 100% left · window starts on use",
			"_Claude and GPT models_",
			"Weekly Limit Remaining: 100% left · window starts on use",
			"Five Hour Limit Remaining: 100% left · window starts on use",
			"_Gemini 4 Argon_ _— reported only, not what Google enforces_",
			"⛔ gemini-4-argon-high: refused by Google — resets 21/11 22:00 AEST (in 6d 8h)",
		]);
	});

	it("keeps Argon advisory when no 429 is active", () => {
		const lines = formatQuota(sampleSummary, now, []);
		expect(lines).toContain("_Gemini 4 Argon_ _— reported only, not what Google enforces_");
		expect(lines).toContain("Gemini 4 Argon Weekly Limit: 100% left · window starts on use");
	});

	it("attaches Claude/GPT and Gemini 429s to their matching groups without dropping partial usage", () => {
		const lines = formatQuota(sampleSummary, now, [
			{ model: "gemini-3-flash", resetsAt: Date.parse("2026-11-15T07:20:00Z") / 1000 },
			{ model: "claude-opus-5-5-high", resetsAt: Date.parse("2026-11-15T06:20:00Z") / 1000 },
			{ model: "unknown-model", resetsAt: Date.parse("2026-11-15T05:20:00Z") / 1000 },
		]);

		expect(lines).toEqual([
			"**📊 /gemini-usage** — Antigravity (Gemini)",
			"_Gemini Models_",
			"Weekly Limit Remaining: 38% left · resets 20/11 07:54 AEST (in 4d 18h)",
			"⛔ gemini-3-flash: refused by Google — resets 15/11 17:20 AEST (in 4h 0m)",
			"_Claude and GPT models_",
			"⛔ claude-opus-5-5-high: refused by Google — resets 15/11 16:20 AEST (in 3h 0m)",
			"_Gemini 4 Argon_ _— reported only, not what Google enforces_",
			"Gemini 4 Argon Weekly Limit: 100% left · window starts on use",
			"⛔ unknown-model: refused by Google — resets 15/11 15:20 AEST (in 2h 0m)",
		]);
	});
});
