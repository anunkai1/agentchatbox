/**
 * Markdown rendering for assistant message text.
 *
 * The chat renders assistant output into a container element; this module
 * turns the raw markdown the model emits into sanitized DOM via a real
 * parser (marked) + sanitizer (DOMPurify). Previously this was a tiny
 * hand-rolled URL/link linkifier operating on raw text in a <pre>; that
 * left **bold**, ### headings, ``` fences, tables etc. visible as literal
 * sigils AND fed them to TTS as gibberish. Both the on-screen render and
 * the speech path now share marked as the single source of truth.
 *
 * Links keep their "rich-link" class + open in a new tab via a DOMPurify
 * hook, preserving the original linkify.ts link behaviour. Only http(s)
 * URLs survive sanitization (DOMPurify drops javascript:/data: etc.).
 *
 * Display-side only; the server is the transport layer.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

// Make every link open in a new tab without a referrer, matching the
// original hand-built <a> elements. DOMPurify already strips unsafe
// URL schemes (javascript:, data:, ...), so by the time we set target
// the href is known-safe.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A" && node.getAttribute("href")) {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
		node.classList.add("rich-link");
	}
	if (node.tagName === "IMG") {
		// Images in older transcript rows should not compete with the current
		// conversation for bandwidth or decode time. Browser-native lazy
		// loading still fetches images as they approach the viewport.
		node.setAttribute("loading", "lazy");
		node.setAttribute("decoding", "async");
	}
});

/**
 * Render `text` (markdown) into `container` as sanitized HTML, replacing
 * any existing children. Used for both persisted messages (render.ts)
 * and the live-streaming message (main.ts, re-called each message_update).
 * Never throws: on parse failure we fall back to the raw text so the user
 * always sees something.
 */
export function setRichText(container: HTMLElement, text: string): void {
	const src = text || " ";
	try {
		const html = marked.parse(src, { async: false }) as string;
		container.innerHTML = DOMPurify.sanitize(html);
	} catch {
		container.textContent = src;
	}
}

/**
 * Render a user-authored message. Older ACB versions stored pasted images
 * as ordinary `[image: name](url)` links; recognise that narrowly-defined
 * legacy form so existing transcript entries render as pictures too. Current
 * image attachments use structured transport references instead of adding
 * Markdown to the composer.
 */
export function setUserRichText(container: HTMLElement, text: string): void {
	setRichText(
		container,
		text.replace(
			/(^|[\s])\[image: ([^\]]+)\]\((\/uploads\/[A-Za-z0-9-]+\.[A-Za-z0-9]+)\)/g,
			"$1![$2]($3)",
		),
	);
}
