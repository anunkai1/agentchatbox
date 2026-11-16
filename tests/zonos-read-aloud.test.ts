import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkTtsAvailable, createTtsRouter } from "../src/server/tts.js";
import { audioFrame, pcmWav, zonosPcm } from "../src/server/zonos-audio.js";
import { ZONOS3_ALIGNMENT } from "../src/shared/kokoro.js";

const realFetch = globalThis.fetch;
const headers = {
	"X-Zonos-Alignment": ZONOS3_ALIGNMENT,
	"X-Audio-Sample-Rate": "44100",
	"X-Audio-Channels": "1",
	"X-Audio-Format": "pcm16",
};
const pcm = new Uint8Array([0, 0, 255, 127, 0, 128, 0, 0]);
const audio = () =>
	Buffer.concat([audioFrame(2, Buffer.from("{}")), audioFrame(1, pcm), audioFrame(0)]);
const response = (bytes = audio()) => new Response(bytes, { headers });
let server: Server;
let base: string;
beforeAll(async () => {
	const app = express();
	app.use(express.json());
	app.use("/api/tts", createTtsRouter());
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tts`;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
const post = (path: string, body: unknown = { text: "Hello.", voice: "af_heart", speed: 1.5 }) =>
	realFetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

describe("ordinary ZONOS3-Mini read-aloud", () => {
	it("forwards progressive PCM16 frames directly, ignores old Kokoro voices and forwards synthesis speed", async () => {
		const upstream = vi.fn(async () => response());
		vi.stubGlobal("fetch", upstream);
		const result = await post("/stream");
		expect(result.status).toBe(200);
		expect(result.headers.get("X-Zonos-Alignment")).toBeNull();
		expect(result.headers.get("X-Audio-Format")).toBe("pcm16");
		expect(result.headers.get("X-Audio-Sample-Rate")).toBe("44100");
		expect(result.headers.get("X-Audio-Channels")).toBe("1");
		expect(Buffer.from(await result.arrayBuffer())).toEqual(
			Buffer.concat([audioFrame(1, pcm), audioFrame(0)]),
		);
		const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("8184/tts/stream");
		expect(init.headers).toMatchObject({ "X-Zonos-Alignment": ZONOS3_ALIGNMENT });
		expect(JSON.parse(init.body as string)).toEqual({
			text: "Hello.",
			voice: "Savannah",
			speed: 1.5,
		});
	});

	it("returns a complete WAV for whole-utterance fallback from the same backend", async () => {
		const upstream = vi.fn(async () =>
			response(Buffer.concat([audioFrame(1, pcm), audioFrame(1, pcm), audioFrame(0)])),
		);
		vi.stubGlobal("fetch", upstream);
		const result = await post("");
		expect(result.status).toBe(200);
		expect(result.headers.get("Content-Type")).toBe("audio/wav");
		expect(Buffer.from(await result.arrayBuffer())).toEqual(pcmWav(Buffer.concat([pcm, pcm])));
		expect(upstream).toHaveBeenCalledTimes(1);
	});

	it("reports the actual voice and a cold but available Zonos backend", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ modelAvailable: true, modelLoaded: false, voice: "Savannah" }),
			),
		);
		expect(await checkTtsAvailable()).toEqual({
			engine: "zonos3",
			available: true,
			voice: "Savannah",
		});
		const result = await realFetch(`${base}/voices`);
		expect(await result.json()).toEqual({ default: "Savannah", available: ["Savannah"] });
	});

	it("rejects missing alignment negotiation without silently speaking with Kokoro", async () => {
		const upstream = vi.fn(async () => new Response(audio()));
		vi.stubGlobal("fetch", upstream);
		const result = await post("/stream");
		expect(result.status).toBe(502);
		expect(await result.json()).toMatchObject({ error: expect.stringContaining("ZONOS3-Mini") });
		expect(upstream).toHaveBeenCalledTimes(1);
	});

	it("surfaces a truncated stream as an error frame, not successful completion", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(audioFrame(1, pcm))),
		);
		const result = await post("/stream");
		const bytes = Buffer.from(await result.arrayBuffer());
		const end = audioFrame(1, pcm).length;
		expect(bytes[end]).toBe(0x80);
		expect(bytes.subarray(end + 5).toString()).toContain("before its END frame");
	});

	it("packs consecutive sentences without splitting the opening comma into one request", async () => {
		const upstream = vi.fn(async () => response());
		vi.stubGlobal("fetch", upstream);
		const text =
			"I checked the Server4 status for you, and the service is running. Everything looks fine. Ready when you are.";
		const result = await post("/stream", { text });
		expect(result.status).toBe(200);
		await result.arrayBuffer();
		expect(upstream).toHaveBeenCalledTimes(1);
		const body = JSON.parse(
			(upstream.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
		);
		expect(body.text).toBe(text);
	});

	it("bounds long replies into packed sequential synthesis requests without dropping prose", async () => {
		const upstream = vi.fn(async () => response());
		vi.stubGlobal("fetch", upstream);
		const text = "A long reply should retain all of its words without exceeding the model budget. "
			.repeat(40)
			.trim();
		const result = await post("/stream", { text });
		expect(result.status).toBe(200);
		await result.arrayBuffer();
		const submitted = upstream.mock.calls.map(
			(call) =>
				JSON.parse((call as unknown as [string, RequestInit])[1].body as string).text as string,
		);
		expect(submitted.length).toBeGreaterThan(1);
		expect(submitted.length).toBeLessThan(15);
		expect(submitted.every((part) => part.length <= 440)).toBe(true);
		expect(submitted.join(" ")).toBe(text);
	});

	it("rejects invalid speed before contacting either backend", async () => {
		const upstream = vi.fn();
		vi.stubGlobal("fetch", upstream);
		for (const path of ["", "/stream"])
			expect((await post(path, { text: "Hello", speed: 4 })).status).toBe(400);
		expect(upstream).not.toHaveBeenCalled();
	});
});

describe("Zonos audio framing", () => {
	it("preserves every sample across arbitrarily fragmented frames and writes correct WAV headers", async () => {
		const bytes = audio();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				controller.close();
			},
		});
		const chunks: Uint8Array[] = [];
		for await (const chunk of zonosPcm(new Response(stream, { headers }))) chunks.push(chunk);
		expect(Buffer.concat(chunks)).toEqual(Buffer.from(pcm));
		const wav = pcmWav(pcm);
		expect(wav.subarray(0, 4).toString()).toBe("RIFF");
		expect(wav.readUInt32LE(24)).toBe(44100);
		expect(wav.readUInt32LE(40)).toBe(pcm.length);
		expect(wav.subarray(44)).toEqual(Buffer.from(pcm));
	});

	it.each([
		["empty audio", audioFrame(0)],
		["partial header", new Uint8Array([1])],
		["partial payload", new Uint8Array([1, 4, 0, 0, 0, 1])],
		["oversized frame", new Uint8Array([1, 255, 255, 255, 127])],
		["odd PCM sample", audioFrame(1, new Uint8Array([1]))],
		["upstream failure", audioFrame(0x80, Buffer.from("backend failed"))],
	])("rejects %s", async (_label, bytes) => {
		await expect(async () => {
			for await (const _chunk of zonosPcm(response(Buffer.from(bytes)))) {
				/* drain */
			}
		}).rejects.toThrow();
	});

	it("cancels the upstream reader when playback stops mid-stream", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(audioFrame(1, pcm));
			},
			cancel,
		});
		const iterator = zonosPcm(new Response(body, { headers }));
		expect((await iterator.next()).value).toEqual(pcm);
		await iterator.return(undefined);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("rejects incompatible audio rather than playing float32 as PCM16", async () => {
		const result = new Response(audio(), { headers: { ...headers, "X-Audio-Format": "float32" } });
		await expect(async () => {
			for await (const _chunk of zonosPcm(result)) {
				/* drain */
			}
		}).rejects.toThrow("mono 44.1 kHz PCM16");
	});
});
