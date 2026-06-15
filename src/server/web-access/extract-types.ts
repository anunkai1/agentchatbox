/**
 * Shared types for the web-access extraction pipeline.
 *
 * These were previously embedded in `extract.ts`. Pulled out so the
 * split modules (`extract-http.ts`, `extract-jina.ts`, `extract-frames.ts`,
 * etc.) can import them without pulling in the dispatcher's
 * side-effecting `extractContent`.
 */

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
}

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	model?: string;
}

/**
 * Parsed timestamp for video frame extraction. Either a single
 * timestamp in seconds, or a [start, end] range in seconds.
 */
export type TimestampSpec =
	| { type: "single"; seconds: number }
	| { type: "range"; start: number; end: number };
