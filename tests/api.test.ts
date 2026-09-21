import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionExists, streamSynthesizeSpeech } from "../src/client/api.js";

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
 * streamSynthesizeSpeech — the /api/tts/stream frame parser.
 *
 * The body is a binary frame stream ([1 byte type][uint32 LE length][payload])
 * and the client only ever sees what the local pi-voice-server sends, but the
 * parser is the one place where a malformed length field could make the browser
 * buffer gigabytes, so its framing rules are pinned here: partial reads must be
 * reassembled, DATA frames yield in order, END ends cleanly, ERR raises, and an
 * absurd frame length is refused instead of allocated.
 */
describe("streamSynthesizeSpeech", () => {
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
		for await (const blob of streamSynthesizeSpeech("hi")) {
			chunks.push([...new Uint8Array(await blob.arrayBuffer())]);
		}
		expect(chunks).toEqual([
			[1, 2, 3],
			[4, 5],
		]);
	});

	it("raises the upstream's message on an ERR frame", async () => {
		const bytes = frame(0x80, new TextEncoder().encode("kokoro exploded"));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(bytes)));
		await expect(async () => {
			for await (const _ of streamSynthesizeSpeech("hi")) {
				/* nothing */
			}
		}).rejects.toThrow("kokoro exploded");
	});

	it("refuses an oversized frame length instead of buffering it", async () => {
		// 4 GiB - 1: the largest a uint32 length field can claim.
		const header = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(header)));
		await expect(async () => {
			for await (const _ of streamSynthesizeSpeech("hi")) {
				/* nothing */
			}
		}).rejects.toThrow(/frame too large/);
	});

	it("ends cleanly when the stream stops without an END frame", async () => {
		const bytes = frame(0x01, new Uint8Array([9]));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyOf(bytes)));
		const chunks: number[][] = [];
		for await (const blob of streamSynthesizeSpeech("hi")) {
			chunks.push([...new Uint8Array(await blob.arrayBuffer())]);
		}
		expect(chunks).toEqual([[9]]);
	});

	it("sends text, voice and speed in the request body", async () => {
		const fetchMock = vi.fn().mockResolvedValue(bodyOf(new Uint8Array()));
		vi.stubGlobal("fetch", fetchMock);
		for await (const _ of streamSynthesizeSpeech("hello", "af_heart", undefined, 1.25)) {
			/* nothing */
		}
		expect(fetchMock).toHaveBeenCalledWith("/api/tts/stream", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello", voice: "af_heart", speed: 1.25 }),
			signal: undefined,
		});
	});
});
