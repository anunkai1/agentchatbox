import type { SessionTreeRow } from "./session-tree.js";

const TZ = "Australia/Brisbane";
const DAY_MS = 86_400_000;
/** Australia/Brisbane is UTC+10 year-round (no DST). */
const BRISBANE_OFFSET_MS = 10 * 3_600_000;

const brisbaneDatePartsFmt = new Intl.DateTimeFormat("en-AU", {
	timeZone: TZ,
	year: "numeric",
	month: "numeric",
	day: "numeric",
});

const brisbaneMonthFmt = new Intl.DateTimeFormat("en-AU", {
	timeZone: TZ,
	month: "long",
	year: "numeric",
});

export interface SessionDateGroup {
	key: string;
	label: string;
}

export interface SidebarHeaderEntry {
	kind: "header";
	key: string;
	label: string;
	count: number;
	collapsed: boolean;
	top: number;
	height: number;
}

export type SidebarListEntry =
	| SidebarHeaderEntry
	| { kind: "session"; row: SessionTreeRow; top: number; height: number };

function getBrisbaneDateParts(ms: number): { year: number; month: number; day: number } {
	const parts = brisbaneDatePartsFmt.formatToParts(new Date(ms));
	const num = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((p) => p.type === type)?.value ?? 0);
	return {
		year: num("year"),
		month: num("month"),
		day: num("day"),
	};
}

function brisbaneDayIndex(ms: number): number {
	const { year, month, day } = getBrisbaneDateParts(ms);
	return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** Calendar day string (YYYY-MM-DD) in Australia/Brisbane for rollover detection. */
export function brisbaneDayKey(nowMs = Date.now()): string {
	const { year, month, day } = getBrisbaneDateParts(nowMs);
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Milliseconds until the next Australia/Brisbane midnight (with a small buffer). */
export function msUntilNextBrisbaneMidnight(nowMs = Date.now()): number {
	const { year, month, day } = getBrisbaneDateParts(nowMs);
	const nextMidnightMs = Date.UTC(year, month - 1, day + 1) - BRISBANE_OFFSET_MS;
	return Math.max(1000, nextMidnightMs - nowMs + 250);
}

/** Per-project localStorage key for collapsing a date group independently. */
export function dateGroupCollapseId(projectId: string, groupKey: string): string {
	return `${projectId}:${groupKey}`;
}

/**
 * Bucket a session into Today, Yesterday, Last 7 Days, or calendar Month Year
 * (e.g. "November 2026", "October 2026", "April 2026") in Australia/Brisbane.
 */
export function sessionDateGroup(
	iso: string,
	nowMs = Date.now(),
	pinned = false,
): SessionDateGroup {
	if (pinned) return { key: "pinned", label: "Pinned" };
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return { key: "older", label: "Older" };
	const diffDays = brisbaneDayIndex(nowMs) - brisbaneDayIndex(ms);
	if (diffDays <= 0) return { key: "today", label: "Today" };
	if (diffDays === 1) return { key: "yesterday", label: "Yesterday" };
	if (diffDays < 7) return { key: "last-7-days", label: "Last 7 Days" };
	const { year, month } = getBrisbaneDateParts(ms);
	return {
		key: `month:${year}-${String(month).padStart(2, "0")}`,
		label: brisbaneMonthFmt.format(new Date(ms)),
	};
}

/**
 * Interleave collapsible date group headers into a flattened session tree list
 * and precompute fixed vertical offsets for virtualised rendering.
 * Child worker rows stay beneath their parent and follow its group's collapse state.
 */
export function buildSidebarEntries(
	rows: SessionTreeRow[],
	opts: {
		headerHeight: number;
		rowPitch: number;
		rowHeight: number;
		nowMs?: number;
		isGroupCollapsed?: (groupKey: string) => boolean;
	},
): { entries: SidebarListEntry[]; totalHeight: number } {
	const nowMs = opts.nowMs ?? Date.now();
	const entries: SidebarListEntry[] = [];
	let currentHeader: SidebarHeaderEntry | null = null;
	let currentCollapsed = false;
	let currentKey: string | null = null;
	let y = 0;

	for (const row of rows) {
		if (row.depth === 0) {
			const group = sessionDateGroup(row.node.modifiedAt, nowMs, !!row.node.session.pinned);
			if (group.key !== currentKey) {
				currentKey = group.key;
				currentCollapsed = opts.isGroupCollapsed?.(group.key) ?? false;
				currentHeader = {
					kind: "header",
					key: group.key,
					label: group.label,
					count: 0,
					collapsed: currentCollapsed,
					top: y,
					height: opts.headerHeight,
				};
				entries.push(currentHeader);
				y += opts.headerHeight;
			}
			if (currentHeader) currentHeader.count += 1;
		}
		if (currentCollapsed) continue;
		entries.push({
			kind: "session",
			row,
			top: y,
			height: opts.rowHeight,
		});
		y += opts.rowPitch;
	}

	return { entries, totalHeight: y };
}
