/**
 * Timestamp formatting for chat bubbles.
 *
 * All messages carry an epoch-ms `ts` sourced from the SDK `Message.timestamp`
 * (authoritative, survives resume/fork). The transport layer never touches
 * time — this is pure client display.
 *
 * Times are rendered in **Brisbane local time** (`Australia/Brisbane`, AEST,
 * no DST) via `Intl.DateTimeFormat` — no manual offset math.
 *
 * Each chip shows BOTH formats, always visible inline (no hover):
 *  - `formatAbsolute` — the primary read ("2 July 2026, 4:33pm").
 *  - `formatRelative` — a secondary "2m ago" suffix (faded).
 *
 * `formatRelative` is computed at render time against `Date.now()`; it is
 * not live-updating (refreshes on any re-render, which is fine for a chat
 * surface).
 */

const TZ = "Australia/Brisbane";

const absoluteFmt = new Intl.DateTimeFormat("en-AU", {
	timeZone: TZ,
	day: "numeric",
	month: "long",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
	hour12: true,
});

const shortDateFmt = new Intl.DateTimeFormat("en-AU", {
	timeZone: TZ,
	month: "short",
	day: "numeric",
});

const shortDateYearFmt = new Intl.DateTimeFormat("en-AU", {
	timeZone: TZ,
	month: "short",
	day: "numeric",
	year: "2-digit",
});

/**
 * Relative label: "just now" (<1m), "Nm"/"Nh"/"Nd", then a short calendar
 * date for anything older than a week (same-year omits the year).
 */
export function formatRelative(ts: number): string {
	const diff = Date.now() - ts;
	const sec = Math.floor(diff / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}d`;
	const d = new Date(ts);
	const now = new Date();
	return d.getFullYear() === now.getFullYear()
		? shortDateFmt.format(d)
		: shortDateYearFmt.format(d);
}

/**
 * Always-visible Brisbane-time label, e.g. "2 July 2026, 4:33pm".
 * Assembled from formatToParts so we control the exact shape
 * (full month name, no leading zero on day/hour, lowercase am/pm
 * with no space) regardless of locale defaults.
 */
export function formatAbsolute(ts: number): string {
	const parts = absoluteFmt.formatToParts(new Date(ts));
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	const period = get("dayPeriod").toLowerCase();
	return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}${period}`;
}
