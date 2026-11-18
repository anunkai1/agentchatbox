/** A best-effort screen lock for active, foreground Relay capture. */
export function createRelayWakeLock(): (active: boolean) => void {
	let active = false;
	let revision = 0;
	let pending = false;
	let lock: WakeLockSentinel | undefined;
	const acquire = async () => {
		if (pending || document.visibilityState !== "visible" || !navigator.wakeLock) return;
		const request = revision;
		pending = true;
		try {
			const next = await navigator.wakeLock.request("screen");
			if (request !== revision || document.visibilityState !== "visible") await next.release();
			else lock = next;
		} catch {
			// Power settings, browser policy and permissions can deny it. Voice still works.
		} finally {
			pending = false;
			// A hide/stop followed by a restart may have raced the old request.
			if (active && request !== revision) void acquire();
		}
	};
	return (wanted) => {
		if (wanted === active) return;
		active = wanted;
		revision++;
		if (wanted) void acquire();
		else {
			if (lock && !lock.released) void lock.release().catch(() => {});
			lock = undefined;
		}
	};
}
