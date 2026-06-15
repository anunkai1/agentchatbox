/**
 * Jina Reader fallback (`r.jina.ai/{url}` returns markdown for any
 * public URL). Used by the main dispatcher when the direct HTTP path
 * fails on a JS-rendered or otherwise uncooperative page.
 *
 * Free, no API key, returns the page as markdown with the readable
 * content extracted server-side. Returns `null` (not an error result)
 * when the response is missing/empty/JS-rendered — the caller
 * decides whether to try the next fallback.
 */

import { activityMonitor } from "./activity.js";
import { extractTextTitle } from "./extract-utils.js";
import type { ExtractedContent } from "./extract-types.js";

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30_000;

export async function extractWithJinaReader(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;
	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const res = await fetch(jinaUrl, {
			headers: {
				Accept: "text/markdown",
				"X-No-Cache": "true",
			},
			signal: AbortSignal.any([
				AbortSignal.timeout(JINA_TIMEOUT_MS),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const content = await res.text();
		activityMonitor.logComplete(activityId, res.status);

		const marker = "Markdown Content:";
		const contentStart = content.indexOf(marker);
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + marker.length).trim();

		// Check for failed JS rendering or minimal content
		if (
			markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")
		) {
			return null;
		}

		const title = extractTextTitle(markdownPart, url);
		return { url, title, content: markdownPart, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
