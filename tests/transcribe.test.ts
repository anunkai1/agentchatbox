import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createTranscribeRouter, sttChain } from "../src/server/transcribe.js";

const originalPrimary = process.env.STT_PRIMARY_URL;
const originalFallback = process.env.STT_FALLBACK_URL;

/**
 * Mock only the fake daemon hosts (*.test:*); requests to the real local
 * express listener pass through to the actual fetch, so the route handler
 * genuinely runs.
 */
function stubDaemonFetch(
	handler: (url: string) => Promise<Response> | Response,
): ReturnType<typeof vi.spyOn> {
	const real = globalThis.fetch.bind(globalThis);
	return vi.spyOn(globalThis, "fetch").mockImplementation((input: any, init?: any) => {
		const url = typeof input === "string" ? input : String(input?.url ?? input);
		if (/\.test:\d+/.test(url)) {
			return Promise.resolve(handler(url));
		}
		return real(input, init);
	});
}

function listen(app: express.Express): Promise<string> {
	return new Promise((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`);
		});
	});
}

async function postAudio(base: string, body: Buffer): Promise<Response> {
	const form = new FormData();
	form.append("audio", new Blob([new Uint8Array(body)]), "voice.webm");
	return fetch(`${base}/api/transcribe`, { method: "POST", body: form });
}

describe("transcribe router", () => {
	let app: express.Express;
	let base: string;

	beforeEach(() => {
		process.env.STT_PRIMARY_URL = "http://primary.test:9991";
		process.env.STT_FALLBACK_URL = "http://fallback.test:9992";
		app = express();
		app.use(express.json());
		app.use("/api/transcribe", createTranscribeRouter());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalPrimary === undefined) delete process.env.STT_PRIMARY_URL;
		else process.env.STT_PRIMARY_URL = originalPrimary;
		if (originalFallback === undefined) delete process.env.STT_FALLBACK_URL;
		else process.env.STT_FALLBACK_URL = originalFallback;
	});

	it("sttChain orders primary then fallback and skips an identical fallback", () => {
		expect(sttChain().map((c) => c.name)).toEqual(["primary", "fallback"]);
		process.env.STT_FALLBACK_URL = "http://primary.test:9991";
		expect(sttChain().map((c) => c.name)).toEqual(["primary"]);
		process.env.STT_FALLBACK_URL = "";
		expect(sttChain().map((c) => c.name)).toEqual(["primary"]);
	});

	it("returns the primary daemon's transcript", async () => {
		const mock = stubDaemonFetch(() =>
			new Response(JSON.stringify({ text: "hello", engine: "whisper" }), { status: 200 }),
		);
		base = await listen(app);
		const resp = await postAudio(base, Buffer.from("audio"));
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ text: "hello" });
		// One daemon POST (the spy also sees the test's own POST, hence 2); the
		// daemon URL must have received the raw bytes.
		expect(mock).toHaveBeenCalledTimes(2);
		const daemonCalls = mock.mock.calls.filter((c) => String(c[0]).includes(".test:"));
		expect(daemonCalls.length).toBe(1);
		expect(String(daemonCalls[0]?.[0])).toBe("http://primary.test:9991/transcribe");
	});

	it("falls back when the primary daemon is unreachable", async () => {
		const mock = stubDaemonFetch((url) => {
			if (url.startsWith("http://primary.test")) {
				throw new Error("ECONNREFUSED");
			}
			return new Response(JSON.stringify({ text: "from fallback", engine: "qwen3_asr" }), {
				status: 200,
			});
		});
		base = await listen(app);
		const resp = await postAudio(base, Buffer.from("audio"));
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ text: "from fallback" });
		expect(mock).toHaveBeenCalledTimes(3);
	});

	it("502s when both daemons fail", async () => {
		stubDaemonFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		base = await listen(app);
		const resp = await postAudio(base, Buffer.from("audio"));
		expect(resp.status).toBe(502);
		const body = (await resp.json()) as { error?: string };
		expect(body.error).toContain("all stt daemons failed");
	});

	it("400s without an audio field", async () => {
		base = await listen(app);
		const resp = await fetch(`${base}/api/transcribe`, { method: "POST", body: "x" });
		expect(resp.status).toBe(400);
	});
});
