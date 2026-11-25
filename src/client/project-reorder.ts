/**
 * Sidebar project reordering — pure order math plus unified Pointer Events
 * drag-and-drop for both desktop (direct mouse drag on project headers, or
 * reorder mode) and touch (grip handle in reorder mode).
 */

import { el } from "./dom.js";

const HANDLE_DRAG_THRESHOLD_PX = 3;
const HEADER_DRAG_THRESHOLD_PX = 6;
const AUTOSCROLL_EDGE_PX = 36;
const AUTOSCROLL_MAX_STEP_PX = 10;

/**
 * Move `projectId` up (`-1`) or down (`+1`) by one slot. Returns the updated
 * id list, or `null` when the move is out of bounds or the id is unknown.
 */
export function moveProjectInOrder(
	ids: readonly string[],
	projectId: string,
	delta: -1 | 1,
): string[] | null {
	const index = ids.indexOf(projectId);
	const target = index + delta;
	if (index < 0 || target < 0 || target >= ids.length) return null;
	const next = [...ids];
	[next[index], next[target]] = [next[target], next[index]];
	return next;
}

/**
 * Find the insertion slot among the remaining (non-dragged) project rows for a
 * pointer at `clientY`, given their sorted vertical midpoints.
 */
export function computeDropIndex(clientY: number, otherMidpoints: readonly number[]): number {
	for (let i = 0; i < otherMidpoints.length; i++) {
		if (clientY < otherMidpoints[i]) return i;
	}
	return otherMidpoints.length;
}

/**
 * Insert `projectId` at `insertIndexAmongOthers` (0..N-1) among the remaining
 * ids. Returns `null` when the resulting order is unchanged or invalid.
 */
export function reorderProjectIds(
	ids: readonly string[],
	projectId: string,
	insertIndexAmongOthers: number,
): string[] | null {
	const fromIndex = ids.indexOf(projectId);
	if (fromIndex < 0) return null;
	const clamped = Math.max(0, Math.min(ids.length - 1, insertIndexAmongOthers));
	if (clamped === fromIndex) return null;
	const others = ids.filter((id) => id !== projectId);
	others.splice(clamped, 0, projectId);
	return others;
}

export interface ProjectDragOptions {
	reordering: boolean;
	onDragStateChange: (dragging: boolean, willReorder?: boolean) => void;
	onReorder: (nextUserIds: string[]) => void;
}

/**
 * Attach pointer-based vertical drag reordering to `.projects-container-body`.
 *
 * Triggers:
 *  - `.project-drag-handle`: any pointer type (mouse, touch, pen).
 *  - Normal mode `.project-folder-toggle`: mouse only (touch keeps vertical scroll).
 *  - Reorder mode `.project-folder-header` (outside `.project-action`): mouse only.
 */
export function installProjectDrag(body: HTMLElement, options: ProjectDragOptions): void {
	body.addEventListener("pointerdown", (e: PointerEvent) => {
		if (!e.isPrimary || e.button !== 0) return;
		const target = e.target instanceof Element ? e.target : null;
		const folder = target?.closest<HTMLElement>(".project-folder");
		if (!folder || folder.parentElement !== body) return;
		const projectId = folder.dataset.projectId;
		if (!projectId) return;

		const folders = Array.from(body.children).filter(
			(node): node is HTMLElement =>
				node instanceof HTMLElement &&
				node.classList.contains("project-folder") &&
				Boolean(node.dataset.projectId),
		);
		if (folders.length < 2) return;

		const onHandle = Boolean(target?.closest(".project-drag-handle"));
		const onNormalToggle =
			!options.reordering &&
			e.pointerType === "mouse" &&
			Boolean(target?.closest(".project-folder-toggle"));
		const onReorderHeader =
			options.reordering &&
			e.pointerType === "mouse" &&
			Boolean(target?.closest(".project-folder-header")) &&
			!target?.closest(".project-action");
		if (!onHandle && !onNormalToggle && !onReorderHeader) return;

		if (onHandle) e.preventDefault();

		const pointerId = e.pointerId;
		const startX = e.clientX;
		const startY = e.clientY;
		let lastClientY = e.clientY;
		const threshold = onHandle ? HANDLE_DRAG_THRESHOLD_PX : HEADER_DRAG_THRESHOLD_PX;
		const header = folder.querySelector<HTMLElement>(".project-folder-header") ?? folder;
		const headerRect = header.getBoundingClientRect();
		const offsetY = Math.max(0, Math.min(headerRect.height, e.clientY - headerRect.top));
		const fromIndex = folders.indexOf(folder);
		const otherFolders = folders.filter((node) => node !== folder);
		const pane = body.closest<HTMLElement>(".sidebar-projects-pane");

		let active = false;
		let ghost: HTMLElement | null = null;
		let dropTargetEl: HTMLElement | null = null;
		let currentInsertIdx = fromIndex;
		let rafId: number | null = null;

		const clearDropIndicator = () => {
			if (!dropTargetEl) return;
			dropTargetEl.classList.remove("project-drop-before", "project-drop-after");
			dropTargetEl = null;
		};

		const updateDropTarget = (clientY: number) => {
			const midpoints = otherFolders.map((node) => {
				const target = node.querySelector<HTMLElement>(".project-folder-header") ?? node;
				const rect = target.getBoundingClientRect();
				return rect.top + rect.height / 2;
			});
			currentInsertIdx = computeDropIndex(clientY, midpoints);
			clearDropIndicator();
			if (currentInsertIdx === fromIndex || otherFolders.length === 0) return;
			if (currentInsertIdx < otherFolders.length) {
				dropTargetEl = otherFolders[currentInsertIdx];
				dropTargetEl.classList.add("project-drop-before");
			} else {
				dropTargetEl = otherFolders[otherFolders.length - 1];
				dropTargetEl.classList.add("project-drop-after");
			}
		};

		const positionGhost = (clientY: number) => {
			if (!ghost) return;
			const maxTop = Math.max(4, window.innerHeight - headerRect.height - 4);
			const top = Math.max(4, Math.min(maxTop, clientY - offsetY));
			ghost.style.top = `${top}px`;
		};

		const autoScrollTick = () => {
			if (!active) return;
			if (pane && pane.scrollHeight > pane.clientHeight) {
				const rect = pane.getBoundingClientRect();
				let delta = 0;
				if (lastClientY < rect.top + AUTOSCROLL_EDGE_PX) {
					const ratio = Math.min(
						1,
						(rect.top + AUTOSCROLL_EDGE_PX - lastClientY) / AUTOSCROLL_EDGE_PX,
					);
					delta = -Math.max(2, Math.round(ratio * AUTOSCROLL_MAX_STEP_PX));
				} else if (lastClientY > rect.bottom - AUTOSCROLL_EDGE_PX) {
					const ratio = Math.min(
						1,
						(lastClientY - (rect.bottom - AUTOSCROLL_EDGE_PX)) / AUTOSCROLL_EDGE_PX,
					);
					delta = Math.max(2, Math.round(ratio * AUTOSCROLL_MAX_STEP_PX));
				}
				if (delta !== 0) {
					const before = pane.scrollTop;
					pane.scrollTop += delta;
					if (pane.scrollTop !== before) updateDropTarget(lastClientY);
				}
			}
			rafId = requestAnimationFrame(autoScrollTick);
		};

		const activateDrag = (clientY: number) => {
			active = true;
			options.onDragStateChange(true);
			document.body.classList.add("is-dragging-project");
			folder.classList.add("is-drag-source");

			ghost = el("div", { class: "project-drag-ghost", "aria-hidden": "true" });
			const icon = header.querySelector(".project-icon")?.cloneNode(true);
			const name = header.querySelector(".project-name")?.cloneNode(true);
			if (icon) ghost.append(icon);
			if (name) ghost.append(name);
			ghost.style.left = `${headerRect.left}px`;
			ghost.style.width = `${headerRect.width}px`;
			document.body.append(ghost);
			positionGhost(clientY);
			updateDropTarget(clientY);
			rafId = requestAnimationFrame(autoScrollTick);
		};

		const cleanup = (suppressClick: boolean, willReorder = false) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("keydown", onKeydown, true);
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			clearDropIndicator();
			ghost?.remove();
			ghost = null;
			folder.classList.remove("is-drag-source");
			document.body.classList.remove("is-dragging-project");
			if (active) {
				active = false;
				if (suppressClick) {
					const blockClick = (ev: MouseEvent) => {
						ev.preventDefault();
						ev.stopPropagation();
						window.removeEventListener("click", blockClick, true);
					};
					window.addEventListener("click", blockClick, true);
					setTimeout(() => window.removeEventListener("click", blockClick, true), 0);
				}
				options.onDragStateChange(false, willReorder);
			}
		};

		const onMove = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return;
			lastClientY = ev.clientY;
			if (!active) {
				if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < threshold) return;
				activateDrag(ev.clientY);
			}
			ev.preventDefault();
			positionGhost(ev.clientY);
			updateDropTarget(ev.clientY);
		};

		const onUp = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return;
			const wasActive = active;
			const finalIdx = currentInsertIdx;
			const nextOrder =
				wasActive && finalIdx !== fromIndex
					? reorderProjectIds(
							folders.map((node) => node.dataset.projectId!),
							projectId,
							finalIdx,
						)
					: null;
			cleanup(wasActive, Boolean(nextOrder));
			if (nextOrder) options.onReorder(nextOrder);
		};

		const onCancel = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return;
			cleanup(false);
		};

		const onBlur = () => {
			cleanup(false);
		};

		const onKeydown = (ev: KeyboardEvent) => {
			if (ev.key === "Escape" && active) {
				ev.preventDefault();
				ev.stopPropagation();
				cleanup(true);
			}
		};

		window.addEventListener("pointermove", onMove, { passive: false });
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("blur", onBlur);
		window.addEventListener("keydown", onKeydown, true);
	});
}
