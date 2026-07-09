/**
 * Tiny shared server utilities.

 * Collected here so they have one home instead of being inlined or
 * scattered across modules. Keep this file dependency-free.
 */

/**
 * Unref a timer/stream if it exposes `unref()`. Node timers and most
 * stream-like objects do; guarding with `typeof` keeps it safe for the
 * odd duck that doesn't (and for the type system, which doesn't know
 * every callee has it). Stops the timer from keeping the event loop
 * alive on its own.
 */
export function safeUnref(t: { unref?: () => void }): void {
	if (typeof t.unref === "function") t.unref();
}
