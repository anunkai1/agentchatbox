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
export function handleExtensionUiRequest(e: ExtensionUiRequest, respond: ExtensionUiResponder): void {
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
	let selectedIdx = 0;

	function renderList(): void {
		list.innerHTML = "";
		filtered.forEach((opt, i) => {
			const row = el("div", {
				class: `model-row${i === selectedIdx ? " active" : ""}`,
				text: opt,
			});
			row.addEventListener("click", () => {
				overlay.remove();
				respond(e.id, { value: opt });
			});
			row.addEventListener("mouseenter", () => {
				selectedIdx = i;
				renderActive();
			});
			list.append(row);
		});
	}

	function renderActive(): void {
		for (const row of list.querySelectorAll(".model-row")) {
			row.classList.toggle("active", false);
		}
		const rows = list.querySelectorAll(".model-row");
		if (rows[selectedIdx]) rows[selectedIdx].classList.add("active");
	}

	function applyFilter(): void {
		const q = search.value.toLowerCase().trim();
		filtered = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
		selectedIdx = 0;
		renderList();
	}

	search.addEventListener("input", applyFilter);

	// Keyboard navigation.
	box.tabIndex = -1;
	search.addEventListener("keydown", (ev) => {
		const rows = list.querySelectorAll(".model-row");
		if (ev.key === "ArrowDown") {
			ev.preventDefault();
			selectedIdx = Math.min(selectedIdx + 1, rows.length - 1);
			renderActive();
		} else if (ev.key === "ArrowUp") {
			ev.preventDefault();
			selectedIdx = Math.max(selectedIdx - 1, 0);
			renderActive();
		} else if (ev.key === "Enter") {
			ev.preventDefault();
			if (filtered[selectedIdx]) {
				overlay.remove();
				respond(e.id, { value: filtered[selectedIdx] });
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
