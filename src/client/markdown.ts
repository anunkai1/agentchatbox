/**
 * Markdown → plain spoken text.
 *
 * Why this exists: the 🔊 speak button and auto-speak feed *raw assistant
 * markdown* to the local TTS engine. The engine has no concept of markdown,
 * so it reads the literal sigils — "asterisk asterisk bold asterisk
 * asterisk", "hash hash heading", pipes from tables, fenced ``` blocks,
 * the `[label](url)` URL in full, etc. The result sounds like gibberish.
 *
 * Fix: render the markdown to HTML with a real parser (marked), sanitize
 * it, mount it in a throwaway DOM node, and extract readable prose by
 * walking that DOM — replacing code blocks with a short spoken cue and
 * images with their alt text. This is a real parse, not a regex soup:
 * `**bold**` → `<strong>bold</strong>` → "bold", links keep only their
 * label, headings/lists/tables lose their markers. Nothing here touches
 * the on-screen message rendering (which intentionally stays raw text);
 * this module is only on the speech path.
 *
 * Lives client-side on purpose: the server is the transport layer only.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Text nodes whose entire content is a bare URL. We drop these rather
 * than read "h t t p s colon slash slash ..." aloud. Markdown links
 * `[label](url)` already collapse to just their label via marked (the
 * URL never reaches a text node), so this only catches bare URLs.
 */
const BARE_URL_RE = /^\s*https?:\/\/\S+\s*$/;

/** Block-level tags that should end a spoken line (add a newline after). */
const BLOCK_TAGS = new Set([
	"p",
	"div",
	"li",
	"ul",
	"ol",
	"blockquote",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"tr",
	"table",
	"section",
	"article",
	"header",
	"footer",
]);

/**
 * Convert assistant markdown into clean text suitable for TTS.
 *
 *   - code blocks (` ``` ` fenced) → the literal cue "[code block]"
 *     (reading code aloud is almost never wanted)
 *   - inline `code` → kept as bare text (short identifiers read fine)
 *   - images → their alt text, if any
 *   - everything else → the rendered textContent (sigils/markers gone)
 *   - bare-URL-only text nodes → dropped
 *   - collapses 3+ newlines down to 2 so the engine doesn't make long pauses
 *
 * Never throws: if the parser chokes on something, we fall back to the
 * raw text rather than silence the speak button.
 */
export function markdownToSpeechText(text: string): string {
	const src = text?.trim();
	if (!src) return "";
	try {
		const html = DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
		const container = document.createElement("div");
		container.innerHTML = html;
		const out = collectSpeech(container)
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		return out;
	} catch {
		return src;
	}
}

/** Recursively collect readable text from a DOM subtree. */
function collectSpeech(root: Node): string {
	let out = "";
	root.childNodes.forEach((child) => {
		out += nodeToSpeech(child);
	});
	return out;
}

function nodeToSpeech(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		const t = node.textContent ?? "";
		// Skip bare-URL-only text nodes entirely.
		return BARE_URL_RE.test(t) ? "" : t;
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return "";
	const el = node as Element;
	const tag = el.tagName.toLowerCase();

	// Fenced code blocks: don't read the source aloud.
	if (tag === "pre") {
		const lines = el.textContent?.trim().split("\n").length ?? 0;
		return lines > 8 ? "\n[code block]\n" : `\n${el.textContent ?? ""}\n`;
	}

	// Images: use alt text (textContent ignores <img>).
	if (tag === "img") {
		const alt = el.getAttribute("alt")?.trim();
		return alt ? ` ${alt} ` : "";
	}

	if (tag === "br") return "\n";

	// Recurse into everything else, and emit a newline after block
	// elements so list items / paragraphs / table rows are separated.
	let inner = "";
	el.childNodes.forEach((child) => {
		inner += nodeToSpeech(child);
	});
	if (BLOCK_TAGS.has(tag)) inner += "\n";
	return inner;
}
