import { describe, expect, it } from "vitest";
import {
	bufferedSeconds,
	chunkIndexAt,
	formatClock,
	positionAt,
	type Slot,
} from "../src/client/tts-timeline.js";

describe("tts-timeline", () => {
	const chunks = [
		{ start: 0, play: 2 },
		{ start: 2, play: 3 },
		{ start: 5, play: 1.5 },
	];

	it("sums the synthesized seconds", () => {
		expect(bufferedSeconds([])).toBe(0);
		expect(bufferedSeconds(chunks)).toBe(6.5);
	});

	it("finds the chunk containing a time", () => {
		expect(chunkIndexAt(chunks, 0)).toBe(0);
		expect(chunkIndexAt(chunks, 2)).toBe(1);
		expect(chunkIndexAt(chunks, 6.4)).toBe(2);
		expect(chunkIndexAt(chunks, 6.5)).toBe(-1);
	});

	describe("positionAt", () => {
		const slots: Slot[] = [
			{ start: 0, at: 10, play: 2 },
			{ start: 2, at: 12, play: 3 },
			// synthesis fell behind: this slot starts 1s after the previous ended
			{ start: 5, at: 16, play: 1.5 },
		];

		it("is 0 with nothing scheduled", () => {
			expect(positionAt([], 5)).toBe(0);
		});

		it("holds at the first slot's start before it begins (seek, pause)", () => {
			expect(positionAt([{ start: 4, at: 20, play: 2 }], 19)).toBe(4);
		});

		it("advances within and across slots", () => {
			expect(positionAt(slots, 11)).toBe(1);
			expect(positionAt(slots, 12.5)).toBe(2.5);
			expect(positionAt(slots, 17)).toBe(6);
		});

		it("holds at the end of a slot during an underflow gap", () => {
			expect(positionAt(slots, 15.5)).toBe(5);
		});

		it("never runs past the last slot", () => {
			expect(positionAt(slots, 99)).toBe(6.5);
		});
	});

	it("formats clock times", () => {
		expect(formatClock(0)).toBe("0:00");
		expect(formatClock(9.9)).toBe("0:09");
		expect(formatClock(75)).toBe("1:15");
		expect(formatClock(-3)).toBe("0:00");
	});
});
