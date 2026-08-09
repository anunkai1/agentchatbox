/**
 * Extension UI relay — renders `extension_ui_request` dialogs from pi
 * extensions and sends the user's choice back via `extension_ui_response`.
 *
 * This is the generic channel that lets any pi extension ask the user a
 * question (select / confirm / input) through the ACB browser UI, without
 * ACB knowing anything about what the extension does. It's the designed
 * replacement for ad-hoc back-channels (like the old image-model
 * file-bridge): the extension owns the model list + persistence, ACB is
 * just the renderer.
 *
 * Protocol (see pi docs/rpc.md § Extension UI Protocol):
 *
 *   pi → ACB (as a forwarded event):
 *     { type: "extension_ui_request", id, method, title, options?, message?, placeholder?, timeout? }
 *
 *   ACB → pi (via the /api/chat WS → chat.ts extensionUiResponse handler):
 *     { type: "extension_ui_response", id, value?, confirmed?, cancelled? }
 *
 * Dialog methods (select/confirm/input) block on the pi side until the
 * matching response arrives. Fire-and-forget methods (notify/setStatus/…)
 * are handled elsewhere (main.ts handles `notify`; others are ignored).
 * Timeouts are tracked pi-side (it auto-resolves with a default), so the
 * client doesn't need its own timer.
 */

import { el } from "./dom.js";

/** Subset of the extension_ui_request event the relay renders. */
interface ExtensionUiRequest {
	id: string;
	method: string;
	title?: string;
	options?: string[];
	message?: string;
	placeholder?: string;
}

/** Sends the user's response back to pi. */
export type ExtensionUiResponder = (id: string, response: Record<string, unknown>) => void;

/**
 * Handle one extension_ui_request event. Renders the appropriate dialog
 * for select/confirm/input; silently ignores anything else (the caller
 * handles `notify` separately).
 */
export function handleExtensionUiRequest(
	e: ExtensionUiRequest,
	respond: ExtensionUiResponder,
): void {
	switch (e.method) {
		case "select":
			renderSelect(e, respond);
			break;
		case "confirm":
			renderConfirm(e, respond);
			break;
		case "input":
			renderInput(e, respond);
			break;
		default:
			// Unsupported dialog method (e.g. editor/custom) — pi-side
			// timeout will eventually resolve with a default. Nothing
			// useful we can render.
			break;
	}
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function createOverlay(title: string): { overlay: HTMLDivElement; box: HTMLDivElement } {
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box ext-ui-box" });
	box.append(el("h3", { text: title }));
	overlay.append(box);
	document.body.append(overlay);
	return { overlay, box };
}

/** Clicking outside the box cancels. */
function onCancel(overlay: HTMLDivElement, id: string, respond: ExtensionUiResponder): void {
	overlay.addEventListener("click", (ev) => {
		if (ev.target === overlay) {
			overlay.remove();
			respond(id, { cancelled: true });
		}
	});
}

/**
 * Separator rows look like "── Venice (API, paid) ──". We detect the
 * leading pair of em-dashes (U+2014) and render such rows as a full-width
 * non-interactive section header instead of a clickable model row.
 */
const SEPARATOR_RE = /^\s*──/;
const isSeparatorRow = (s: string): boolean => SEPARATOR_RE.test(s);

/**
 * Provider tint heuristics — purely presentational. The extension tags
 * each option with a trailing " — <provider>" segment; we tint the badge
 * by the provider keyword so the user can scan provider groups at a
 * glance. This is the only place ACB reads provider names, and it only
 * affects paint — the original option string is what gets sent back.
 */
const PROVIDER_TINTS: { match: RegExp; cls: string }[] = [
	{ match: /local|\bfree\b/i, cls: "ext-ui-provider--local" },
	{ match: /venice/i, cls: "ext-ui-provider--venice" },
	{ match: /openrouter/i, cls: "ext-ui-provider--openrouter" },
	{ match: /openai|codex/i, cls: "ext-ui-provider--openai" },
];
function providerClass(tag: string): string {
	for (const t of PROVIDER_TINTS) if (t.match.test(tag)) return t.cls;
	return "ext-ui-provider--default";
}

/**
 * Build one option row. Model rows split "Name (id) — provider tag" on the
 * last em-dash segment so the provider renders as a right-aligned tinted
 * badge; separator rows render as a divider header. The row carries its
 * index into `filtered` via `data-idx` so keyboard nav can toggle `.active`.
 */
function buildOptionRow(opt: string, idx: number, active: boolean): HTMLElement {
	if (isSeparatorRow(opt)) {
		const label = opt.replace(/^\s*──\s*/, "").replace(/\s*──\s*$/, "");
		return el("div", { class: "ext-ui-separator" }, el("span", { text: label }));
	}
	const dashIdx = opt.lastIndexOf(" \u2014 "); // " — " (em-dash)
	let label = opt;
	let tag = "";
	if (dashIdx >= 0) {
		label = opt.slice(0, dashIdx);
		tag = opt.slice(dashIdx + 3); // skip " — "
	}
	const row = el("div", { class: `model-row${active ? " active" : ""}` });
	row.dataset.idx = String(idx);
	row.append(el("span", { class: "ext-ui-row-label", text: label }));
	if (tag) row.append(el("span", { class: `ext-ui-provider ${providerClass(tag)}`, text: tag }));
	return row;
}

/**
 * Select dialog — a searchable list of plain-string options. The option
 * text IS the value sent back (pi's `ctx.ui.select` is string-based).
 */
function renderSelect(e: ExtensionUiRequest, respond: ExtensionUiResponder): void {
	const options = Array.isArray(e.options) ? e.options : [];
	if (options.length === 0) {
		respond(e.id, { cancelled: true });
		return;
	}

	const { overlay, box } = createOverlay(e.title ?? "Select");

	// Search filter — helpful for 17+ item lists.
	const search = el("input", {
		type: "text",
		class: "ext-ui-search",
		placeholder: "Filter…",
		autocomplete: "off",
	}) as HTMLInputElement;
	box.append(search);

	const list = el("div", { class: "ext-ui-list" });
	box.append(list);

	let filtered = options;
	// Start on the first selectable (non-separator) row.
	let selectedIdx = Math.max(
		0,
		filtered.findIndex((o) => !isSeparatorRow(o)),
	);

	function renderList(): void {
		list.innerHTML = "";
		filtered.forEach((opt, i) => {
			const row = buildOptionRow(opt, i, i === selectedIdx);
			if (!isSeparatorRow(opt)) {
				row.addEventListener("click", () => {
					overlay.remove();
					respond(e.id, { value: opt });
				});
				row.addEventListener("mouseenter", () => {
					selectedIdx = i;
					renderActive();
				});
			}
			list.append(row);
		});
	}

	function renderActive(): void {
		const rows = list.querySelectorAll<HTMLElement>(".model-row[data-idx]");
		rows.forEach((r) => {
			const on = Number(r.dataset.idx) === selectedIdx;
			r.classList.toggle("active", on);
		});
		const target = list.querySelector(`.model-row[data-idx="${selectedIdx}"]`);
		target?.scrollIntoView({ block: "nearest" });
	}

	/** Move selection by ±1, skipping separator rows. */
	function moveSelection(dir: 1 | -1): void {
		let i = selectedIdx;
		for (let n = 0; n < filtered.length; n++) {
			i += dir;
			if (i < 0 || i >= filtered.length) return;
			if (!isSeparatorRow(filtered[i])) {
				selectedIdx = i;
				return;
			}
		}
	}

	function applyFilter(): void {
		const q = search.value.toLowerCase().trim();
		filtered = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
		selectedIdx = Math.max(
			0,
			filtered.findIndex((o) => !isSeparatorRow(o)),
		);
		renderList();
	}

	search.addEventListener("input", applyFilter);

	// Keyboard navigation.
	box.tabIndex = -1;
	search.addEventListener("keydown", (ev) => {
		if (ev.key === "ArrowDown") {
			ev.preventDefault();
			moveSelection(1);
			renderActive();
		} else if (ev.key === "ArrowUp") {
			ev.preventDefault();
			moveSelection(-1);
			renderActive();
		} else if (ev.key === "Enter") {
			ev.preventDefault();
			const pick = filtered[selectedIdx];
			if (pick && !isSeparatorRow(pick)) {
				overlay.remove();
				respond(e.id, { value: pick });
			}
		} else if (ev.key === "Escape") {
			ev.preventDefault();
			overlay.remove();
			respond(e.id, { cancelled: true });
		}
	});

	renderList();
	onCancel(overlay, e.id, respond);
	setTimeout(() => search.focus(), 0);
}

/** Confirm dialog — a message with Yes / No buttons. */
function renderConfirm(e: ExtensionUiRequest, respond: ExtensionUiResponder): void {
	const { overlay, box } = createOverlay(e.title ?? "Confirm");
	box.append(el("p", { class: "ext-ui-message", text: e.message ?? "" }));

	const actions = el("div", { class: "ext-ui-actions" });
	const yes = el("button", { class: "btn btn-primary", text: "Yes" });
	const no = el("button", { class: "btn", text: "No" });
	yes.addEventListener("click", () => {
		overlay.remove();
		respond(e.id, { confirmed: true });
	});
	no.addEventListener("click", () => {
		overlay.remove();
		respond(e.id, { confirmed: false });
	});
	actions.append(yes, no);
	box.append(actions);

	onCancel(overlay, e.id, respond);
	setTimeout(() => yes.focus(), 0);
}

/** Input dialog — a text field with submit. */
function renderInput(e: ExtensionUiRequest, respond: ExtensionUiResponder): void {
	const { overlay, box } = createOverlay(e.title ?? "Input");

	const input = el("input", {
		type: "text",
		class: "ext-ui-input",
		placeholder: e.placeholder ?? "",
		autocomplete: "off",
	}) as HTMLInputElement;
	box.append(input);

	const actions = el("div", { class: "ext-ui-actions" });
	const submit = el("button", { class: "btn btn-primary", text: "OK" });
	const cancel = el("button", { class: "btn", text: "Cancel" });
	submit.addEventListener("click", () => {
		overlay.remove();
		respond(e.id, { value: input.value });
	});
	cancel.addEventListener("click", () => {
		overlay.remove();
		respond(e.id, { cancelled: true });
	});
	actions.append(submit, cancel);
	box.append(actions);

	input.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.preventDefault();
			overlay.remove();
			respond(e.id, { value: input.value });
		} else if (ev.key === "Escape") {
			ev.preventDefault();
			overlay.remove();
			respond(e.id, { cancelled: true });
		}
	});

	onCancel(overlay, e.id, respond);
	setTimeout(() => input.focus(), 0);
}
