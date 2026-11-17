/**
 * DOM helpers and the uuid fallback. No framework, no dependencies on
 * the rest of the app. Imported by every other client module.
 */

/**
 * UUID helper — `crypto.randomUUID()` is unavailable in non-secure contexts
 * on some Android WebViews (e.g. plain http://LAN IPs). Fall back to a
 * tiny RFC4122 v4 generator so the page still loads.
 */
export function uuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	const b = new Uint8Array(16);
	const get =
		typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
			? crypto.getRandomValues.bind(crypto)
			: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256));
	get(b);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
	return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

export function $<T extends HTMLElement>(sel: string): T {
	const el = document.querySelector(sel) as T | null;
	if (!el) throw new Error(`element not found: ${sel}`);
	return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Record<string, unknown> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") node.className = v as string;
		else if (k === "html") (node as HTMLElement).innerHTML = v as string;
		else if (k === "text") (node as HTMLElement).textContent = v as string;
		else if (k === "on") {
			for (const [event, handler] of Object.entries(v as Record<string, EventListener>)) {
				node.addEventListener(event, handler);
			}
		} else if (k.startsWith("aria-") || k.startsWith("data-")) {
			// Hyphenated ARIA/data names are attributes, not JavaScript
			// properties. Assigning node["aria-label"] only creates an inert
			// expando and leaves assistive technology with no accessible name.
			if (v == null) node.removeAttribute(k);
			else node.setAttribute(k, String(v));
		} else (node as unknown as Record<string, unknown>)[k] = v;
	}
	for (const c of children) node.append(c);
	return node;
}

export function text(s: string): Text {
	return document.createTextNode(s);
}

export interface ModalOptions {
	/** Fallback accessible name when the dialog has no heading. */
	label?: string;
	/** Called only for dismissals (Escape, backdrop, or the close button). */
	onDismiss?: () => void;
	/** Preferred initial focus. Falls back to the first useful control. */
	initialFocus?: HTMLElement | (() => HTMLElement | null);
	/** Add the standard top-right close button. Defaults to true. */
	showCloseButton?: boolean;
}

export interface MountedModal {
	/** Remove without invoking onDismiss (use after a successful action). */
	close(): void;
	/** Dismiss and invoke onDismiss exactly once. */
	dismiss(): void;
}

const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	'input:not([disabled]):not([type="hidden"])',
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
].join(",");

const mountedModals: { overlay: HTMLElement; box: HTMLElement; cleanup(): void }[] = [];
const modalBackground = new Map<HTMLElement, { inert: string | null; ariaHidden: string | null }>();

/** Only the top modal stays interactive; retain pre-existing background state. */
function syncModalBackground(): void {
	const top = [...mountedModals].reverse().find(({ overlay }) => overlay.isConnected);
	const background = new Set(
		top
			? [...document.body.children].filter(
					(node): node is HTMLElement => node instanceof HTMLElement && node !== top.overlay,
				)
			: [],
	);
	for (const [node, previous] of modalBackground) {
		if (background.has(node)) continue;
		if (previous.inert === null) node.removeAttribute("inert");
		else node.setAttribute("inert", previous.inert);
		if (previous.ariaHidden === null) node.removeAttribute("aria-hidden");
		else node.setAttribute("aria-hidden", previous.ariaHidden);
		modalBackground.delete(node);
	}
	for (const node of background) {
		if (!modalBackground.has(node)) {
			modalBackground.set(node, {
				inert: node.getAttribute("inert"),
				ariaHidden: node.getAttribute("aria-hidden"),
			});
		}
		node.setAttribute("inert", "");
		// Older WebViews may ignore inert: the overlay blocks pointer input,
		// focusin below contains focus, and aria-hidden hides background content.
		if (!("inert" in HTMLElement.prototype)) node.setAttribute("aria-hidden", "true");
	}
}

/**
 * Mount an accessible modal while keeping ACB's callers lightweight.
 * Provides dialog semantics, a close affordance, Escape/backdrop dismissal,
 * a Tab focus trap, and focus restoration even when a caller removes the
 * overlay directly after a successful action.
 */
export function mountModal(
	overlay: HTMLDivElement,
	box: HTMLElement,
	options: ModalOptions = {},
): MountedModal {
	// Callers may replace a dialog in the same task, before MutationObserver
	// notices its removal. Restore its opener before capturing the new one.
	for (const modal of [...mountedModals]) {
		if (!modal.overlay.isConnected) modal.cleanup();
	}
	const previousFocus =
		document.activeElement instanceof HTMLElement ? document.activeElement : null;
	let dismissed = false;
	let cleanedUp = false;
	let observer: MutationObserver | null = null;

	overlay.classList.add("modal-overlay");
	box.classList.add("modal-dialog");
	box.setAttribute("role", "dialog");
	box.setAttribute("aria-modal", "true");
	box.tabIndex = -1;

	const heading = box.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
	if (heading) {
		if (!heading.id) heading.id = `dialog-title-${uuid()}`;
		box.setAttribute("aria-labelledby", heading.id);
	} else {
		box.setAttribute("aria-label", options.label || "Dialog");
	}

	const close = () => overlay.remove();
	const dismiss = () => {
		if (dismissed || !overlay.isConnected) return;
		dismissed = true;
		options.onDismiss?.();
		close();
	};

	if (options.showCloseButton !== false) {
		const closeButton = el(
			"button",
			{
				class: "modal-close-btn",
				type: "button",
				title: "Close",
				"aria-label": `Close ${options.label || heading?.textContent?.trim() || "dialog"}`,
			},
			"✕",
		);
		closeButton.addEventListener("click", dismiss);
		box.append(closeButton);
	}

	const focusable = (): HTMLElement[] =>
		[...box.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
			(control) =>
				!control.hidden &&
				control.getAttribute("aria-hidden") !== "true" &&
				control.getClientRects().length > 0,
		);

	const isTopmost = () => {
		const modals = document.querySelectorAll<HTMLElement>(".modal-overlay");
		return modals.length > 0 && modals.item(modals.length - 1) === overlay;
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (!isTopmost()) return;
		if (event.key === "Escape") {
			event.preventDefault();
			dismiss();
			return;
		}
		if (event.key !== "Tab") return;
		const controls = focusable();
		if (controls.length === 0) {
			event.preventDefault();
			box.focus();
			return;
		}
		const first = controls[0];
		const last = controls[controls.length - 1];
		if (
			event.shiftKey &&
			(document.activeElement === first || !box.contains(document.activeElement))
		) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const onFocusIn = (event: FocusEvent) => {
		if (isTopmost() && !box.contains(event.target as Node)) {
			(focusable()[0] ?? box).focus();
		}
	};
	const modal = { overlay, box, cleanup: () => cleanup() };
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		const wasTopmost = mountedModals[mountedModals.length - 1] === modal;
		mountedModals.splice(mountedModals.indexOf(modal), 1);
		document.removeEventListener("keydown", onKeyDown);
		document.removeEventListener("focusin", onFocusIn);
		observer?.disconnect();
		syncModalBackground();
		if (!document.querySelector(".modal-overlay")) document.body.classList.remove("modal-open");
		if (wasTopmost && previousFocus?.isConnected && !previousFocus.closest("[inert]")) {
			previousFocus.focus();
		}
	};

	document.addEventListener("keydown", onKeyDown);
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) dismiss();
	});
	if (!box.parentElement) overlay.append(box);
	document.body.append(overlay);
	document.body.classList.add("modal-open");
	mountedModals.push(modal);
	document.addEventListener("focusin", onFocusIn);
	syncModalBackground();

	observer = new MutationObserver(() => {
		if (!overlay.isConnected) cleanup();
		else syncModalBackground();
	});
	observer.observe(document.body, { childList: true, subtree: true });

	setTimeout(() => {
		if (!overlay.isConnected || !isTopmost()) return;
		const requested =
			typeof options.initialFocus === "function" ? options.initialFocus() : options.initialFocus;
		const firstUseful = focusable().find(
			(control) => !control.classList.contains("modal-close-btn"),
		);
		(requested?.isConnected ? requested : (firstUseful ?? focusable()[0] ?? box)).focus();
	}, 0);

	return { close, dismiss };
}

/**
 * Escape a string for safe interpolation into innerHTML (or an HTML
 * attribute). Shared so the status bar and the HTML exporter use one
 * definition instead of two inline copies that could drift.
 */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
/**
 * Return handles into a live assistant message's DOM nodes so callers
 * (the event dispatcher) can stream updates in place without re-rendering.
 * `voiceTextBox` is the read-along box for medium/short variants; it starts
 * hidden and is populated by updateVoiceTextBox() when a voice-reply lands.
 */
export interface LiveAssistantDom {
	textPre: HTMLElement;
	thinkingWrap: HTMLDivElement;
	thinkingPre: HTMLPreElement;
	voiceTextBox: HTMLDivElement;
}
