/**
 * Lightweight markdown-ish linkifier for assistant message text.
 *
 * The chat renders assistant output as preformatted text (white-space:
 * pre-wrap), but URLs and markdown `[label](url)` links should be
 * clickable. This module turns a string into DOM nodes: text segments
 * stay as Text nodes (so whitespace/newlines are preserved by the
 * container's `white-space: pre-wrap`), and links become `<a>` tags.
 *
 * Only http(s) links are linkified — anything else (`javascript:`,
 * `data:`, mailto, …) is left as plain text to avoid XSS / navigation
 * surprises. Links open in a new tab with `rel="noopener"`.
 *
 * This is intentionally tiny: it handles the two forms an LLM actually
 * emits (markdown links and bare URLs). Full markdown rendering lives
 * elsewhere if/when we adopt a real parser; for now this is enough to
 * make "here's the file" → click work.
 */

const URL_RE = /\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)<]+)/g;

/** True iff `url` is an http(s) URL we're willing to turn into a link. */
function isSafeUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/** Build an `<a>` for a link with the given visible label and href. */
function makeAnchor(href: string, label: string): HTMLAnchorElement {
	const a = document.createElement("a");
	a.href = href;
	a.textContent = label;
	a.target = "_blank";
	a.rel = "noopener noreferrer";
	a.className = "rich-link";
	return a;
}

/**
 * Fill `container` with linkified content for `text`. Clears existing
 * children first. Preserves all whitespace via Text nodes; the caller's
 * container should have `white-space: pre-wrap` so newlines render.
 */
export function setRichText(container: HTMLElement, text: string): void {
	container.replaceChildren(...richTextNodes(text));
}

/** Return the DOM nodes (Text + <a>) for a chunk of assistant text. */
export function richTextNodes(text: string): Node[] {
	if (!text) return [];
	const nodes: Node[] = [];
	let last = 0;
	for (const m of text.matchAll(URL_RE)) {
		const start = m.index ?? 0;
		// Text before the match (may be empty).
		if (start > last) nodes.push(document.createTextNode(text.slice(last, start)));

		if (m[1] !== undefined && m[2] !== undefined) {
			// Markdown form: [label](url)
			const label = m[1];
			const url = m[2];
			if (isSafeUrl(url)) {
				nodes.push(makeAnchor(url, label));
			} else {
				// Unsafe scheme — render the raw text, no anchor.
				nodes.push(document.createTextNode(m[0]));
			}
		} else if (m[3] !== undefined) {
			// Bare URL.
			nodes.push(makeAnchor(m[3], m[3]));
		}
		last = start + m[0].length;
	}
	if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
	return nodes;
}
