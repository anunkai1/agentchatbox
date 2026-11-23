/**
 * Mobile edge-swipe gesture for the slide-over sidebar drawer (<= 720px):
 *  - Swipe right from the left edge while collapsed to open.
 *  - Swipe left on the open sidebar or its backdrop to close.
 */

const MOBILE_MAX_WIDTH = 720;
const EDGE_ZONE_PX = 36;
const LOCK_THRESHOLD_PX = 10;
const OPEN_COMMIT_RATIO = 0.3;
const CLOSE_COMMIT_RATIO = 0.25;
const VELOCITY_COMMIT_PX_MS = 0.35;

let installed = false;

function hasHorizontalScrollableAncestor(
	target: EventTarget | null,
	stopAt: Element | null,
): boolean {
	let node = target instanceof Element ? target : null;
	while (node && node !== stopAt && node !== document.body) {
		const style = getComputedStyle(node);
		const ox = style.overflowX;
		if ((ox === "auto" || ox === "scroll") && node.scrollWidth > node.clientWidth + 1) {
			return true;
		}
		node = node.parentElement;
	}
	return false;
}

function isInteractiveSwipeBlock(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return Boolean(
		target.closest("input, textarea, select, [contenteditable='true'], .voice-bar-track"),
	);
}

export function installSidebarSwipe(toggleSidebar: (collapse?: boolean) => void): void {
	if (installed || typeof document === "undefined" || typeof window === "undefined") return;
	installed = true;

	type Mode = "open" | "close";
	let active: {
		mode: Mode;
		startX: number;
		startY: number;
		lastX: number;
		lastTime: number;
		vx: number;
		width: number;
		locked: boolean;
		tempDim: HTMLElement | null;
	} | null = null;

	const resetDrag = (sidebar: HTMLElement | null) => {
		if (sidebar) {
			sidebar.classList.remove("is-swiping");
			sidebar.style.marginLeft = "";
		}
		const dim = document.querySelector<HTMLElement>(".sidebar-dim");
		if (dim) {
			dim.style.opacity = "";
			dim.style.transition = "";
		}
		if (active?.tempDim) {
			active.tempDim.remove();
		}
		active = null;
	};

	document.addEventListener(
		"touchstart",
		(e: TouchEvent) => {
			if (window.innerWidth > MOBILE_MAX_WIDTH) return;
			if (e.touches.length !== 1) return;
			if (document.querySelector(".modal-overlay")) return;
			const sidebar = document.getElementById("sidebar");
			if (!sidebar) return;

			const touch = e.touches[0];
			const collapsed = sidebar.classList.contains("collapsed");
			const width = sidebar.getBoundingClientRect().width || 272;

			if (collapsed) {
				if (touch.clientX > EDGE_ZONE_PX) return;
				if (isInteractiveSwipeBlock(e.target)) return;
				if (hasHorizontalScrollableAncestor(e.target, document.body)) return;
				active = {
					mode: "open",
					startX: touch.clientX,
					startY: touch.clientY,
					lastX: touch.clientX,
					lastTime: Date.now(),
					vx: 0,
					width,
					locked: false,
					tempDim: null,
				};
			} else {
				const target = e.target as Element | null;
				const onSidebarOrDim = Boolean(target?.closest("#sidebar, .sidebar-dim"));
				if (!onSidebarOrDim) return;
				if (isInteractiveSwipeBlock(target)) return;
				active = {
					mode: "close",
					startX: touch.clientX,
					startY: touch.clientY,
					lastX: touch.clientX,
					lastTime: Date.now(),
					vx: 0,
					width,
					locked: false,
					tempDim: null,
				};
			}
		},
		{ passive: true },
	);

	document.addEventListener(
		"touchmove",
		(e: TouchEvent) => {
			if (!active) return;
			if (e.touches.length !== 1) {
				resetDrag(document.getElementById("sidebar"));
				return;
			}
			const sidebar = document.getElementById("sidebar");
			if (!sidebar) {
				resetDrag(null);
				return;
			}

			const touch = e.touches[0];
			const dx = touch.clientX - active.startX;
			const dy = touch.clientY - active.startY;

			if (!active.locked) {
				if (Math.abs(dx) < LOCK_THRESHOLD_PX && Math.abs(dy) < LOCK_THRESHOLD_PX) return;
				if (Math.abs(dy) > Math.abs(dx) * 1.1) {
					active = null;
					return;
				}
				if (active.mode === "open" && dx <= 0) {
					active = null;
					return;
				}
				if (active.mode === "close" && dx >= 0) {
					active = null;
					return;
				}
				active.locked = true;
				sidebar.classList.add("is-swiping");
				if (active.mode === "open" && !document.querySelector(".sidebar-dim")) {
					const tempDim = document.createElement("div");
					tempDim.className = "sidebar-dim";
					tempDim.style.opacity = "0";
					tempDim.style.pointerEvents = "none";
					document.body.append(tempDim);
					active.tempDim = tempDim;
				}
			}

			const now = Date.now();
			const dt = now - active.lastTime;
			if (dt > 0) active.vx = (touch.clientX - active.lastX) / dt;
			active.lastX = touch.clientX;
			active.lastTime = now;

			const dim = active.tempDim ?? document.querySelector<HTMLElement>(".sidebar-dim");
			if (active.mode === "open") {
				const clamped = Math.max(0, Math.min(active.width, dx));
				sidebar.style.marginLeft = `${-active.width + clamped}px`;
				if (dim) dim.style.opacity = String(clamped / active.width);
			} else {
				const clamped = Math.max(-active.width, Math.min(0, dx));
				sidebar.style.marginLeft = `${clamped}px`;
				if (dim) dim.style.opacity = String(1 + clamped / active.width);
			}
		},
		{ passive: true },
	);

	const finish = (cancelled: boolean) => {
		if (!active) return;
		const sidebar = document.getElementById("sidebar");
		if (!active.locked) {
			active = null;
			return;
		}
		const { mode, lastX, startX, width, vx } = active;
		const dx = lastX - startX;
		resetDrag(sidebar);
		if (cancelled) return;

		if (mode === "open") {
			const shouldOpen = dx >= width * OPEN_COMMIT_RATIO || vx >= VELOCITY_COMMIT_PX_MS;
			toggleSidebar(!shouldOpen);
		} else {
			const shouldClose = -dx >= width * CLOSE_COMMIT_RATIO || vx <= -VELOCITY_COMMIT_PX_MS;
			toggleSidebar(shouldClose);
		}
	};

	document.addEventListener("touchend", () => finish(false), { passive: true });
	document.addEventListener("touchcancel", () => finish(true), { passive: true });
}
