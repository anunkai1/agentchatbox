/**
 * Touch and zoom gesture controller for the fullscreen image lightbox:
 *  - Two-finger pinch-to-zoom (smooth transform during pinch, crisp layout size on release)
 *  - One-finger pan with momentum glide while zoomed in
 *  - Double-tap to toggle zoom around the tap point (without single-tap interference)
 *  - One-finger swipe-down-to-close while unzoomed
 */

const MIN_SCALE = 1;
const BASE_MAX_SCALE = 6;
const MAX_SCALE_CAP = 12;
const DOUBLE_TAP_BASE_SCALE = 2.5;
const DOUBLE_TAP_DELAY_MS = 280;
const DOUBLE_TAP_MAX_DIST_PX = 36;
const DISMISS_DISTANCE_PX = 90;
const DISMISS_VELOCITY_PX_MS = 0.45;
const TOUCH_CLICK_GUARD_MS = 650;

export interface LightboxGestureOptions {
	overlay: HTMLElement;
	box: HTMLElement;
	stage: HTMLElement;
	img: HTMLImageElement;
	onZoomStateChange: (zoomed: boolean) => void;
	onDismiss: () => void;
}

export interface LightboxGestureController {
	reset: () => void;
	zoomTo100: (focalClientX?: number, focalClientY?: number) => void;
	isZoomed: () => boolean;
	shouldIgnoreMouseClick: (event?: MouseEvent) => boolean;
	destroy: () => void;
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
	const { overlay, box, stage, img, onZoomStateChange, onDismiss } = options;

	let scale = 1;
	let lastTouchAt = 0;
	let momentumRaf = 0;
	let destroyed = false;

	let pinch: {
		startDist: number;
		startScale: number;
		startW: number;
		startH: number;
		imgCenterX: number;
		imgCenterY: number;
		u: number;
		v: number;
		lastMidX: number;
		lastMidY: number;
	} | null = null;

	let pan: {
		startX: number;
		startY: number;
		startScrollLeft: number;
		startScrollTop: number;
		lastX: number;
		lastY: number;
		lastTime: number;
		vx: number;
		vy: number;
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

	const stopMomentum = () => {
		if (momentumRaf) {
			cancelAnimationFrame(momentumRaf);
			momentumRaf = 0;
		}
	};

	const getFitMetrics = () => {
		const stageW = stage.clientWidth || window.innerWidth || 1;
		const stageH = stage.clientHeight || window.innerHeight || 1;
		const natW = img.naturalWidth || img.offsetWidth || stageW;
		const natH = img.naturalHeight || img.offsetHeight || stageH;
		const fitRatio = Math.min(stageW / natW, stageH / natH, 1);
		const fitW = Math.max(1, natW * fitRatio);
		const fitH = Math.max(1, natH * fitRatio);
		const maxScale = clamp(
			Math.max(BASE_MAX_SCALE, (natW / fitW) * 2),
			BASE_MAX_SCALE,
			MAX_SCALE_CAP,
		);
		return { stageW, stageH, natW, natH, fitW, fitH, maxScale };
	};

	const commitZoom = (
		nextScale: number,
		focalStageX?: number,
		focalStageY?: number,
		focalU = 0.5,
		focalV = 0.5,
	) => {
		stopMomentum();
		img.style.transition = "";
		img.style.transform = "";
		img.style.willChange = "";
		stage.classList.remove("is-pinching");

		if (nextScale <= 1.05) {
			scale = 1;
			img.style.width = "";
			img.style.height = "";
			stage.scrollLeft = 0;
			stage.scrollTop = 0;
			stage.classList.remove("is-pinch-zoomed", "is-zoomed");
			img.classList.remove("is-zoomed");
			onZoomStateChange(false);
			return;
		}

		const { fitW, fitH, maxScale } = getFitMetrics();
		scale = clamp(nextScale, 1.06, maxScale);
		const targetW = Math.max(1, Math.round(fitW * scale));
		const targetH = Math.max(1, Math.round(fitH * scale));

		img.style.width = `${targetW}px`;
		img.style.height = `${targetH}px`;
		stage.classList.add("is-pinch-zoomed", "is-zoomed");
		img.classList.add("is-zoomed");

		const fx = focalStageX ?? stage.clientWidth / 2;
		const fy = focalStageY ?? stage.clientHeight / 2;
		const maxScrollX = Math.max(0, targetW - stage.clientWidth);
		const maxScrollY = Math.max(0, targetH - stage.clientHeight);
		stage.scrollLeft = clamp(focalU * targetW - fx, 0, maxScrollX);
		stage.scrollTop = clamp(focalV * targetH - fy, 0, maxScrollY);
		onZoomStateChange(true);
	};

	const zoomAtClientPoint = (targetScale: number, clientX?: number, clientY?: number) => {
		const rect = img.getBoundingClientRect();
		const stageRect = stage.getBoundingClientRect();
		const hasPoint =
			typeof clientX === "number" &&
			typeof clientY === "number" &&
			rect.width > 0 &&
			rect.height > 0;
		const u = hasPoint ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0.5;
		const v = hasPoint ? clamp((clientY - rect.top) / rect.height, 0, 1) : 0.5;
		const fx = hasPoint ? clientX - stageRect.left : stageRect.width / 2;
		const fy = hasPoint ? clientY - stageRect.top : stageRect.height / 2;
		commitZoom(targetScale, fx, fy, u, v);
	};

	const clearSwipeVisuals = () => {
		box.classList.remove("is-dragging");
		box.style.transform = "";
		box.style.opacity = "";
		overlay.style.background = "";
	};

	const startMomentum = (vx: number, vy: number) => {
		stopMomentum();
		// Velocity is in px/ms; convert to px per ~16ms frame and cap extremes.
		let frameVx = clamp(vx * 16, -48, 48);
		let frameVy = clamp(vy * 16, -48, 48);
		if (Math.hypot(frameVx, frameVy) < 1.2) return;

		const step = () => {
			if (destroyed || scale <= 1.05 || pan || pinch) {
				momentumRaf = 0;
				return;
			}
			const prevLeft = stage.scrollLeft;
			const prevTop = stage.scrollTop;
			stage.scrollLeft = prevLeft - frameVx;
			stage.scrollTop = prevTop - frameVy;
			frameVx *= 0.92;
			frameVy *= 0.92;
			const moved =
				Math.abs(stage.scrollLeft - prevLeft) >= 0.4 || Math.abs(stage.scrollTop - prevTop) >= 0.4;
			if (!moved || Math.hypot(frameVx, frameVy) < 0.4) {
				momentumRaf = 0;
				return;
			}
			momentumRaf = requestAnimationFrame(step);
		};
		momentumRaf = requestAnimationFrame(step);
	};

	const beginPan = (t: Touch) => {
		pan = {
			startX: t.clientX,
			startY: t.clientY,
			startScrollLeft: stage.scrollLeft,
			startScrollTop: stage.scrollTop,
			lastX: t.clientX,
			lastY: t.clientY,
			lastTime: Date.now(),
			vx: 0,
			vy: 0,
			moved: false,
		};
	};

	const onTouchStart = (e: TouchEvent) => {
		lastTouchAt = Date.now();
		stopMomentum();

		if (e.touches.length === 2) {
			if (swipeDown?.locked) clearSwipeVisuals();
			swipeDown = null;
			pan = null;
			lastTap = null;
			const [a, b] = [e.touches[0], e.touches[1]];
			const dist = touchDistance(a, b);
			if (dist <= 0) return;
			const mid = touchMidpoint(a, b);
			stage.classList.add("is-pinching");
			img.style.willChange = "transform";
			const rect = img.getBoundingClientRect();
			pinch = {
				startDist: dist,
				startScale: scale,
				startW: rect.width || img.offsetWidth || 1,
				startH: rect.height || img.offsetHeight || 1,
				imgCenterX: rect.left + rect.width / 2,
				imgCenterY: rect.top + rect.height / 2,
				u: rect.width > 0 ? (mid.x - rect.left) / rect.width : 0.5,
				v: rect.height > 0 ? (mid.y - rect.top) / rect.height : 0.5,
				lastMidX: mid.x,
				lastMidY: mid.y,
			};
			e.preventDefault();
			return;
		}

		if (e.touches.length !== 1) return;
		const t = e.touches[0];

		if (scale > 1.05) {
			beginPan(t);
			return;
		}

		swipeDown = {
			startX: t.clientX,
			startY: t.clientY,
			lastY: t.clientY,
			lastTime: Date.now(),
			vy: 0,
			locked: false,
		};
	};

	const onTouchMove = (e: TouchEvent) => {
		lastTouchAt = Date.now();

		if (pinch && e.touches.length === 2) {
			e.preventDefault();
			const [a, b] = [e.touches[0], e.touches[1]];
			const dist = touchDistance(a, b);
			const mid = touchMidpoint(a, b);
			const { maxScale } = getFitMetrics();
			const nextScale = clamp(pinch.startScale * (dist / pinch.startDist), 0.85, maxScale);
			const relScale = nextScale / pinch.startScale;
			const targetCenterX = mid.x - (pinch.u - 0.5) * pinch.startW * relScale;
			const targetCenterY = mid.y - (pinch.v - 0.5) * pinch.startH * relScale;
			const tx = targetCenterX - pinch.imgCenterX;
			const ty = targetCenterY - pinch.imgCenterY;
			scale = nextScale;
			pinch.lastMidX = mid.x;
			pinch.lastMidY = mid.y;
			img.style.transition = "none";
			img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${relScale})`;
			const zoomed = nextScale > 1.05;
			stage.classList.toggle("is-pinch-zoomed", zoomed);
			onZoomStateChange(zoomed);
			return;
		}

		if (pan && e.touches.length === 1) {
			e.preventDefault();
			const t = e.touches[0];
			const dx = t.clientX - pan.startX;
			const dy = t.clientY - pan.startY;
			if (Math.hypot(dx, dy) > 4) {
				pan.moved = true;
			}
			const now = Date.now();
			const dt = now - pan.lastTime;
			if (dt > 0) {
				const instVx = (t.clientX - pan.lastX) / dt;
				const instVy = (t.clientY - pan.lastY) / dt;
				pan.vx = pan.vx * 0.4 + instVx * 0.6;
				pan.vy = pan.vy * 0.4 + instVy * 0.6;
			}
			pan.lastX = t.clientX;
			pan.lastY = t.clientY;
			pan.lastTime = now;
			stage.scrollLeft = pan.startScrollLeft - dx;
			stage.scrollTop = pan.startScrollTop - dy;
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
			overlay.style.background = `rgba(0, 0, 0, ${Math.max(0.15, 0.88 * (1 - progress * 0.75))})`;
		}
	};

	const endTouch = (e: TouchEvent, cancelled: boolean) => {
		lastTouchAt = Date.now();

		if (pinch && e.touches.length < 2) {
			const p = pinch;
			pinch = null;
			const finalRect = img.getBoundingClientRect();
			const stageRect = stage.getBoundingClientRect();
			const focalStageX = p.lastMidX - stageRect.left;
			const focalStageY = p.lastMidY - stageRect.top;
			const u = finalRect.width > 0 ? (p.lastMidX - finalRect.left) / finalRect.width : p.u;
			const v = finalRect.height > 0 ? (p.lastMidY - finalRect.top) / finalRect.height : p.v;
			commitZoom(scale, focalStageX, focalStageY, u, v);
			if (e.touches.length === 1 && scale > 1.05) {
				beginPan(e.touches[0]);
				pan!.moved = true;
			}
			return;
		}

		if (pan && e.touches.length === 0) {
			const p = pan;
			pan = null;
			if (!cancelled && p.moved) {
				if (Date.now() - p.lastTime < 100) startMomentum(p.vx, p.vy);
				return;
			}
			if (!cancelled && !p.moved && e.changedTouches.length === 1) {
				const t = e.changedTouches[0];
				const now = Date.now();
				if (
					lastTap &&
					now - lastTap.time <= DOUBLE_TAP_DELAY_MS &&
					Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) <= DOUBLE_TAP_MAX_DIST_PX
				) {
					lastTap = null;
					commitZoom(1);
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
			if (!cancelled && e.changedTouches.length === 1) {
				const t = e.changedTouches[0];
				const now = Date.now();
				if (
					lastTap &&
					now - lastTap.time <= DOUBLE_TAP_DELAY_MS &&
					Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) <= DOUBLE_TAP_MAX_DIST_PX
				) {
					lastTap = null;
					const { fitW, natW, maxScale } = getFitMetrics();
					const doubleTapScale = clamp(
						Math.max(DOUBLE_TAP_BASE_SCALE, (natW / fitW) * 0.55),
						DOUBLE_TAP_BASE_SCALE,
						maxScale,
					);
					zoomAtClientPoint(doubleTapScale, t.clientX, t.clientY);
				} else {
					lastTap = { time: now, x: t.clientX, y: t.clientY };
				}
			}
		}
	};

	const onTouchEnd = (e: TouchEvent) => endTouch(e, false);
	const onTouchCancel = (e: TouchEvent) => endTouch(e, true);
	const onResize = () => {
		if (scale > 1.05 && !pinch) {
			commitZoom(scale);
		}
	};

	stage.addEventListener("touchstart", onTouchStart, { passive: false });
	stage.addEventListener("touchmove", onTouchMove, { passive: false });
	stage.addEventListener("touchend", onTouchEnd, { passive: true });
	stage.addEventListener("touchcancel", onTouchCancel, { passive: true });
	window.addEventListener("resize", onResize);

	return {
		reset: () => commitZoom(MIN_SCALE),
		zoomTo100: (focalClientX?: number, focalClientY?: number) => {
			const { fitW, natW, maxScale } = getFitMetrics();
			const nativeScale = clamp(natW > fitW * 1.05 ? natW / fitW : 2, 1.5, maxScale);
			zoomAtClientPoint(nativeScale, focalClientX, focalClientY);
		},
		isZoomed: () => scale > 1.05,
		shouldIgnoreMouseClick: (event?: MouseEvent) => {
			const pointerType = (event as PointerEvent | undefined)?.pointerType;
			if (pointerType === "touch") return true;
			return Date.now() - lastTouchAt < TOUCH_CLICK_GUARD_MS;
		},
		destroy: () => {
			destroyed = true;
			stopMomentum();
			stage.removeEventListener("touchstart", onTouchStart);
			stage.removeEventListener("touchmove", onTouchMove);
			stage.removeEventListener("touchend", onTouchEnd);
			stage.removeEventListener("touchcancel", onTouchCancel);
			window.removeEventListener("resize", onResize);
		},
	};
}
