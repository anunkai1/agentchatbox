/**
 * Shared helpers for working with pi message content.
 *
 * Used on both the server (reading session JSONL) and the client
 * (projecting transcripts), so it lives in `shared/` and is typechecked
 * by both tsconfigs. Previously `extractText` was copy-pasted in three
 * places (session-list.ts, search/indexer.ts, client/project.ts) and
 * `truncate` in two — they had drifted in style but not (yet) in
 * behavior; this is the single source of truth.
 */

/**
 * Pull the plain text out of a SDK message `content` field — either a
 * bare string or an array of content blocks, of which we join the
 * `type: "text"` blocks. Non-text blocks (thinking, toolCall, image,
 * …) are ignored. Returns "" for anything unrecognized.
 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
				parts.push(String((block as { text?: string }).text ?? ""));
			}
		}
		return parts.join("");
	}
	return "";
}

/** Truncate `s` to `n` chars, appending a single ellipsis if cut. */
export function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}
