import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CapturedUtterance,
	type ConversationCapture,
	captureConversation,
} from "../src/client/conversation-capture.js";

const mock = vi.hoisted(() => ({
	options: {} as Record<string, (...args: unknown[]) => void>,
	encoded: [] as Float32Array[],
	destroy: vi.fn(async () => {}),
}));
vi.mock("@ricky0123/vad-web", () => ({
	MicVAD: {
		new: async (options: typeof mock.options) => {
			mock.options = options;
			return { start: async () => {}, destroy: mock.destroy };
		},
	},
	utils: {
		encodeWAV: (audio: Float32Array) => {
			mock.encoded.push(audio.slice());
			return audio.slice().buffer;
		},
	},
}));

let capture: ConversationCapture | undefined;
let turns: CapturedUtterance[];
let speech: ReturnType<typeof vi.fn>;
let error: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;

async function begin(maxInputSeconds: 30 | 120 = 30) {
	capture = await captureConversation(speech, (turn) => turns.push(turn), error, maxInputSeconds);
	return capture;
}
function start(real = true) {
	mock.options.onSpeechStart();
	if (real) mock.options.onSpeechRealStart();
}
function end(samples: number[]) {
	mock.options.onSpeechEnd(Float32Array.from(samples));
}

beforeEach(() => {
	vi.useFakeTimers();
	turns = [];
	mock.encoded = [];
	mock.destroy.mockClear();
	speech = vi.fn();
	error = vi.fn();
	stop = vi.fn();
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [{ stop, addEventListener: vi.fn() }] }),
		},
	});
	vi.stubGlobal(
		"AudioContext",
		class {
			async resume() {}
			async close() {}
		},
	);
});
afterEach(() => {
	capture?.close();
	capture = undefined;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("conversation input drafts", () => {
	it("allows a natural pause and never submits a partial segment on close", async () => {
		await begin();
		expect(mock.options).toMatchObject({ redemptionMs: 1400, submitUserSpeechOnPause: false });
		start();
		capture!.close();
		expect(turns).toHaveLength(0);
		expect(stop).toHaveBeenCalledOnce();
	});

	it("retains beginning, filler and final sentence when speech resumes during ASR", async () => {
		await begin();
		start();
		end([0.125, 0.25]); // first sentence; ASR has not returned
		const first = turns[0];
		start(false); // invalidate on onset, before the real-start debounce
		expect(first.isCurrent()).toBe(false);
		expect(first.accept()).toBe(false); // late first result must not dispatch
		mock.options.onSpeechRealStart();
		end([0.375]); // "um"
		const second = turns[1];
		start();
		expect(second.accept()).toBe(false);
		end([0.5]); // final sentence
		expect(mock.encoded.at(-1)).toEqual(Float32Array.from([0.125, 0.25, 0.375, 0.5]));
		expect(turns[2].accept()).toBe(true);
		expect(turns[2].accept()).toBe(false);
		expect(speech).toHaveBeenCalledTimes(3);
	});

	it("preserves the draft after empty or failed recognition, without automatic work replay", async () => {
		await begin();
		start();
		end([0.125]);
		// A failed/empty ASR result is not accepted and does not consume audio.
		start();
		end([0.25]);
		expect(mock.encoded.at(-1)).toEqual(Float32Array.from([0.125, 0.25]));
		expect(turns[1].accept()).toBe(true);
	});

	it("does not carry an already accepted request into the next turn", async () => {
		await begin();
		start();
		end([0.125]);
		expect(turns[0].accept()).toBe(true);
		start();
		end([0.5]);
		expect(mock.encoded.at(-1)).toEqual(Float32Array.from([0.5]));
	});

	it("does not strand the earlier draft when a tiny filler is a VAD misfire", async () => {
		await begin();
		start();
		end([0.125]);
		start(false);
		expect(turns[0].accept()).toBe(false);
		mock.options.onVADMisfire();
		expect(mock.encoded.at(-1)).toEqual(Float32Array.from([0.125]));
		expect(turns[1].accept()).toBe(true);
	});

	it("ignores a misfire with no speech draft", async () => {
		await begin();
		start(false);
		mock.options.onVADMisfire();
		expect(turns).toHaveLength(0);
	});

	it("explicit input replacement drops the open segment and fences late ASR", async () => {
		await begin();
		start();
		end([0.125]);
		start();
		capture!.discard();
		expect(turns[0].accept()).toBe(false);
		end([0.25]);
		expect(turns).toHaveLength(1);
		start();
		end([0.5]);
		expect(mock.encoded.at(-1)).toEqual(Float32Array.from([0.5]));
	});

	it("closing the microphone rejects all late transcripts and clears audio", async () => {
		await begin();
		start();
		end([0.125]);
		capture!.close();
		expect(turns[0].accept()).toBe(false);
		start();
		end([0.5]);
		expect(turns).toHaveLength(1);
		expect(mock.destroy).toHaveBeenCalledOnce();
	});

	it("bounds the whole unsubmitted draft, not just individual VAD segments", async () => {
		await begin();
		start();
		mock.options.onSpeechEnd(new Float32Array(16_000 * 20));
		start();
		mock.options.onSpeechEnd(new Float32Array(16_000 * 11));
		expect(turns).toHaveLength(1);
		expect(turns[0].accept()).toBe(false);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("Nothing was submitted") }),
		);
		expect(stop).toHaveBeenCalledOnce();
	});

	it("keeps Relay listening past 30 seconds and resets the budget after an accepted turn", async () => {
		await begin(120);
		for (let i = 0; i < 2; i++) {
			start();
			await vi.advanceTimersByTimeAsync(31_000);
			expect(error).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();
			mock.options.onSpeechEnd(new Float32Array(16_000 * 31));
			expect(turns[i].accept()).toBe(true);
			expect(mock.encoded.at(-1)).toHaveLength(16_000 * 31);
		}
	});

	it("bounds Relay continuous input at two minutes without submitting a partial request", async () => {
		await begin(120);
		start();
		await vi.advanceTimersByTimeAsync(119_999);
		expect(error).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("120-second") }),
		);
		expect(stop).toHaveBeenCalledOnce();
		mock.options.onSpeechEnd(new Float32Array(16_000));
		expect(turns).toHaveLength(0);
	});

	it("bounds all retained Relay segments to two minutes, including pending recognition", async () => {
		await begin(120);
		start();
		mock.options.onSpeechEnd(new Float32Array(16_000 * 80));
		expect(turns).toHaveLength(1);
		start();
		mock.options.onSpeechEnd(new Float32Array(16_000 * 41));
		expect(turns).toHaveLength(1);
		expect(turns[0].accept()).toBe(false);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("120 seconds") }),
		);
		expect(stop).toHaveBeenCalledOnce();
	});

	it("still stops continuous speech at the existing prototype hard limit", async () => {
		await begin();
		start();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("30-second") }),
		);
		expect(stop).toHaveBeenCalledOnce();
		expect(turns).toHaveLength(0);
	});
});
