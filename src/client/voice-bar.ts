/**
 * The seekable voice bar above the composer: play/pause, ±10s, a draggable
 * scrubber with elapsed/total time, and close. Pure view — voice.ts owns the
 * audio and feeds it a snapshot; the bar reports intent through the handlers
 * voice.ts registers.
 */

import { el } from "./dom.js";
import { CANCEL_ICON, PAUSE_ICON, PLAY_ICON, SKIP_BACK_ICON, SKIP_FWD_ICON } from "./icons.js";
import { formatClock } from "./tts-timeline.js";

/** Seconds the skip buttons move. */
export const VOICE_SKIP_SECONDS = 10;

export interface VoiceBarSnapshot {
	/** Current position, utterance seconds. */
	position: number;
	/** Seconds synthesized so far. */
	total: number;
	/** True once the stream has closed, i.e. `total` is final. */
	complete: boolean;
	paused: boolean;
}

export interface VoiceBarHandlers {
	togglePause: () => void;
	seek: (seconds: number) => void;
	skip: (delta: number) => void;
	close: () => void;
}

let handlers: VoiceBarHandlers | null = null;
/** True while the user is dragging the thumb: the bar must not fight them. */
let dragging = false;

export function bindVoiceBar(h: VoiceBarHandlers): void {
	handlers = h;
}

function iconButton(cls: string, label: string, html: string): HTMLButtonElement {
	return el("button", {
		class: `voice-bar-btn ${cls}`,
		type: "button",
		title: label,
		html,
		"aria-label": label,
	});
}

export function createVoiceBar(): HTMLElement {
	const scrub = el("input", {
		class: "voice-bar-scrub",
		type: "range",
		min: "0",
		max: "0",
		step: "any",
		value: "0",
		"aria-label": "Seek voice playback",
	});
	scrub.addEventListener("pointerdown", () => {
		dragging = true;
	});
	// Fires on every move of the thumb: show where it would land, but only seek on
	// release (re-scheduling audio on every pixel would stutter).
	scrub.addEventListener("input", () => {
		dragging = true;
		paintScrub(Number(scrub.value));
	});
	scrub.addEventListener("change", () => {
		dragging = false;
		handlers?.seek(Number(scrub.value));
	});
	const endDrag = () => setTimeout(() => (dragging = false), 0);
	scrub.addEventListener("pointerup", endDrag);
	scrub.addEventListener("pointercancel", endDrag);

	const bar = el(
		"div",
		{ class: "voice-bar hidden", id: "voice-bar", role: "group", "aria-label": "Voice playback" },
		iconButton("voice-bar-play", "Pause playback", PAUSE_ICON),
		iconButton("voice-bar-back", `Back ${VOICE_SKIP_SECONDS} seconds`, SKIP_BACK_ICON),
		iconButton("voice-bar-fwd", `Forward ${VOICE_SKIP_SECONDS} seconds`, SKIP_FWD_ICON),
		el("span", { class: "voice-bar-time voice-bar-elapsed", text: "0:00" }),
		scrub,
		el("span", { class: "voice-bar-time voice-bar-total", text: "0:00" }),
		iconButton("voice-bar-close", "Stop playback", CANCEL_ICON),
	);
	bar.querySelector(".voice-bar-play")?.addEventListener("click", () => handlers?.togglePause());
	bar
		.querySelector(".voice-bar-back")
		?.addEventListener("click", () => handlers?.skip(-VOICE_SKIP_SECONDS));
	bar
		.querySelector(".voice-bar-fwd")
		?.addEventListener("click", () => handlers?.skip(VOICE_SKIP_SECONDS));
	bar.querySelector(".voice-bar-close")?.addEventListener("click", () => handlers?.close());
	return bar;
}

/** Fill the track up to `seconds` and show it as the elapsed time. */
function paintScrub(seconds: number): void {
	const scrub = document.querySelector<HTMLInputElement>("#voice-bar .voice-bar-scrub");
	const elapsed = document.querySelector("#voice-bar .voice-bar-elapsed");
	if (!scrub || !elapsed) return;
	const max = Number(scrub.max);
	scrub.style.setProperty("--p", `${max > 0 ? (seconds / max) * 100 : 0}%`);
	elapsed.textContent = formatClock(seconds);
}

/** Show the bar with `snapshot`, or hide it with null. */
export function updateVoiceBar(snapshot: VoiceBarSnapshot | null): void {
	const bar = document.getElementById("voice-bar");
	if (!bar) return;
	bar.classList.toggle("hidden", snapshot === null);
	if (!snapshot) {
		dragging = false;
		return;
	}
	const play = bar.querySelector<HTMLButtonElement>(".voice-bar-play");
	if (play) {
		const label = snapshot.paused ? "Resume playback" : "Pause playback";
		play.innerHTML = snapshot.paused ? PLAY_ICON : PAUSE_ICON;
		play.title = label;
		play.setAttribute("aria-label", label);
	}
	const scrub = bar.querySelector<HTMLInputElement>(".voice-bar-scrub");
	const total = bar.querySelector(".voice-bar-total");
	if (!scrub || !total) return;
	// A trailing "+" while synthesis is still running: the total is a lower bound.
	total.textContent = formatClock(snapshot.total) + (snapshot.complete ? "" : "+");
	scrub.max = String(snapshot.total);
	if (dragging) return;
	scrub.value = String(snapshot.position);
	paintScrub(snapshot.position);
}
