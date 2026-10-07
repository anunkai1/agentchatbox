/**
 * Inline SVG icons (Lucide-style, 24px grid) used instead of emoji so every
 * platform draws the same glyph in the surrounding text colour. Sized in em
 * unless a size is given, so the host element's font-size controls them.
 */

import { el } from "./dom.js";

function svg(body: string, filled = false, size = "1em"): string {
	const paint = filled
		? 'fill="currentColor" stroke="none"'
		: 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
	return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" ${paint} aria-hidden="true">${body}</svg>`;
}

/** Composer mic button: idle microphone and the red recording dot. */
export const MIC_ICON = svg(
	'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
	false,
	"20",
);
export const REC_ICON =
	'<svg class="icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="#ef4444"/></svg>';

/**
 * Composer primary actions: send (up arrow) and, while the agent is streaming,
 * steer (right arrow — the instruction is queued for the next turn).
 *
 * These are SVG rather than the "↑" / "⇢" / "■" text glyphs they replace.
 * Text ink is placed on the font baseline, not the line box's centre, so those
 * glyphs rendered visibly below the middle of the round buttons and by a
 * different amount per glyph (measured on Android/Roboto: ~2px for "■",
 * ~2px for "↑", ~3.5px for "⇢"). A 24/24 SVG in a flex-centred button is
 * geometrically centred on every platform. Sized to match MIC_ICON.
 */
export const SEND_ICON = svg('<path d="M12 19V5M5 12l7-7 7 7"/>', false, "20");
export const STEER_ICON = svg('<path d="M5 12h14M12 5l7 7-7 7"/>', false, "20");
export const COMPOSER_STOP_ICON = svg(
	'<rect x="6" y="6" width="12" height="12" rx="2"/>',
	true,
	"20",
);

/** Speak buttons: immediate speaker, plus the long / medium / short variants. */
export const SPEAK_ICON = svg(
	'<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
);
export const LONG_ICON = svg('<path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3"/>');
export const MEDIUM_ICON = svg(
	'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>',
);
export const SHORT_ICON = svg(
	'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
);

/** Transport controls (filled). */
export const STOP_ICON = svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', true);
export const PAUSE_ICON = svg(
	'<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
	true,
);
export const PLAY_ICON = svg(
	'<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/>',
	true,
);

/** Badges and chips. */
export const CLOCK_ICON = svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>');
export const ZAP_ICON = svg('<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>');
export const SHRINK_ICON = svg('<path d="m7 20 5-5 5 5M7 4l5 5 5-5"/>');

/** Conversation and project actions. */
const STAR_PATH =
	'<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>';
export const STAR_ICON = svg(STAR_PATH);
export const STAR_FILLED_ICON = svg(STAR_PATH, true);
export const PENCIL_ICON = svg('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>');
export const TRASH_ICON = svg(
	'<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
);
export const FOLDER_ICON = svg(
	'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
);
export const PACKAGE_ICON = svg(
	'<path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
);

/** An icon as a standalone element, for use among other children. */
export function iconEl(icon: string): HTMLSpanElement {
	return el("span", { class: "icon-wrap", html: icon, "aria-hidden": "true" });
}
