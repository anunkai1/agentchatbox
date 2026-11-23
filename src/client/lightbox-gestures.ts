/**
 * Touch gesture controller for the fullscreen image lightbox:
 *  - Two-finger pinch-to-zoom (1x..4x) centred on the pinch midpoint
 *  - One-finger pan while zoomed in
 *  - Double-tap to toggle zoom around the tap point
 *  - One-finger swipe-down-to-close while unzoomed
 */

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_DELAY_MS = 280;
const DOUBLE_TAP_MAX_DIST_PX = 36;
const DISMISS_DISTANCE_PX = 90;
const DISMISS_VELOCITY_PX_MS = 0.45;

export interface LightboxGestureOptions {
	overlay: HTMLElement;
	box: HTMLElement;
	stage: HTMLElement;
	img: HTMLImageElement;
	isNativeZoomed: () => boolean;
	onPinchStateChange: (pinched: boolean) => void;
	onDismiss: () => void;
}

export interface LightboxGestureController {
	reset: () => void;
	isPinched: () => boolean;
	consumeSuppressedClick: () => boolean;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function touchDistance(a: Touch, b: Touch): number {
	return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

function touchMidpoint(a: Touch, b: Touch): { x: number; y: number } {
	return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

export function attachLightboxGestures(options: LightboxGestureOptions): LightboxGestureController {
	const { overlay, box, stage, img, isNativeZoomed, onPinchStateChange, onDismiss } = options;

	let scale = 1;
	let tx = 0;
	let ty = 0;
	let suppressClickUntil = 0;

	let pinch: {
		startDist: number;
		startScale: number;
		startTx: number;
		startTy: number;
		originX: number;
		originY: number;
	} | null = null;

	let pan: {
		startX: number;
		startY: number;
		startTx: number;
		startTy: number;
		moved: boolean;
	} | null = null;

	let swipeDown: {
		startX: number;
		startY: number;
		lastY: number;
		lastTime: number;
		vy: number;
		locked: boolean;
	} | null = null;

	let lastTap: { time: number; x: number; y: number } | null = null;

	const clampTranslation = (nextScale: number, nextTx: number, nextTy: number) => {
		if (nextScale <= 1.01) return { x: 0, y: 0 };
		const stageRect = stage.getBoundingClientRect();
		const baseW = img.offsetWidth || stageRect.width;
		const baseH = img.offsetHeight || stageRect.height;
		const maxX = Math.max(0, (baseW * nextScale - stageRect.width) / 2 + 40);
		const maxY = Math.max(0, (baseH * nextScale - stageRect.height) / 2 + 40);
		return {
			x: clamp(nextTx, -maxX, maxX),
			y: clamp(nextTy, -maxY, maxY),
		};
	};

	const applyTransform = (animate = false) => {
		const pinched = scale > 1.05;
		img.style.transition = animate ? "transform 0.18s ease-out" : "none";
		img.style.transform = pinched ? `translate3d(${tx}px, ${ty}px, 0) scale(${scale})` : "";
		stage.classList.toggle("is-pinch-zoomed", pinched);
		onPinchStateChange(pinched);
	};

	const reset = (animate = false) => {
		scale = 1;
		tx = 0;
		ty = 0;
		applyTransform(animate);
	};

	const clearSwipeVisuals = () => {
		box.classList.remove("is-dragging");
		box.style.transform = "";
		box.style.opacity = "";
		overlay.style.background = "";
	};

	stage.addEventListener(
		"touchstart",
		(e: TouchEvent) => {
			if (e.touches.length === 2) {
				// Start pinch gesture (exits swipe-down or single-finger pan cleanly).
				if (swipeDown?.locked) clearSwipeVisuals();
				swipeDown = null;
				pan = null;
				lastTap = null;
				const [a, b] = [e.touches[0], e.touches[1]];
				const dist = touchDistance(a, b);
				if (dist <= 0) return;
				const mid = touchMidpoint(a, b);
				const rect = stage.getBoundingClientRect();
				pinch = {
					startDist: dist,
					startScale: scale,
					startTx: tx,
					startTy: ty,
					originX: mid.x - (rect.left + rect.width / 2),
					originY: mid.y - (rect.top + rect.height / 2),
				};
				e.preventDefault();
				return;
			}

			if (e.touches.length !== 1) return;
			const t = e.touches[0];

			if (scale > 1.05) {
				pan = {
					startX: t.clientX,
					startY: t.clientY,
					startTx: tx,
					startTy: ty,
					moved: false,
				};
				return;
			}

			if (!isNativeZoomed()) {
				swipeDown = {
					startX: t.clientX,
					startY: t.clientY,
					lastY: t.clientY,
					lastTime: Date.now(),
					vy: 0,
					locked: false,
				};
			}
		},
		{ passive: false },
	);

	stage.addEventListener(
		"touchmove",
		(e: TouchEvent) => {
			if (pinch && e.touches.length === 2) {
				e.preventDefault();
				const [a, b] = [e.touches[0], e.touches[1]];
				const dist = touchDistance(a, b);
				const nextScale = clamp(pinch.startScale * (dist / pinch.startDist), MIN_SCALE, MAX_SCALE);
				const ratio = nextScale / pinch.startScale;
				const rawTx = pinch.originX - (pinch.originX - pinch.startTx) * ratio;
				const rawTy = pinch.originY - (pinch.originY - pinch.startTy) * ratio;
				const clamped = clampTranslation(nextScale, rawTx, rawTy);
				scale = nextScale;
				tx = clamped.x;
				ty = clamped.y;
				applyTransform(false);
				suppressClickUntil = Date.now() + 350;
				return;
			}

			if (pan && e.touches.length === 1) {
				e.preventDefault();
				const t = e.touches[0];
				const dx = t.clientX - pan.startX;
				const dy = t.clientY - pan.startY;
				if (Math.hypot(dx, dy) > 4) {
					pan.moved = true;
					suppressClickUntil = Date.now() + 350;
				}
				const clamped = clampTranslation(scale, pan.startTx + dx, pan.startTy + dy);
				tx = clamped.x;
				ty = clamped.y;
				applyTransform(false);
				return;
			}

			if (swipeDown && e.touches.length === 1) {
				const t = e.touches[0];
				const dx = t.clientX - swipeDown.startX;
				const dy = t.clientY - swipeDown.startY;
				if (!swipeDown.locked) {
					if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
					if (dy <= 0 || dy < Math.abs(dx) * 1.15) {
						swipeDown = null;
						return;
					}
					swipeDown.locked = true;
					box.classList.add("is-dragging");
				}
				e.preventDefault();
				const now = Date.now();
				const dt = now - swipeDown.lastTime;
				if (dt > 0) swipeDown.vy = (t.clientY - swipeDown.lastY) / dt;
				swipeDown.lastY = t.clientY;
				swipeDown.lastTime = now;

				const offset = Math.max(0, dy);
				const progress = clamp(offset / 320, 0, 1);
				box.style.transform = `translate3d(0, ${offset}px, 0)`;
				box.style.opacity = String(1 - progress * 0.55);
				overlay.style.background = `rgba(0, 0, 0, ${Math.max(0.15, 0.78 * (1 - progress * 0.75))})`;
				suppressClickUntil = Date.now() + 350;
			}
		},
		{ passive: false },
	);

	const endTouch = (e: TouchEvent, cancelled: boolean) => {
		if (pinch && e.touches.length < 2) {
			pinch = null;
			if (scale <= 1.05) reset(true);
			if (e.touches.length === 1 && scale > 1.05) {
				const t = e.touches[0];
				pan = {
					startX: t.clientX,
					startY: t.clientY,
					startTx: tx,
					startTy: ty,
					moved: true,
				};
			}
			return;
		}

		if (pan && e.touches.length === 0) {
			const moved = pan.moved;
			pan = null;
			if (!cancelled && !moved && e.changedTouches.length === 1) {
				const t = e.changedTouches[0];
				const now = Date.now();
				if (
					lastTap &&
					now - lastTap.time <= DOUBLE_TAP_DELAY_MS &&
					Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) <= DOUBLE_TAP_MAX_DIST_PX
				) {
					lastTap = null;
					suppressClickUntil = now + 400;
					reset(true);
					return;
				}
				lastTap = { time: now, x: t.clientX, y: t.clientY };
			}
			return;
		}

		if (swipeDown && e.touches.length === 0) {
			const s = swipeDown;
			swipeDown = null;
			if (s.locked) {
				const dy = s.lastY - s.startY;
				clearSwipeVisuals();
				if (!cancelled && (dy >= DISMISS_DISTANCE_PX || s.vy >= DISMISS_VELOCITY_PX_MS)) {
					onDismiss();
				}
				return;
			}
			// Quick tap without dragging — detect double-tap to zoom on touch.
			if (!cancelled && !isNativeZoomed() && e.changedTouches.length === 1) {
				const t = e.changedTouches[0];
				const now = Date.now();
				if (
					lastTap &&
					now - lastTap.time <= DOUBLE_TAP_DELAY_MS &&
					Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) <= DOUBLE_TAP_MAX_DIST_PX
				) {
					lastTap = null;
					suppressClickUntil = now + 400;
					const rect = stage.getBoundingClientRect();
					const originX = t.clientX - (rect.left + rect.width / 2);
					const originY = t.clientY - (rect.top + rect.height / 2);
					scale = DOUBLE_TAP_SCALE;
					const clamped = clampTranslation(
						scale,
						originX - originX * scale,
						originY - originY * scale,
					);
					tx = clamped.x;
					ty = clamped.y;
					applyTransform(true);
				} else {
					lastTap = { time: now, x: t.clientX, y: t.clientY };
				}
			}
		}
	};

	stage.addEventListener("touchend", (e) => endTouch(e, false), { passive: true });
	stage.addEventListener("touchcancel", (e) => endTouch(e, true), { passive: true });

	return {
		reset: () => reset(true),
		isPinched: () => scale > 1.05,
		consumeSuppressedClick: () => Date.now() < suppressClickUntil,
	};
}
