import { describe, expect, it } from "vitest";
import {
	brisbaneDayKey,
	buildSidebarEntries,
	msUntilNextBrisbaneMidnight,
	sessionDateGroup,
} from "../src/client/session-groups.js";
import { buildSessionTree, visibleSessionRows } from "../src/client/session-tree.js";
import type { SessionSummary } from "../src/shared/protocol.js";

const session = (id: string, modifiedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	title: id,
	cwd: "/repo/app",
	projectId: "global",
	createdAt: modifiedAt,
	modifiedAt,
	messageCount: 2,
	...extra,
});

describe("sidebar date grouping (Australia/Brisbane)", () => {
	// 16 Nov 2026 00:37 AEST (15 Nov 2026 14:37 UTC)
	const now = Date.parse("2026-11-16T00:37:00+10:00");

	it("buckets pinned, Today, Yesterday, Last 7 Days, and monthly groups", () => {
		expect(sessionDateGroup("2026-01-01T00:00:00Z", now, true)).toEqual({
			key: "pinned",
			label: "Pinned",
		});
		// 15 Nov 14:10 UTC is 16 Nov 00:10 AEST -> Today in Brisbane
		expect(sessionDateGroup("2026-11-15T14:10:00Z", now)).toEqual({
			key: "today",
			label: "Today",
		});
		// 15 Nov 23:50 AEST -> Yesterday
		expect(sessionDateGroup("2026-11-15T23:50:00+10:00", now)).toEqual({
			key: "yesterday",
			label: "Yesterday",
		});
		// 2..6 days ago -> Last 7 Days
		expect(sessionDateGroup("2026-11-14T12:00:00+10:00", now)).toEqual({
			key: "last-7-days",
			label: "Last 7 Days",
		});
		expect(sessionDateGroup("2026-11-10T00:05:00+10:00", now)).toEqual({
			key: "last-7-days",
			label: "Last 7 Days",
		});
		// 7+ days ago -> Month Year
		expect(sessionDateGroup("2026-11-09T23:59:00+10:00", now)).toEqual({
			key: "month:2026-11",
			label: "November 2026",
		});
		expect(sessionDateGroup("2026-10-15T12:00:00+10:00", now)).toEqual({
			key: "month:2026-10",
			label: "October 2026",
		});
		expect(sessionDateGroup("2026-04-01T12:00:00+10:00", now)).toEqual({
			key: "month:2026-04",
			label: "April 2026",
		});
		expect(sessionDateGroup("2025-12-20T12:00:00+10:00", now)).toEqual({
			key: "month:2025-12",
			label: "December 2025",
		});
	});

	it("interleaves headers once per group, keeps worker children attached, and computes offsets", () => {
		const sessions = [
			session("pin", "2026-03-05T10:00:00+10:00", { pinned: true }),
			session("today-1", "2026-11-16T00:10:00+10:00"),
			session("yest-parent", "2026-11-15T10:00:00+10:00"),
			session("yest-worker", "2026-11-14T09:00:00+10:00", {
				delegation: { parentSessionId: "yest-parent", status: "done" },
			}),
			session("week-1", "2026-11-12T10:00:00+10:00"),
			session("nov-1", "2026-11-02T10:00:00+10:00"),
			session("oct-1", "2026-10-20T10:00:00+10:00"),
			session("oct-2", "2026-10-03T10:00:00+10:00"),
			session("jan-1", "2026-01-11T10:00:00+10:00"),
		];
		const { roots } = buildSessionTree(sessions);
		const rows = visibleSessionRows(roots, new Set());
		const { entries, totalHeight } = buildSidebarEntries(rows, {
			headerHeight: 28,
			rowPitch: 59,
			rowHeight: 57,
			nowMs: now,
		});

		expect(
			entries.map((e) => (e.kind === "header" ? `H:${e.label}` : `S:${e.row.node.session.id}`)),
		).toEqual([
			"H:Pinned",
			"S:pin",
			"H:Today",
			"S:today-1",
			"H:Yesterday",
			"S:yest-parent",
			"S:yest-worker",
			"H:Last 7 Days",
			"S:week-1",
			"H:November 2026",
			"S:nov-1",
			"H:October 2026",
			"S:oct-1",
			"S:oct-2",
			"H:January 2026",
			"S:jan-1",
		]);
		// 7 headers * 28 + 9 sessions * 59
		expect(totalHeight).toBe(7 * 28 + 9 * 59);
		for (let i = 1; i < entries.length; i++) {
			expect(entries[i].top).toBeGreaterThanOrEqual(entries[i - 1].top + entries[i - 1].height);
		}
	});

	it("skips collapsed group rows (including workers) while keeping group counts", () => {
		const sessions = [
			session("today-1", "2026-11-16T00:10:00+10:00"),
			session("yest-parent", "2026-11-15T10:00:00+10:00"),
			session("yest-worker", "2026-11-14T09:00:00+10:00", {
				delegation: { parentSessionId: "yest-parent", status: "done" },
			}),
			session("oct-1", "2026-10-20T10:00:00+10:00"),
			session("oct-2", "2026-10-03T10:00:00+10:00"),
		];
		const { roots } = buildSessionTree(sessions);
		const rows = visibleSessionRows(roots, new Set());
		const { entries, totalHeight } = buildSidebarEntries(rows, {
			headerHeight: 30,
			rowPitch: 59,
			rowHeight: 57,
			nowMs: now,
			isGroupCollapsed: (key) => key === "yesterday" || key === "month:2026-10",
		});

		expect(entries).toHaveLength(4);
		expect(entries[0]).toMatchObject({ kind: "header", label: "Today", count: 1, collapsed: false });
		expect(entries[1]).toMatchObject({ kind: "session", top: 30 });
		expect(entries[2]).toMatchObject({
			kind: "header",
			label: "Yesterday",
			count: 1,
			collapsed: true,
			top: 89,
		});
		expect(entries[3]).toMatchObject({
			kind: "header",
			label: "October 2026",
			count: 2,
			collapsed: true,
			top: 119,
		});
		expect(totalHeight).toBe(3 * 30 + 59);
	});

	it("computes Brisbane day keys and time until midnight", () => {
		expect(brisbaneDayKey(now)).toBe("2026-11-16");
		const ms = msUntilNextBrisbaneMidnight(now);
		// 23h 23m (+250ms buffer) until 2026-11-17T00:00:00+10:00
		expect(ms).toBe((23 * 60 + 23) * 60 * 1000 + 250);
	});
});
