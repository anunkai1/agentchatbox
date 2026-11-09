import { el, type MountedModal } from "./dom.js";

export interface RelayDrawer extends MountedModal {
	reveal(): void;
	setStatus(status: string, microphone: string): void;
	setPause(paused: boolean, disabled: boolean): void;
}

/** Non-modal controls: collapsing never stops capture; End voice always does. */
export function mountRelayDrawer(
	box: HTMLElement,
	onEnd: () => void,
	onPause?: () => void,
): RelayDrawer {
	box.id = "relay-voice-panel";
	box.setAttribute("role", "dialog");
	box.setAttribute("aria-modal", "false");
	box.setAttribute("aria-label", "Relay");
	const toggle = el(
		"button",
		{
			type: "button",
			class: "relay-voice-toggle",
			"aria-controls": box.id,
			"aria-expanded": "false",
		},
		"Voice controls",
	);
	const pause = el(
		"button",
		{
			type: "button",
			hidden: !onPause,
			disabled: true,
			"aria-pressed": "false",
			title: "Mute microphone and pause voice playback; Pi work continues.",
		},
		"Pause voice",
	);
	const end = el(
		"button",
		{ type: "button", title: "Stop the microphone and voice; Pi work continues." },
		"End voice",
	);
	const strip = el("div", { class: "relay-voice-strip", hidden: true }, toggle, pause, end);
	const minimise = el(
		"button",
		{ type: "button", class: "relay-voice-minimise", "aria-label": "Minimise voice controls" },
		"Minimise ↓",
	);
	const closeButton = el(
		"button",
		{
			type: "button",
			class: "modal-close-btn",
			"aria-label": "Close Relay",
			title: "End voice — stop microphone; Pi work continues",
		},
		"✕",
	);
	box.append(closeButton);
	box.insertBefore(minimise, box.firstChild);
	const root = el("div", { id: "relay-voice-ui", class: "relay-voice-dock" }, strip, box);
	let ended = false;
	let frame: number | null = null;
	let composer: Element | null = null;
	const resize = new ResizeObserver(() => scheduleMeasure());
	function measure(): void {
		frame = null;
		const next = document.querySelector(".composer-wrap");
		if (next !== composer) {
			if (composer) resize.unobserve(composer);
			composer = next;
			if (composer) resize.observe(composer);
		}
		const messages = document.getElementById("messages");
		const pinned =
			messages && messages.scrollHeight - messages.clientHeight - messages.scrollTop < 80;
		root.style.setProperty(
			"--relay-composer-offset",
			`${Math.max(12, window.innerHeight - (composer?.getBoundingClientRect().top ?? window.innerHeight) + 8)}px`,
		);
		document.documentElement.style.setProperty(
			"--relay-drawer-height",
			`${box.hidden ? strip.offsetHeight : box.offsetHeight}px`,
		);
		if (pinned && messages) messages.scrollTop = messages.scrollHeight;
	}
	function scheduleMeasure(): void {
		if (!ended && frame === null) frame = requestAnimationFrame(measure);
	}
	function setExpanded(expanded: boolean): void {
		box.hidden = !expanded;
		strip.hidden = expanded;
		toggle.setAttribute("aria-expanded", String(expanded));
		root.dataset.collapsed = String(!expanded);
		document.body.classList.toggle("relay-voice-expanded", expanded);
		document.getElementById("header-relay")?.setAttribute("aria-expanded", String(expanded));
		scheduleMeasure();
	}
	const observer = new MutationObserver(scheduleMeasure);
	const close = () => {
		if (ended) return;
		ended = true;
		if (frame !== null) cancelAnimationFrame(frame);
		resize.disconnect();
		observer.disconnect();
		window.removeEventListener("resize", scheduleMeasure);
		window.visualViewport?.removeEventListener("resize", scheduleMeasure);
		document.body.classList.remove("relay-voice-expanded");
		document.documentElement.style.removeProperty("--relay-drawer-height");
		document.getElementById("header-relay")?.setAttribute("aria-expanded", "false");
		const focusWasInside = root.contains(document.activeElement);
		root.remove();
		if (focusWasInside)
			document.querySelector<HTMLTextAreaElement>("#input")?.focus({ preventScroll: true });
	};
	const dismiss = () => {
		if (ended) return;
		onEnd();
		close();
	};
	const collapse = () => {
		setExpanded(false);
		toggle.focus();
	};
	const reveal = () => {
		setExpanded(true);
		minimise.focus();
	};
	toggle.onclick = reveal;
	minimise.onclick = collapse;
	pause.onclick = () => onPause?.();
	end.onclick = dismiss;
	closeButton.onclick = dismiss;
	box.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			collapse();
		}
	});
	document.body.append(root);
	resize.observe(box);
	resize.observe(strip);
	observer.observe(document.body, { childList: true });
	window.addEventListener("resize", scheduleMeasure);
	window.visualViewport?.addEventListener("resize", scheduleMeasure);
	setExpanded(true);
	return {
		close,
		dismiss,
		reveal,
		setStatus(status, microphone) {
			toggle.textContent = `${microphone} · ${status}`;
			toggle.setAttribute("aria-label", `Show voice controls. ${microphone}. ${status}`);
		},
		setPause(paused, disabled) {
			pause.disabled = disabled;
			pause.textContent = paused ? "Resume voice" : "Pause voice";
			pause.setAttribute("aria-pressed", String(paused));
		},
	};
}
