/**
 * BoundedBuffer — the byte-capped accumulator extracted from python-runner.
 *
 * Covers the eviction path that previously had zero coverage (the ring-buffer
 * math lived inline in python-runner.ts with no test). Locks in: appends up to
 * the cap, evicts leading bytes past the cap, flags truncation, and only
 * appends the marker when actually truncated.
 */

import { describe, expect, it } from "vitest";
import { BoundedBuffer } from "../src/server/bounded-buffer.js";

describe("BoundedBuffer", () => {
	it("accumulates chunks under the cap with no truncation", () => {
		const b = new BoundedBuffer(100);
		b.push(Buffer.from("hello "));
		b.push(Buffer.from("world"));
		expect(b.truncated).toBe(false);
		expect(b.toString()).toBe("hello world");
	});

	it("does not append the marker when under the cap", () => {
		const b = new BoundedBuffer(100);
		b.push(Buffer.from("abc"));
		expect(b.toString("…[truncated]")).toBe("abc");
	});

	it("evicts leading bytes once over the cap, keeping the tail", () => {
		const b = new BoundedBuffer(10);
		b.push(Buffer.from("0123456789")); // exactly 10 → at cap (total >= cap)
		expect(b.truncated).toBe(true);
		b.push(Buffer.from("ABC")); // 13 → evict 3 leading → last 10
		expect(b.toString()).toBe("3456789ABC");
	});

	it("evicts across multiple leading chunks", () => {
		const b = new BoundedBuffer(5);
		b.push(Buffer.from("ab"));
		b.push(Buffer.from("cd"));
		b.push(Buffer.from("ef"));
		b.push(Buffer.from("gh"));
		// 8 bytes pushed, cap 5 → keeps the last 5: "defgh"
		expect(b.toString()).toBe("defgh");
		expect(b.truncated).toBe(true);
	});

	it("splits a leading chunk partially when evicting", () => {
		const b = new BoundedBuffer(4);
		b.push(Buffer.from("ABCDEFGH")); // 8 → evict 4 → "EFGH"
		expect(b.toString()).toBe("EFGH");
		expect(b.truncated).toBe(true);
	});

	it("appends the marker only when truncated", () => {
		const b = new BoundedBuffer(3);
		b.push(Buffer.from("ABCDEFG"));
		const out = b.toString("…MARK");
		expect(out.endsWith("…MARK")).toBe(true);
		expect(out.startsWith("EFG")).toBe(true);
	});

	it("stays bounded after many small chunks", () => {
		const b = new BoundedBuffer(16);
		for (let i = 0; i < 100; i++) b.push(Buffer.from("xy"));
		// 200 bytes pushed, cap 16 → keeps last 16 bytes ("xy" * 8)
		expect(b.toString()).toBe("xy".repeat(8));
		expect(b.truncated).toBe(true);
	});
});
