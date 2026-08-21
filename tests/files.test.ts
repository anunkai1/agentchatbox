/**
 * files.ts — GET /api/file?path=<absolute path>
 *
 * Verifies the route serves any regular file (the agent is a remote
 * shell behind MFA, so downloads mirror the read/bash tools' full FS
 * access), refuses non-regular files, and sets attachment headers.
 */

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
	if (server) return new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe("GET /api/file", () => {
	it("serves a regular file with attachment headers", async () => {
		await writeFile(join(tmp, "hello.txt"), "hi there");
		const res = await fetch(`${base}/api/file?path=${encodeURIComponent(join(tmp, "hello.txt"))}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("attachment");
		expect(await res.text()).toBe("hi there");
	});

	it("resolves relative tool paths against the supplied session cwd", async () => {
		const project = join(tmp, "project");
		await writeFile(join(tmp, "AGENTS.md"), "global");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "AGENTS.md"), "project");
		const query = new URLSearchParams({ path: "AGENTS.md", cwd: project });
		const res = await fetch(`${base}/api/file?${query}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("project");
	});

	it("serves a file outside piCwd (remote-shell threat model)", async () => {
		// The agent's read/bash tools can read any file on the host; the
		// download endpoint mirrors that rather than refusing on path.
		const res = await fetch(`${base}/api/file?path=/etc/hostname`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("attachment");
		expect((await res.text()).length).toBeGreaterThan(0);
	});

	it("refuses a directory (non-regular file)", async () => {
		const res = await fetch(`${base}/api/file?path=${encodeURIComponent(tmp)}`);
		expect(res.status).toBe(400);
	});

	it("refuses a final-component symlink so validation cannot race the stream", async () => {
		const target = join(tmp, "target.txt");
		const link = join(tmp, "link.txt");
		await writeFile(target, "secret");
		await symlink(target, link);
		const res = await fetch(`${base}/api/file?path=${encodeURIComponent(link)}`);
		expect(res.status).toBe(404);
	});

	it("returns 400 for a missing path query", async () => {
		const res = await fetch(`${base}/api/file`);
		expect(res.status).toBe(400);
	});

	it("returns 404 for a nonexistent file", async () => {
		const res = await fetch(`${base}/api/file?path=${encodeURIComponent(join(tmp, "nope.txt"))}`);
		expect(res.status).toBe(404);
	});
});
