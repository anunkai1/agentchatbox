import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionExists, streamSynthesizeAudio } from "../src/client/api.js";
import { decodePcm16Samples } from "../src/client/voice.js";

afterEach(() => vi.unstubAllGlobals());

describe("sessionExists", () => {
	it("uses a body-free HEAD probe for shareable-link validation", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchMock);
		await expect(sessionExists("session id")).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session%20id", { method: "HEAD" });
	});
});

/**
 * The /api/tts/stream body is a binary frame stream ([1 byte type][uint32 LE length][payload]).
 * The parser is the one place where a malformed length field could make the browser
 * buffer gigabytes, so its framing rules are pinned here: partial reads must be
 * reassembled, DATA frames yield in order, END ends cleanly, ERR raises, and an
 * absurd frame length is refused instead of allocated.
 */
describe("streamSynthesizeAudio", () => {
	/** Build a frame: [type][uint32 LE length][payload]. */
	function frame(type: number, payload: Uint8Array): Uint8Array {
		const out = new Uint8Array(5 + payload.length);
		out[0] = type;
		out[1] = payload.length & 0xff;
		out[2] = (payload.length >> 8) & 0xff;
		out[3] = (payload.length >> 16) & 0xff;
		out[4] = (payload.length >> 24) & 0xff;
		out.set(payload, 5);
		return out;
	}

	/** Serve `bytes` through a body reader that hands out `sliceSize` at a time. */
	function bodyOf(bytes: Uint8Array, sliceSize = 7): Response {
		let offset = 0;
		return {
			ok: true,
			body: {
				getReader: () => ({
					read: async () => {
						if (offset >= bytes.length) return { done: true, value: undefined };
						const value = bytes.slice(offset, offset + sliceSize);
						offset += value.length;
						return { done: false, value };
					},
					releaseLock: () => {},
				}),
			},
		} as unknown as Response;
	}

	it("reassembles split frames and yields DATA payloads in order", async () => {
		const bytes = new Uint8Array([
			...frame(0x01, new Uint8Array([1, 2, 3])),
			...frame(0x01, new Uint8Array([4, 5])),
			...frame(0x00, new Uint8Array()),
		]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(bytes)));
		const chunks: number[][] = [];
		for await (const chunk of streamSynthesizeAudio("hi")) {
			if (chunk.kind !== "wav") throw new Error("Expected WAV fixture");
			chunks.push([...new Uint8Array(await chunk.blob.arrayBuffer())]);
		}
		expect(chunks).toEqual([
			[1, 2, 3],
			[4, 5],
		]);
	});

	it("raises the upstream's message on an ERR frame", async () => {
		const bytes = frame(0x80, new TextEncoder().encode("synthesis failed"));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(bytes)));
		await expect(streamSynthesizeAudio("hi").next()).rejects.toThrow("synthesis failed");
	});

	it("refuses an oversized frame length instead of buffering it", async () => {
		// 4 GiB - 1: the largest a uint32 length field can claim.
		const header = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(header)));
		await expect(streamSynthesizeAudio("hi").next()).rejects.toThrow(/frame too large/);
	});

	it("raises when the stream stops without an END frame (a truncated reply)", async () => {
		const bytes = frame(0x01, new Uint8Array([9]));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(bytes)));
		const chunks: number[][] = [];
		await expect(async () => {
			for await (const chunk of streamSynthesizeAudio("hi")) {
				if (chunk.kind !== "wav") throw new Error("Expected WAV fixture");
				chunks.push([...new Uint8Array(await chunk.blob.arrayBuffer())]);
			}
		}).rejects.toThrow(/END frame/);
		// The chunk that did arrive was still delivered before the error.
		expect(chunks).toEqual([[9]]);
	});

	it("raises when the stream stops in the middle of a frame", async () => {
		const bytes = frame(0x01, new Uint8Array([1, 2, 3])).subarray(0, 7);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(bytes)));
		await expect(streamSynthesizeAudio("hi").next()).rejects.toThrow(/mid-frame/);
	});

	it("sends text and speed in the request body", async () => {
		const fetchMock = vi.fn().mockResolvedValue(bodyOf(frame(0x00, new Uint8Array())));
		vi.stubGlobal("fetch", fetchMock);
		await streamSynthesizeAudio("hello", undefined, 1.25).next();
		expect(fetchMock).toHaveBeenCalledWith("/api/tts/stream", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello", speed: 1.25 }),
			signal: undefined,
		});
	});

	it("yields raw PCM16 frames directly when X-Audio-Format is pcm16", async () => {
		const pcm1 = new Uint8Array([0, 0, 255, 127]);
		const pcm2 = new Uint8Array([0, 128, 0, 0]);
		const bytes = new Uint8Array([
			...frame(0x01, pcm1),
			...frame(0x01, new Uint8Array()),
			...frame(0x01, pcm2),
			...frame(0x00, new Uint8Array()),
		]);
		const res = bodyOf(bytes) as unknown as { headers: Headers };
		res.headers = new Headers({
			"X-Audio-Format": "pcm16",
			"X-Audio-Sample-Rate": "44100",
			"X-Audio-Channels": "1",
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
		const out: Array<{ kind: string; sampleRate?: number; pcm?: number[] }> = [];
		for await (const chunk of streamSynthesizeAudio("hi")) {
			out.push(
				chunk.kind === "pcm16"
					? { kind: chunk.kind, sampleRate: chunk.sampleRate, pcm: [...chunk.pcm] }
					: { kind: chunk.kind },
			);
		}
		expect(out).toEqual([
			{ kind: "pcm16", sampleRate: 44100, pcm: [0, 0, 255, 127] },
			{ kind: "pcm16", sampleRate: 44100, pcm: [0, 128, 0, 0] },
		]);
	});

	it("falls back to WAV frames when X-Audio-Format is absent", async () => {
		const bytes = new Uint8Array([
			...frame(0x01, new Uint8Array([1, 2, 3])),
			...frame(0x00, new Uint8Array()),
		]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(bytes)));
		const out: Array<{ kind: string; bytes?: number[] }> = [];
		for await (const chunk of streamSynthesizeAudio("hi")) {
			out.push(
				chunk.kind === "wav"
					? { kind: chunk.kind, bytes: [...new Uint8Array(await chunk.blob.arrayBuffer())] }
					: { kind: chunk.kind },
			);
		}
		expect(out).toEqual([{ kind: "wav", bytes: [1, 2, 3] }]);
	});

	it("rejects invalid PCM16 stream headers or odd-length PCM16 payloads", async () => {
		const badHeaders = bodyOf(frame(0x00, new Uint8Array())) as unknown as { headers: Headers };
		badHeaders.headers = new Headers({
			"X-Audio-Format": "pcm16",
			"X-Audio-Sample-Rate": "0",
			"X-Audio-Channels": "1",
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(badHeaders));
		await expect(async () => {
			for await (const _ of streamSynthesizeAudio("hi")) {
				/* nothing */
			}
		}).rejects.toThrow(/PCM16 audio headers/);

		const oddPcm = bodyOf(
			new Uint8Array([...frame(0x01, new Uint8Array([1, 2, 3])), ...frame(0x00, new Uint8Array())]),
		) as unknown as { headers: Headers };
		oddPcm.headers = new Headers({
			"X-Audio-Format": "pcm16",
			"X-Audio-Sample-Rate": "44100",
			"X-Audio-Channels": "1",
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oddPcm));
		await expect(async () => {
			for await (const _ of streamSynthesizeAudio("hi")) {
				/* nothing */
			}
		}).rejects.toThrow(/incomplete sample/);
	});
});

describe("decodePcm16Samples", () => {
	it("converts little-endian Int16 PCM bytes (including unaligned slices) to [-1, 1) Float32", () => {
		const padded = new Uint8Array([99, 0, 0, 0, 128, 255, 127]);
		const slice = padded.subarray(1); // offset 1: unaligned byteOffset
		const samples = decodePcm16Samples(slice);
		expect(samples.length).toBe(3);
		expect(samples[0]).toBe(0);
		expect(samples[1]).toBe(-1);
		expect(samples[2]).toBeCloseTo(32767 / 32768, 6);
		expect(() => decodePcm16Samples(new Uint8Array([1, 2, 3]))).toThrow(/incomplete sample/);
	});
});
