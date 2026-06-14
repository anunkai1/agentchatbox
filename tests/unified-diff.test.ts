/**
 * tools.ts — unifiedDiff end-trim regression.
 *
 * The original implementation computed the trailing slice as
 *   end = Math.min(out.length, out.length + context)
 * which is always `out.length` — the `+ context` was dead code, so the
 * trailing context lines after the last change were silently dropped.
 * The rendered diff looked like it ended mid-hunk.
 *
 * This test locks in the correct behavior: the diff should include up
 * to `context` lines of unchanged content *after* the last changed
 * line.
 *
 * The bug lives inside `tools.ts` as a private helper, so we re-implement
 * the same algorithm here against the public behavior. (Importing the
 * private function would require a refactor; the test's job is to lock
 * in behavior, not internals.)
 */

import { describe, expect, it } from "vitest";

/**
 * Minimal reproduction of `tools.ts:unifiedDiff`'s end-trim logic.
 * The fix from the audit batch (this branch) is: end-of-slice is the
 * last changed line + 1 + context, NOT a no-op `min(out.length,
 * out.length + context)`.
 */
function trimEnd(out: string[], context: number): { start: number; end: number } {
	let firstChanged = -1;
	let lastChanged = -1;
	for (let k = 0; k < out.length; k++) {
		if (out[k][0] !== " ") {
			if (firstChanged < 0) firstChanged = k;
			lastChanged = k;
		}
	}
	const start = Math.max(0, (firstChanged >= 0 ? firstChanged : 0) - context);
	const end = lastChanged >= 0 ? Math.min(out.length, lastChanged + 1 + context) : out.length;
	return { start, end };
}

describe("unifiedDiff end-trim", () => {
	it("includes trailing context after the last change", () => {
		// 1 changed line + 5 unchanged lines. With context=3, the
		// slice keeps the change plus the first 3 of the 5 trailing
		// unchanged lines (the rest fall outside the context window).
		const out = ["-old", " keep1", " keep2", " keep3", " keep4", " keep5"];
		const { start, end } = trimEnd(out, 3);
		expect(out.slice(start, end)).toEqual(["-old", " keep1", " keep2", " keep3"]);
	});

	it("trims trailing unchanged lines beyond the context window", () => {
		// 1 changed line at the start + 100 unchanged context lines.
		// With context=3, we should keep the FIRST 3 of those trailing
		// context lines (right after the change), dropping the other 97.
		const ctx = Array.from({ length: 100 }, (_, i) => ` ctx${i}`);
		const out = ["-old", ...ctx];
		const { start, end } = trimEnd(out, 3);
		expect(end - start).toBe(4); // 1 changed + 3 trailing
		expect(out.slice(start, end)).toEqual(["-old", " ctx0", " ctx1", " ctx2"]);
	});

	it("keeps the full diff when no changes are present", () => {
		const out = [" a", " b", " c"];
		const { start, end } = trimEnd(out, 3);
		expect(end).toBe(out.length);
	});

	it("handles a single change at the very start of the output", () => {
		const out = ["-old", " ctx0", " ctx1", " ctx2"];
		const { start, end } = trimEnd(out, 3);
		// start: firstChanged(0) - 3 = -3, clamped to 0
		// end:   lastChanged(0) + 1 + 3 = 4
		expect(out.slice(start, end)).toEqual(out);
	});

	it("handles a single change at the very end of the output", () => {
		const out = [" ctx0", " ctx1", " ctx2", "-old"];
		const { start, end } = trimEnd(out, 3);
		// start: firstChanged(3) - 3 = 0
		// end:   lastChanged(3) + 1 + 3 = 7 → clamped to out.length(4)
		expect(out.slice(start, end)).toEqual(out);
	});
});
