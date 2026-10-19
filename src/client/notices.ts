/** Persistent, session-scoped notices beside the composer. Never replay work automatically. */
import { el } from "./dom.js";

export interface NoticeOptions {
	key?: string;
	resolved?: () => boolean;
	action?: { label: string; run: () => void };
}

interface Notice extends NoticeOptions {
	message: string;
	type: "warning" | "error";
	count: number;
	card?: HTMLElement;
}

const notices = new Map<string, Notice>();
let container: HTMLElement | null = null;
let session: string | null | undefined;

/** Notices belong to the bound session: switching to another one drops them,
 *  even when no shell rebuild follows (an empty new chat has no transcript). */
export function setNoticeSession(sessionId: string | null): void {
	if (session === sessionId) return;
	session = sessionId;
	for (const key of [...notices.keys()]) clearNotice(key);
}

export function mountNotices(target: HTMLElement): void {
	container = target;
	container.replaceChildren();
	refreshNotices();
	for (const [key, notice] of notices) paintNotice(key, notice);
	container.hidden = notices.size === 0;
}

export function clearNotice(key: string): void {
	const notice = notices.get(key);
	if (!notice) return;
	notice.card?.remove();
	notices.delete(key);
	if (container) container.hidden = notices.size === 0;
}

/** Called after relevant state changes; does not repaint unaffected cards or steal focus. */
export function refreshNotices(): void {
	for (const [key, notice] of notices) {
		if (notice.resolved?.()) clearNotice(key);
	}
}

export function showNotice(
	message: string,
	type: "warning" | "error" = "error",
	options: NoticeOptions = {},
): void {
	const key = options.key ?? message;
	const previous = notices.get(key);
	const notice: Notice = {
		...options,
		message,
		type: previous?.type === "error" ? "error" : type,
		count: !options.key && previous?.message === message ? previous.count + 1 : 1,
		card: previous?.card,
	};
	notices.set(key, notice);
	paintNotice(key, notice);
}

function paintNotice(key: string, notice: Notice): void {
	if (!container) return;
	const title = notice.type === "error" ? "Error" : "Warning";
	const card = el("section", {
		class: `composer-notice composer-notice-${notice.type}`,
		role: notice.type === "error" ? "alert" : "status",
		"aria-atomic": "true",
	});
	const heading = el("strong", { class: "composer-notice-heading" });
	heading.append(
		el("span", { "aria-hidden": "true" }, notice.type === "error" ? "✕ " : "⚠ "),
		`${title}${notice.count > 1 ? ` · ${notice.count} occurrences` : ""}`,
	);
	const actions = el("div", { class: "composer-notice-actions" });
	if (notice.action) {
		const action = notice.action;
		actions.append(el("button", { type: "button", onclick: () => action.run() }, action.label));
	}
	actions.append(
		el(
			"button",
			{
				type: "button",
				"aria-label": `Dismiss ${notice.type}`,
				onclick: () => clearNotice(key),
			},
			"Dismiss",
		),
	);
	card.append(heading, el("p", { class: "composer-notice-message" }, notice.message), actions);
	if (notice.card?.parentElement === container) notice.card.replaceWith(card);
	else {
		// Keep errors above warnings, newest first within each severity.
		const first =
			notice.type === "error"
				? container.firstChild
				: container.querySelector(".composer-notice-warning");
		container.insertBefore(card, first);
		container.scrollTop = 0;
	}
	notice.card = card;
	container.hidden = false;
}
