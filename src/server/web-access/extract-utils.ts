/**
 * Small helpers shared by the extract*.ts modules. Pulled out of
 * `extract.ts` so each fallback-chain module can import what it needs
 * without pulling in the dispatcher's side effects.
 */

import type { ExtractedContent } from "./extract-types.js";

/** Stringify an unknown error value. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * True if the error is a "couldn't parse the user's config file" type
 * — these are surfaced to the caller verbatim (the user has a config
 * problem they need to fix), whereas other errors are treated as
 * "try the next fallback".
 */
export function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

/** True if the error is an AbortError (signal triggered). */
export function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

/** Build the minimal "we got aborted" result. */
export function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

/**
 * Extract a `# Heading` or `## Heading` from the top of a markdown
 * string. Used as a fallback when the article parser doesn't find a
 * title. Returns null if no heading is present.
 */
export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

/**
 * Title for a plain-text resource: heading if present, else the
 * last path segment of the URL, else the URL itself.
 */
export function extractTextTitle(text: string, url: string): string {
	const heading = extractHeadingTitle(text);
	if (heading) return heading;
	try {
		const last = new URL(url).pathname.split("/").pop();
		return last && last.length > 0 ? last : url;
	} catch {
		return url;
	}
}

/**
 * Errors from the HTTP fallback that should NOT be retried with the
 * next provider — the URL really isn't going to be readable as HTML.
 * (PDF/binary responses are already handled by their own branches;
 * these are the additional cases where the response was HTML but
 * just has no usable content.)
 */
export const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];

/** Below this length, extracted markdown is "incomplete" and we surface a soft error. */
export const MIN_USEFUL_CONTENT = 500;
