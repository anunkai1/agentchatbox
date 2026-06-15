/// <reference lib="dom" />

import pLimit from "p-limit";
import { extractGitHub } from "./github-extract.js";
import { isYouTubeURL, isYouTubeEnabled, extractYouTube } from "./youtube-extract.js";
import { isVideoFile, extractVideo } from "./video-extract.js";
import { extractWithUrlContext } from "./gemini-url-context.js";
import { extractViaHttp } from "./extract-http.js";
import { extractWithJinaReader } from "./extract-jina.js";
import { extractFrames, extractAtTimestamp } from "./extract-frames.js";
import {
	abortedResult,
	errorMessage,
	isAbortError,
	isConfigParseError,
	NON_RECOVERABLE_ERRORS,
	extractHeadingTitle,
	extractTextTitle,
} from "./extract-utils.js";
import type { ExtractedContent, ExtractOptions } from "./extract-types.js";

const CONCURRENT_LIMIT = 3;
const fetchLimit = pLimit(CONCURRENT_LIMIT);

// Re-export the public types so existing consumers
// (`web-tools.ts`, etc.) keep working without an import change.
export type {
	ExtractedContent,
	ExtractOptions,
	VideoFrame,
	FrameData,
	FrameResult,
	TimestampSpec,
} from "./extract-types.js";
export { extractHeadingTitle } from "./extract-utils.js";

/**
 * Public entry point. Routes the URL to the right extractor:
 *
 *   1. timestamp / frames option → extract-frames.ts (YouTube or local video)
 *   2. local video file           → video-extract.ts (Gemini Files API)
 *   3. GitHub URL                  → github-extract.ts (clone + walk)
 *   4. YouTube URL (if enabled)    → youtube-extract.ts (Gemini)
 *   5. anything else               → extract-http.ts → extract-jina.ts → gemini-url-context
 *
 * Returns an `ExtractedContent` with either `content` populated or
 * `error` set to a human-readable string. Never throws on
 * recoverable failures.
 */
export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	// Video frame requests (specific timestamp or "give me N frames
	// of this video") are routed to the frame extractor before any
	// other path — they don't make sense as plain URL fetches.
	if (options?.frames && !options.timestamp) {
		return extractFrames(url, options.frames, signal);
	}
	if (options?.timestamp) {
		return extractAtTimestamp(url, options.timestamp, options.frames);
	}

	// Local video file → Gemini Files API.
	const localVideo = isVideoFile(url);
	if (localVideo) {
		try {
			const result = await extractVideo(localVideo, signal, options);
			if (signal?.aborted) return abortedResult(url);
			return (
				result ?? {
					url,
					title: "",
					content: "",
					error:
						"Video analysis requires Gemini access. Either:\n  1. Sign into gemini.google.com in Chrome (free, uses cookies)\n  2. Set GEMINI_API_KEY in ~/.pi/web-search.json",
				}
			);
		} catch (err) {
			if (isAbortError(err)) return abortedResult(url);
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	// GitHub URL → clone + walk.
	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone);
		if (ghResult) return ghResult;
		if (signal?.aborted) return abortedResult(url);
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { url, title: "", content: "", error: message };
		}
	}

	// YouTube URL → Gemini visual understanding (when enabled).
	const ytInfo = isYouTubeURL(url);
	let youtubeEnabled = false;
	try {
		youtubeEnabled = isYouTubeEnabled();
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	if (ytInfo.isYouTube && youtubeEnabled) {
		try {
			const ytResult = await extractYouTube(url, signal, options?.prompt, options?.model);
			if (ytResult) return ytResult;
			if (signal?.aborted) return abortedResult(url);
		} catch (err) {
			const message = errorMessage(err);
			if (isAbortError(err)) return abortedResult(url);
			if (isConfigParseError(err)) {
				return { url, title: "", content: "", error: message };
			}
		}
		return {
			url,
			title: "",
			content: "",
			error:
				"Could not extract YouTube video content. Sign into Google in Chrome for automatic access, or set GEMINI_API_KEY.",
		};
	}

	if (signal?.aborted) return abortedResult(url);

	// Plain URL → HTTP, with Jina Reader and Gemini URL-context as
	// fallbacks when the HTTP path gets blocked or returns junk.
	const httpResult = await extractViaHttp(url, signal, options);

	if (signal?.aborted) return abortedResult(url);
	if (!httpResult.error) return httpResult;
	if (NON_RECOVERABLE_ERRORS.some((prefix) => httpResult.error!.startsWith(prefix))) return httpResult;

	const jinaResult = await extractWithJinaReader(url, signal);
	if (jinaResult) return jinaResult;
	if (signal?.aborted) return abortedResult(url);

	let geminiResult: ExtractedContent | null = null;
	try {
		geminiResult = await extractWithUrlContext(url, signal);
		// extractWithGeminiWeb removed (needs browser cookies)
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { ...httpResult, error: errorMessage(err) };
		}
	}

	if (geminiResult) return geminiResult;
	if (signal?.aborted) return abortedResult(url);

	const guidance = [
		httpResult.error,
		"",
		"Fallback options:",
		"  • Set GEMINI_API_KEY in ~/.pi/web-search.json",
		"  • Sign into gemini.google.com in Chrome",
		"  • Use web_search to find content about this topic",
	].join("\n");
	return { ...httpResult, error: guidance };
}

/**
 * Extract many URLs in parallel, capped at CONCURRENT_LIMIT.
 * Used by callers that need to batch-process a list.
 */
export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	return Promise.all(
		urls.map((url) => fetchLimit(() => extractContent(url, signal, options))),
	);
}
