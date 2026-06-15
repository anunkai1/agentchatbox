/**
 * Timestamp parsing + frame-sampling math for video extraction.
 *
 * Accepts both raw-seconds ("85") and clock-time ("H:MM:SS", "MM:SS")
 * formats, plus start-end ranges ("23:41-25:00"). Used by
 * `extract-frames.ts` for both YouTube and local-video frame paths.
 */

import type { TimestampSpec } from "./extract-types.js";

/**
 * Default number of frames to sample when the user asks for a range
 * but doesn't specify how many. (Single-timestamp requests always
 * return 1 frame.)
 */
export const DEFAULT_RANGE_FRAMES = 6;

/**
 * Minimum spacing in seconds between two adjacent frames in a range.
 * Caps the sample density — below this, we'd be sampling sub-second
 * frames which is wasteful and often uninteresting.
 */
export const MIN_FRAME_INTERVAL = 5;

function parseTimestamp(ts: string): number | null {
	const num = Number(ts);
	if (!isNaN(num) && num >= 0) return Math.floor(num);
	const parts = ts.split(":").map(Number);
	if (parts.some((p) => isNaN(p) || p < 0)) return null;
	if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
	if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
	return null;
}

export function parseTimestampSpec(ts: string): TimestampSpec | null {
	const dashIdx = ts.indexOf("-", 1);
	if (dashIdx > 0) {
		const start = parseTimestamp(ts.slice(0, dashIdx));
		const end = parseTimestamp(ts.slice(dashIdx + 1));
		if (start !== null && end !== null && end > start) return { type: "range", start, end };
	}
	const seconds = parseTimestamp(ts);
	return seconds !== null ? { type: "single", seconds } : null;
}

/**
 * Sample `maxFrames` timestamps evenly across [start, end]. If the
 * ideal interval would be tighter than MIN_FRAME_INTERVAL, we step at
 * MIN_FRAME_INTERVAL instead (clamped to maxFrames).
 */
export function computeRangeTimestamps(
	start: number,
	end: number,
	maxFrames: number = DEFAULT_RANGE_FRAMES,
): number[] {
	if (maxFrames <= 1) return [start];
	const duration = end - start;
	const idealInterval = duration / (maxFrames - 1);
	if (idealInterval < MIN_FRAME_INTERVAL) {
		const timestamps: number[] = [];
		for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
			timestamps.push(t);
		}
		return timestamps;
	}
	return Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * idealInterval));
}
