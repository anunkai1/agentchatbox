import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTtsRouter } from "../src/server/tts.js";
import { KOKORO_ALIGNMENT, ZONOS3_ALIGNMENT } from "../src/shared/kokoro.js";

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

	it("leaves ordinary chat streaming unchanged even if a caller sends an alignment header", async () => {
		const upstream = vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 0, 0])));
		vi.stubGlobal("fetch", upstream);
		const response = await realFetch(`${base}/api/tts/stream`, {
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
