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
if (typeof DOMPurify.addHook === "function") {
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
}

const UPLOAD_VIDEO_URL_RE = /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]{0,255}\.(?:mp4|webm|mov))$/i;
const BARE_UPLOAD_VIDEO_RE =
	/(^|[\s(])(\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.(?:mp4|webm|mov))(?=$|[\s),.!?:;])/gi;
const VIDEO_SKIP_ANCESTORS = new Set(["A", "CODE", "PRE", "SCRIPT", "STYLE", "VIDEO"]);

/** Return the normalized `/uploads/...` path when `rawUrl` points to a supported uploaded video. */
export function matchUploadVideoUrl(rawUrl: string | null | undefined): string | null {
	if (!rawUrl) return null;
	const trimmed = rawUrl.trim();
	return UPLOAD_VIDEO_URL_RE.test(trimmed) ? trimmed : null;
}

function createInlineVideo(src: string, label?: string | null): HTMLVideoElement {
	const video = document.createElement("video");
	video.setAttribute("controls", "");
	video.setAttribute("playsinline", "");
	video.setAttribute("preload", "metadata");
	video.setAttribute("src", src);
	const trimmed = label?.trim();
	if (trimmed) video.setAttribute("aria-label", trimmed);
	return video;
}

function shouldSkipVideoTextNode(node: Text, root: HTMLElement): boolean {
	let current = node.parentElement;
	while (current && current !== root) {
		if (VIDEO_SKIP_ANCESTORS.has(current.tagName)) return true;
		current = current.parentElement;
	}
	return false;
}

function upgradeUploadVideos(container: HTMLElement): void {
	if (typeof document === "undefined") return;
	for (const anchor of Array.from(container.querySelectorAll("a[href]"))) {
		const src = matchUploadVideoUrl(anchor.getAttribute("href"));
		if (src) anchor.replaceWith(createInlineVideo(src, anchor.textContent));
	}
	for (const img of Array.from(container.querySelectorAll("img[src]"))) {
		const src = matchUploadVideoUrl(img.getAttribute("src"));
		if (src) img.replaceWith(createInlineVideo(src, img.getAttribute("alt")));
	}
	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	let current = walker.nextNode();
	while (current) {
		if (
			current.nodeType === Node.TEXT_NODE &&
			!shouldSkipVideoTextNode(current as Text, container)
		) {
			textNodes.push(current as Text);
		}
		current = walker.nextNode();
	}
	for (const textNode of textNodes) {
		const value = textNode.nodeValue ?? "";
		BARE_UPLOAD_VIDEO_RE.lastIndex = 0;
		let match = BARE_UPLOAD_VIDEO_RE.exec(value);
		if (!match) continue;
		const frag = document.createDocumentFragment();
		let cursor = 0;
		while (match) {
			const lead = match[1];
			const url = match[2];
			const urlStart = match.index + lead.length;
			if (urlStart > cursor) {
				frag.append(document.createTextNode(value.slice(cursor, urlStart)));
			}
			frag.append(createInlineVideo(url));
			cursor = urlStart + url.length;
			match = BARE_UPLOAD_VIDEO_RE.exec(value);
		}
		if (cursor < value.length) {
			frag.append(document.createTextNode(value.slice(cursor)));
		}
		textNode.replaceWith(frag);
	}
}

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
		upgradeUploadVideos(container);
	} catch {
		container.textContent = src;
	}
}

/**
 * Render a user-authored message. Older ACB versions stored pasted images
 * as ordinary `[image: name](url)` links; recognise that narrowly-defined
 * legacy form so existing transcript entries render as pictures too. Replayed
 * attachments carry `(upload:<file>)`, which the server stores instead of
 * the /uploads/ URL (see rewriteUploadUrls); map it back to that URL.
 */
export function setUserRichText(container: HTMLElement, text: string): void {
	setRichText(
		container,
		text
			.replace(/(\[image: [^\]]+\])\(upload:([A-Za-z0-9-]+\.[A-Za-z0-9]+)\)/g, "$1(/uploads/$2)")
			.replace(
				/(^|[\s])\[image: ([^\]]+)\]\((\/uploads\/[A-Za-z0-9-]+\.[A-Za-z0-9]+)\)/g,
				"$1![$2]($3)",
			),
	);
}
