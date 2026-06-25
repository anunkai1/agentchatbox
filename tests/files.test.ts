/**
 * files.ts — GET /api/file?path=<absolute path>
 *
 * Verifies the route serves files inside the agent project dir (piCwd),
 * refuses paths that escape it, and sets headers that force a download.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// config reads PI_CWD at module-eval time, so set it before the import.
const tmp = await mkdtemp(join(tmpdir(), "acb-files-"));
process.env.PI_CWD = tmp;

const { createFilesRouter } = await import("../src/server/files.js");

let server: Server | null = null;
let base = "";

beforeEach(() => {
	const app = express();
	app.use("/api/file", createFilesRouter());
	server = createServer(app);
	return new Promise<void>((resolve) => {
		server!.listen(0, "127.0.0.1", () => {
			const addr = server!.address();
			if (addr && typeof addr === "object") base = `http://127.0.0.1:${addr.port}`;
			resolve();
		});
	});
});

afterEach(() => {
	if (server)
		return new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe("GET /api/file", () => {
	it("serves a file inside piCwd with attachment headers", async () => {
		await writeFile(join(tmp, "hello.txt"), "hi there");
		const res = await fetch(
			`${base}/api/file?path=${encodeURIComponent(join(tmp, "hello.txt"))}`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("attachment");
		expect(await res.text()).toBe("hi there");
	});

	it("resolves a relative path against piCwd", async () => {
		await writeFile(join(tmp, "rel.txt"), "rel");
		const res = await fetch(`${base}/api/file?path=rel.txt`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("rel");
	});

	it("refuses paths outside piCwd (path traversal)", async () => {
		const res = await fetch(`${base}/api/file?path=/etc/passwd`);
		expect(res.status).toBe(403);
	});

	it("refuses ../ escape from piCwd", async () => {
		const res = await fetch(`${base}/api/file?path=${encodeURIComponent("../evil")}`);
		expect(res.status).toBe(403);
	});

	it("returns 400 for a missing path query", async () => {
		const res = await fetch(`${base}/api/file`);
		expect(res.status).toBe(400);
	});

	it("returns 404 for a nonexistent file", async () => {
		const res = await fetch(
			`${base}/api/file?path=${encodeURIComponent(join(tmp, "nope.txt"))}`,
		);
		expect(res.status).toBe(404);
	});
});
