/**
 * Shared formatting for the allowance commands. Both providers report absolute
 * reset timestamps; the owner reads them in Australia/Brisbane, which is not the
 * server's zone, so every reset is rendered in AEST with a countdown beside it.
 */

export function brisbane(epochSeconds: number): string {
	const parts = new Intl.DateTimeFormat("en-AU", {
		timeZone: "Australia/Brisbane",
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(new Date(epochSeconds * 1000));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)?.value ?? "";
	return `${part("day")}/${part("month")} ${part("hour")}:${part("minute")}`;
}

export function duration(seconds: number): string {
	const totalMinutes = Math.round(seconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours >= 24) {
		return `${Math.floor(hours / 24)}d ${hours % 24}h`;
	}
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Reset time plus countdown, for use after "resets". */
export function resetAt(epochSeconds: number | undefined, now: number): string {
	if (!epochSeconds) return "unknown";
	const countdown = ` (in ${duration(Math.max(0, epochSeconds - now))})`;
	return `${brisbane(epochSeconds)} AEST${countdown}`;
}

/** Warn as an allowance runs out: caution at 20% left, exhausted at none. */
export function remainingFlag(percentLeft: number): string {
	if (percentLeft <= 0) return " 🚫";
	return percentLeft <= 20 ? " ⚠️" : "";
}
