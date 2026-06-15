/**
 * Video frame extraction (YouTube + local video), as called by
 * `extract.ts`'s `extractContent` dispatcher when the request has
 * `timestamp` or `frames` options.
 *
 * The dispatcher routes:
 *   1. YouTube URLs → `extractYouTubeFrame` / `extractYouTubeFrames`
 *   2. Local video  → `extractVideoFrame` via `extractLocalFrames`
 *   3. anything else → error
 *
 * The frame-batching math lives in `extract-timestamps.ts`. The
 * YouTube-specific plumbing lives in `youtube-extract.ts`; the local
 * video plumbing in `video-extract.ts`.
 */

import { isYouTubeURL, getYouTubeStreamInfo, extractYouTubeFrame, extractYouTubeFrames } from "./youtube-extract.js";
import { isVideoFile, extractVideoFrame, getLocalVideoDuration } from "./video-extract.js";
import { formatSeconds } from "./utils.js";
import { computeRangeTimestamps, MIN_FRAME_INTERVAL } from "./extract-timestamps.js";
import {
	abortedResult,
	errorMessage,
} from "./extract-utils.js";
import type { ExtractedContent, VideoFrame } from "./extract-types.js";

/**
 * Build the standard "we extracted N frames from URL at range" result
 * (or its error variant when zero frames came back). Used by both
 * the YouTube and local-video frame paths.
 */
export function buildFrameResult(
	url: string,
	label: string,
	requestedCount: number,
	frames: VideoFrame[],
	error: string | null,
	duration?: number,
): ExtractedContent {
	if (frames.length === 0) {
		const msg = error ?? "Frame extraction failed";
		return { url, title: `Frames ${label} (0/${requestedCount})`, content: msg, error: msg };
	}
	return {
		url,
		title: `Frames ${label} (${frames.length}/${requestedCount})`,
		content: `${frames.length} frames extracted from ${label}`,
		error: null,
		frames,
		duration,
	};
}

/**
 * Parallel local-video frame extraction. Returns both the successful
 * frames and the first error (if all failed), so the caller can
 * surface the error in `buildFrameResult`.
 */
export async function extractLocalFrames(
	filePath: string,
	timestamps: number[],
): Promise<{ frames: VideoFrame[]; error: string | null }> {
	const results = await Promise.all(
		timestamps.map(async (t) => {
			const frame = await extractVideoFrame(filePath, t);
			if ("error" in frame) return { error: frame.error };
			return { ...frame, timestamp: formatSeconds(t) };
		}),
	);
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const firstError = results.find((f): f is { error: string } => "error" in f);
	return { frames, error: frames.length === 0 && firstError ? firstError.error : null };
}

/**
 * Wraps `isVideoFile` so a thrown error becomes a structured return
 * value. Lets the dispatcher pattern-match without a try/catch around
 * a synchronous call.
 */
export function safeVideoInfo(url: string): { info: ReturnType<typeof isVideoFile>; error?: string } {
	try {
		return { info: isVideoFile(url) };
	} catch (err) {
		return { info: null, error: errorMessage(err) };
	}
}

/**
 * Handle the "frames only" request (no specific timestamp — sample N
 * frames across the whole video). Dispatches to YouTube or local
 * based on the URL.
 */
export async function extractFrames(
	url: string,
	frameCount: number,
	signal?: AbortSignal,
): Promise<ExtractedContent> {
	const ytInfo = isYouTubeURL(url);
	if (ytInfo.isYouTube && ytInfo.videoId) {
		const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
		if ("error" in streamInfo) {
			return { url, title: "Frames", content: streamInfo.error, error: streamInfo.error };
		}
		if (streamInfo.duration === null) {
			const error = "Cannot determine video duration. Use a timestamp range instead.";
			return { url, title: "Frames", content: error, error };
		}
		const dur = Math.floor(streamInfo.duration);
		const timestamps = computeRangeTimestamps(0, dur, frameCount);
		const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
		const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
		return buildFrameResult(url, label, timestamps.length, result.frames, result.error, streamInfo.duration);
	}

	const localVideo = safeVideoInfo(url);
	if (localVideo.error) {
		return { url, title: "", content: "", error: localVideo.error };
	}
	if (localVideo.info) {
		const durationResult = await getLocalVideoDuration(localVideo.info.absolutePath);
		if (typeof durationResult !== "number") {
			return { url, title: "Frames", content: durationResult.error, error: durationResult.error };
		}
		const dur = Math.floor(durationResult);
		const timestamps = computeRangeTimestamps(0, dur, frameCount);
		const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
		const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
		return buildFrameResult(url, label, timestamps.length, result.frames, result.error, durationResult);
	}

	return {
		url,
		title: "",
		content: "",
		error: "Frame extraction only works with YouTube and local video files",
	};
}

/**
 * Handle the "timestamp" request: parse the spec (single or range),
 * dispatch to YouTube or local, validate against video duration.
 */
export async function extractAtTimestamp(
	url: string,
	timestamp: string,
	frameCount: number | undefined,
): Promise<ExtractedContent> {
	const { parseTimestampSpec } = await import("./extract-timestamps.js");
	const spec = parseTimestampSpec(timestamp);
	if (!spec) {
		return {
			url,
			title: "",
			content: "",
			error: `Invalid timestamp format: "${timestamp}". Use "H:MM:SS", "MM:SS", "85", or "start-end".`,
		};
	}

	const ytInfo = isYouTubeURL(url);
	if (ytInfo.isYouTube && ytInfo.videoId) {
		return extractYouTubeAtTimestamp(url, ytInfo.videoId, spec, frameCount, timestamp);
	}

	const localVideo = safeVideoInfo(url);
	if (localVideo.error) {
		return { url, title: "", content: "", error: localVideo.error };
	}
	if (localVideo.info) {
		return extractLocalAtTimestamp(url, localVideo.info.absolutePath, spec, frameCount, timestamp);
	}

	return {
		url,
		title: "",
		content: "",
		error: "Timestamp extraction only works with YouTube and local video files",
	};
}

// --- private helpers (the YouTube and local timestamp paths) ---

async function extractYouTubeAtTimestamp(
	url: string,
	videoId: string,
	spec: { type: "single"; seconds: number } | { type: "range"; start: number; end: number },
	frameCount: number | undefined,
	rawTimestamp: string,
): Promise<ExtractedContent> {
	const streamInfo = await getYouTubeStreamInfo(videoId);
	if ("error" in streamInfo) {
		if (spec.type === "range") {
			const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
			return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
		}
		if (frameCount) {
			const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
			const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
			return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
		}
		return { url, title: `Frame at ${rawTimestamp}`, content: streamInfo.error, error: streamInfo.error };
	}

	if (spec.type === "range") {
		const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
		if (streamInfo.duration !== null && spec.end > streamInfo.duration) {
			const error = `Timestamp ${formatSeconds(spec.end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
			return { url, title: `Frames ${label}`, content: error, error };
		}
		const timestamps = frameCount
			? computeRangeTimestamps(spec.start, spec.end, frameCount)
			: computeRangeTimestamps(spec.start, spec.end);
		const result = await extractYouTubeFrames(videoId, timestamps, streamInfo);
		return buildFrameResult(
			url,
			label,
			timestamps.length,
			result.frames,
			result.error,
			result.duration ?? undefined,
		);
	}

	if (frameCount) {
		const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
		const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
		if (streamInfo.duration !== null && end > streamInfo.duration) {
			const error = `Timestamp ${formatSeconds(end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
			return { url, title: `Frames ${label}`, content: error, error };
		}
		const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
		const result = await extractYouTubeFrames(videoId, timestamps, streamInfo);
		return buildFrameResult(
			url,
			label,
			timestamps.length,
			result.frames,
			result.error,
			result.duration ?? undefined,
		);
	}

	if (streamInfo.duration !== null && spec.seconds > streamInfo.duration) {
		const error = `Timestamp ${formatSeconds(spec.seconds)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
		return { url, title: `Frame at ${rawTimestamp}`, content: error, error };
	}
	const frame = await extractYouTubeFrame(videoId, spec.seconds, streamInfo);
	if ("error" in frame) {
		return { url, title: `Frame at ${rawTimestamp}`, content: frame.error, error: frame.error };
	}
	return {
		url,
		title: `Frame at ${rawTimestamp}`,
		content: `Video frame at ${rawTimestamp}`,
		error: null,
		thumbnail: frame,
	};
}

async function extractLocalAtTimestamp(
	url: string,
	filePath: string,
	spec: { type: "single"; seconds: number } | { type: "range"; start: number; end: number },
	frameCount: number | undefined,
	rawTimestamp: string,
): Promise<ExtractedContent> {
	if (spec.type === "range") {
		const timestamps = frameCount
			? computeRangeTimestamps(spec.start, spec.end, frameCount)
			: computeRangeTimestamps(spec.start, spec.end);
		const result = await extractLocalFrames(filePath, timestamps);
		const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
		return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
	}

	if (frameCount) {
		const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
		const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
		const result = await extractLocalFrames(filePath, timestamps);
		const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
		return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
	}

	const frame = await extractVideoFrame(filePath, spec.seconds);
	if ("error" in frame) {
		return { url, title: `Frame at ${rawTimestamp}`, content: frame.error, error: frame.error };
	}
	return {
		url,
		title: `Frame at ${rawTimestamp}`,
		content: `Video frame at ${rawTimestamp}`,
		error: null,
		thumbnail: frame,
	};
}

// (abortedResult is re-exported for convenience to call sites that
// still want to use it via this module.)
export { abortedResult };
