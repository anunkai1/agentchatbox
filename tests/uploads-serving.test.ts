import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/server/config.js";
import {
	createUploadsServingRouter,
	parseByteRange,
	safeInlineMime,
	safeInlineVideoMime,
} from "../src/server/uploads-serving.js";

const originalUploadsDir = config.uploadsDir;
let server: Server | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
	config.uploadsDir = originalUploadsDir;
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = null;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeMp4Payload(): Buffer {
	// Minimal ftyp box (isom) + dummy mdat bytes
	const ftyp = Buffer.from([
		0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
		0x69, 0x73, 0x6f, 0x6d,
	]);
	const mdat = Buffer.from("0123456789abcdef", "ascii");
	return Buffer.concat([ftyp, mdat]);
}

function makeMovPayload(): Buffer {
	return Buffer.from([
		0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x02, 0x00,
		0x71, 0x74, 0x20, 0x20,
	]);
}

function makeWebmPayload(): Buffer {
	return Buffer.concat([
		Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]),
		Buffer.from("webm", "ascii"),
	]);
}

async function startServing(files: Record<string, Buffer | string>): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "acb-uploads-serving-"));
	tempDirs.push(dir);
	for (const [name, data] of Object.entries(files)) {
		writeFileSync(join(dir, name), data);
	}
	config.uploadsDir = dir;
	const app = express();
	app.use("/uploads", createUploadsServingRouter());
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing test address");
	return `http://127.0.0.1:${address.port}/uploads`;
}

describe("safeInlineVideoMime", () => {
	it("accepts magic-matching mp4, mov, and webm files", () => {
		expect(safeInlineVideoMime("clip.mp4", makeMp4Payload())).toBe("video/mp4");
		expect(safeInlineVideoMime("clip.MOV", makeMovPayload())).toBe("video/quicktime");
		expect(safeInlineVideoMime("clip.webm", makeWebmPayload())).toBe("video/webm");
		expect(safeInlineMime("clip.mp4", makeMp4Payload())).toBe("video/mp4");
	});

	it("rejects mismatched extensions, spoofed payloads, and non-webm matroska", () => {
		expect(safeInlineVideoMime("spoof.mp4", Buffer.from("<script>alert(1)</script>"))).toBeNull();
		expect(safeInlineVideoMime("qt-as-mp4.mp4", makeMovPayload())).toBeNull();
		expect(safeInlineVideoMime("mp4-as-mov.mov", makeMp4Payload())).toBeNull();
		const avif = Buffer.from([
			0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
		]);
		expect(safeInlineVideoMime("avif-as-mp4.mp4", avif)).toBeNull();
		const mkv = Buffer.concat([
			Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]),
			Buffer.from("matroska", "ascii"),
		]);
		expect(safeInlineVideoMime("mkv-as-webm.webm", mkv)).toBeNull();
	});
});

describe("parseByteRange", () => {
	it("parses closed, open-ended, and suffix ranges", () => {
		expect(parseByteRange("bytes=0-7", 36)).toEqual({ start: 0, end: 7 });
		expect(parseByteRange("bytes=10-", 36)).toEqual({ start: 10, end: 35 });
		expect(parseByteRange("bytes=-6", 36)).toEqual({ start: 30, end: 35 });
		expect(parseByteRange("bytes=0-999", 36)).toEqual({ start: 0, end: 35 });
	});

	it("flags unsatisfiable ranges and ignores multi/invalid ranges", () => {
		expect(parseByteRange("bytes=36-", 36)).toBe("unsatisfiable");
		expect(parseByteRange("bytes=10-5", 36)).toBe("unsatisfiable");
		expect(parseByteRange("bytes=0-1", 0)).toBe("unsatisfiable");
		expect(parseByteRange("bytes=0-1, 4-5", 36)).toBeNull();
		expect(parseByteRange(undefined, 36)).toBeNull();
	});
});

describe("uploads serving video + Range", () => {
	it("serves valid mp4 inline with Accept-Ranges and supports 206 byte seeks", async () => {
		const payload = makeMp4Payload();
		const baseUrl = await startServing({
			"clip.mp4": payload,
			"fake.mp4": "not an mp4",
		});

		const full = await fetch(`${baseUrl}/clip.mp4`);
		expect(full.status).toBe(200);
		expect(full.headers.get("content-type")).toBe("video/mp4");
		expect(full.headers.get("content-disposition")).toBe("inline");
		expect(full.headers.get("accept-ranges")).toBe("bytes");
		expect(full.headers.get("x-content-type-options")).toBe("nosniff");
		expect(full.headers.get("content-security-policy")).toContain("sandbox");
		expect(full.headers.get("content-length")).toBe(String(payload.length));
		expect(Buffer.from(await full.arrayBuffer())).toEqual(payload);

		const partial = await fetch(`${baseUrl}/clip.mp4`, {
			headers: { Range: "bytes=4-15" },
		});
		expect(partial.status).toBe(206);
		expect(partial.headers.get("content-type")).toBe("video/mp4");
		expect(partial.headers.get("accept-ranges")).toBe("bytes");
		expect(partial.headers.get("content-range")).toBe(`bytes 4-15/${payload.length}`);
		expect(partial.headers.get("content-length")).toBe("12");
		expect(Buffer.from(await partial.arrayBuffer())).toEqual(payload.subarray(4, 16));

		const suffix = await fetch(`${baseUrl}/clip.mp4`, {
			headers: { Range: "bytes=-4" },
		});
		expect(suffix.status).toBe(206);
		expect(suffix.headers.get("content-range")).toBe(
			`bytes ${payload.length - 4}-${payload.length - 1}/${payload.length}`,
		);
		expect(Buffer.from(await suffix.arrayBuffer())).toEqual(payload.subarray(payload.length - 4));

		const invalid = await fetch(`${baseUrl}/clip.mp4`, {
			headers: { Range: "bytes=9999-" },
		});
		expect(invalid.status).toBe(416);
		expect(invalid.headers.get("content-range")).toBe(`bytes */${payload.length}`);

		const head = await fetch(`${baseUrl}/clip.mp4`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toBe("video/mp4");
		expect(head.headers.get("accept-ranges")).toBe("bytes");

		const spoof = await fetch(`${baseUrl}/fake.mp4`);
		expect(spoof.status).toBe(200);
		expect(spoof.headers.get("content-type")).toBe("application/octet-stream");
		expect(spoof.headers.get("content-disposition")).toBe('attachment; filename="fake.mp4"');
	});
});
