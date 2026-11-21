import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KOKORO_ALIGNMENT, ZONOS3_ALIGNMENT, ZONOS3_SAMPLE_RATE } from "../src/shared/kokoro.js";

vi.stubEnv("ZONOS_TTFB_TIMEOUT_MS", "100");
const { createTtsRouter } = await import("../src/server/tts.js");
vi.unstubAllEnvs();

const realFetch = globalThis.fetch;
let server: Server;
let base = "";
beforeAll(async () => {
	const app = express();
	app.use(express.json());
	app.use("/api/tts", createTtsRouter());
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("TTS first-chunk deadline", () => {
	it.each([
		"relay-stream",
		"stream",
		"",
	])("rejects headers followed by silence on /api/tts/%s", async (route) => {
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				signal = init.signal ?? undefined;
				return new Response(
					new ReadableStream({
						start(controller) {
							signal?.addEventListener(
								"abort",
								() => controller.error(new Error("body read aborted")),
								{ once: true },
							);
						},
					}),
					{
						headers: {
							"X-Kokoro-Alignment": KOKORO_ALIGNMENT,
							"X-Zonos-Alignment": ZONOS3_ALIGNMENT,
							"X-Audio-Format": "pcm16",
							"X-Audio-Sample-Rate": String(ZONOS3_SAMPLE_RATE),
							"X-Audio-Channels": "1",
						},
					},
				);
			}),
		);
		const response = await realFetch(`${base}/api/tts/${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "Hello." }),
			signal: AbortSignal.timeout(2500),
		});
		expect(response.status).toBe(504);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("no first chunk"),
		});
		expect(signal?.aborted).toBe(true);
	});

	it("does not cut off a healthy Relay stream after its first bytes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_url: string, init: RequestInit) =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(Uint8Array.of(1));
								setTimeout(() => {
									if (init.signal?.aborted) controller.error(new Error("stream cut off"));
									else {
										controller.enqueue(Uint8Array.of(2));
										controller.close();
									}
								}, 150);
							},
						}),
						{ headers: { "X-Kokoro-Alignment": KOKORO_ALIGNMENT } },
					),
			),
		);
		const response = await realFetch(`${base}/api/tts/relay-stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "Hello." }),
		});
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(1, 2));
	});
});

describe("Relay-only aligned TTS byte pipe", () => {
	it("negotiates alignment upstream and echoes the version, without interpreting frames", async () => {
		const bytes = new Uint8Array([2, 2, 0, 0, 0, 123, 125, 0, 0, 0, 0, 0]);
		const upstream = vi.fn(
			async () => new Response(bytes, { headers: { "X-Kokoro-Alignment": KOKORO_ALIGNMENT } }),
		);
		vi.stubGlobal("fetch", upstream);
		const response = await realFetch(`${base}/api/tts/relay-stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "Hello world.", speed: 1 }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Kokoro-Alignment")).toBe(KOKORO_ALIGNMENT);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		expect(upstream.mock.calls[0]).toMatchObject([
			expect.stringContaining("/tts/stream"),
			{ headers: { "X-Kokoro-Alignment": KOKORO_ALIGNMENT } },
		]);
	});

	it("preserves legacy Kokoro streaming without requesting alignment", async () => {
		const upstream = vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 0, 0])));
		vi.stubGlobal("fetch", upstream);
		const response = await realFetch(`${base}/api/tts/kokoro-stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Kokoro-Alignment": KOKORO_ALIGNMENT },
			body: JSON.stringify({ text: "Hello." }),
		});
		expect(response.status).toBe(200);
		await response.arrayBuffer();
		expect(response.headers.has("X-Kokoro-Alignment")).toBe(false);
		const options = (upstream.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(options.headers).toEqual({ "Content-Type": "application/json" });
	});

	it("fails with JSON before playback when the backend cannot negotiate timestamps", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 0, 0]))),
		);
		const response = await realFetch(`${base}/api/tts/relay-stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "Hello." }),
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("no speech fallback"),
		});
	});

	it("negotiates ZONOS3-Mini alignment upstream on /api/tts/zonos-relay-stream and forwards bytes", async () => {
		const bytes = new Uint8Array([2, 2, 0, 0, 0, 123, 125, 0, 0, 0, 0, 0]);
		const upstream = vi.fn(
			async () => new Response(bytes, { headers: { "X-Zonos-Alignment": ZONOS3_ALIGNMENT } }),
		);
		vi.stubGlobal("fetch", upstream);
		const response = await realFetch(`${base}/api/tts/zonos-relay-stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "Hello Zonos.", speed: 1.5 }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Zonos-Alignment")).toBe(ZONOS3_ALIGNMENT);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("8184/tts/stream");
		expect(init.headers).toEqual({
			"Content-Type": "application/json",
			"X-Zonos-Alignment": ZONOS3_ALIGNMENT,
		});
		expect(JSON.parse(init.body as string)).toEqual({ text: "Hello Zonos.", speed: 1.5 });
	});

	it("rejects out-of-range speed on /api/tts/zonos-relay-stream with 400 before calling upstream", async () => {
		const upstream = vi.fn();
		vi.stubGlobal("fetch", upstream);
		const response = await realFetch(`${base}/api/tts/zonos-relay-stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "Hello Zonos.", speed: 2.5 }),
		});
		expect(response.status).toBe(400);
		expect(upstream).not.toHaveBeenCalled();
	});

	it("fails closed with 502 when ZONOS3-Mini omits alignment header", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 0, 0]))),
		);
		const response = await realFetch(`${base}/api/tts/zonos-relay-stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "Hello." }),
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("no speech fallback"),
		});
	});
});
