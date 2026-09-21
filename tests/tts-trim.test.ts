import { describe, expect, it } from "vitest";
import {
	type AudioBufferLike,
	CHUNK_JOIN_PAUSE_S,
	LEAD_KEEP_S,
	trimChunkSilence,
} from "../src/client/tts-trim.js";

/**
 * trimChunkSilence — the per-chunk padding trim that removes the audible pause
 * at a streamed-TTS chunk boundary.
 *
 * Kokoro surrounds every synthesized chunk with silence; the tests below pin the
 * three things that matter: the leading pad goes (minus a sliver, so a soft
 * onset isn't clipped), the trailing pad is cut back to one breath (not to
 * zero, which would run sentences together), and a chunk that has nothing to
 * trim — or nothing but silence — is passed through untouched rather than
 * silenced. The last case is the safety property: a wrong answer there drops
 * the user's audio.
 */
describe("trimChunkSilence", () => {
	const SAMPLE_RATE = 24_000;

	/** A mono buffer of `[silence][speech][silence]`, all in seconds. */
	function padded(lead: number, speech: number, trail: number): AudioBufferLike {
		const leadSamples = Math.round(lead * SAMPLE_RATE);
		const speechSamples = Math.round(speech * SAMPLE_RATE);
		const trailSamples = Math.round(trail * SAMPLE_RATE);
		const length = leadSamples + speechSamples + trailSamples;
		const data = new Float32Array(length);
		for (let i = 0; i < speechSamples; i++) {
			// A steady tone at ~-6 dBFS, comfortably above the silence floor.
			data[leadSamples + i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
		}
		return {
			numberOfChannels: 1,
			sampleRate: SAMPLE_RATE,
			length,
			duration: length / SAMPLE_RATE,
			getChannelData: (channel: number) => (channel === 0 ? data : new Float32Array(length)),
		};
	}

	it("drops the leading pad and cuts the trailing pad back to one breath", () => {
		const buffer = padded(0.5, 2, 0.6);
		const { offset, duration } = trimChunkSilence(buffer);
		// Leading: the detected 0.5s of silence bar the anti-clip sliver.
		expect(offset).toBeCloseTo(0.5 - LEAD_KEEP_S, 2);
		// Trailing: the 2s of speech, plus the sliver and the kept breath.
		expect(duration).toBeCloseTo(2 + LEAD_KEEP_S + CHUNK_JOIN_PAUSE_S, 2);
		// A 3.1s chunk of which 1.1s was dead air now plays 2.23s of speech.
		expect(buffer.duration - duration).toBeCloseTo(0.5 + 0.6 - LEAD_KEEP_S - CHUNK_JOIN_PAUSE_S, 2);
	});

	it("leaves an unpadded chunk effectively alone", () => {
		const buffer = padded(0, 1.5, 0);
		const { offset, duration } = trimChunkSilence(buffer);
		expect(offset).toBe(0);
		expect(duration).toBeCloseTo(1.5, 2);
	});

	it("passes an all-silent chunk through instead of removing it", () => {
		// A punctuation-only chunk can synthesize to pure silence; dropping it
		// would be harmless here, but the trim must never return nothing playable.
		const buffer = padded(0, 0, 0.8);
		expect(trimChunkSilence(buffer)).toEqual({ offset: 0, duration: buffer.duration });
	});

	it("keeps the whole chunk when the trailing pad is already shorter than the breath", () => {
		const buffer = padded(0.4, 1, 0.05);
		const { offset, duration } = trimChunkSilence(buffer);
		expect(offset).toBeCloseTo(0.4 - LEAD_KEEP_S, 2);
		expect(duration).toBeCloseTo(buffer.duration - (0.4 - LEAD_KEEP_S), 2);
	});

	it("trims a chunk padded only at the front", () => {
		const buffer = padded(0.3, 1, 0);
		const { offset, duration } = trimChunkSilence(buffer);
		expect(offset).toBeCloseTo(0.3 - LEAD_KEEP_S, 2);
		expect(duration).toBeCloseTo(1 + LEAD_KEEP_S, 2);
	});

	it("caps the lead trim so a nearly-silent chunk still starts at once", () => {
		const buffer = padded(1.5, 1, 0);
		const { offset } = trimChunkSilence(buffer);
		expect(offset).toBe(1); // MAX_LEAD_TRIM_S, not the detected 1.47s
	});

	it("judges silence on the loudest channel, not channel 0", () => {
		const speech = padded(0.4, 1, 0.5);
		const silent = new Float32Array(speech.length);
		const buffer: AudioBufferLike = {
			...speech,
			numberOfChannels: 2,
			getChannelData: (channel: number) => (channel === 0 ? silent : speech.getChannelData(0)),
		};
		const { offset, duration } = trimChunkSilence(buffer);
		expect(offset).toBeCloseTo(0.4 - LEAD_KEEP_S, 2);
		expect(duration).toBeCloseTo(1 + LEAD_KEEP_S + CHUNK_JOIN_PAUSE_S, 2);
	});

	it("treats audio below the silence floor as silence", () => {
		// A tone at -60 dBFS, far under the -45 dBFS floor, so every window in the
		// chunk reads as pad: there is no speech to find, and the whole buffer is
		// handed back untouched (worst case it plays as the near-silence it is).
		const quiet = padded(0.4, 1, 0.4);
		const data = quiet.getChannelData(0);
		const speechStart = Math.round(0.4 * SAMPLE_RATE);
		const speechEnd = Math.round(1.4 * SAMPLE_RATE);
		for (let i = speechStart; i < speechEnd; i++) {
			data[i] = 0.001 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
		}
		expect(trimChunkSilence(quiet)).toEqual({ offset: 0, duration: quiet.duration });
	});

	it("returns a no-op for a buffer too short to hold one window", () => {
		const buffer: AudioBufferLike = {
			numberOfChannels: 1,
			sampleRate: SAMPLE_RATE,
			length: 4,
			duration: 4 / SAMPLE_RATE,
			getChannelData: () => new Float32Array(4),
		};
		expect(trimChunkSilence(buffer)).toEqual({ offset: 0, duration: buffer.duration });
	});
});
