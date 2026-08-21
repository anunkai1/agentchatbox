import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { UploadStore } from "../src/server/upload-store.js";
import { createUploadsRouter } from "../src/server/uploads.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "acb-upload-route-"));
	const store = new UploadStore(root, 1024, 4096);
	const app = express();
	app.use("/api/upload", createUploadsRouter(store));
	app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
		res.status(400).json({ error: error.message });
	});
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(
		() => server.close(),
		() => rmSync(root, { recursive: true, force: true }),
	);
	const { port } = server.address() as AddressInfo;
	return { root, url: `http://127.0.0.1:${port}/api/upload` };
}

describe("upload route", () => {
	it("accepts exactly one ordinary multipart file and publishes it privately", async () => {
		const { root, url } = await fixture();
		const form = new FormData();
		form.append("file", new Blob(["hello upload"], { type: "text/plain" }), "note.txt");

		const response = await fetch(url, { method: "POST", body: form });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { url: string; size: number };
		expect(body.size).toBe(12);
		const filename = body.url.split("/").at(-1)!;
		expect(readFileSync(`${root}/${filename}`, "utf8")).toBe("hello upload");
		expect(statSync(`${root}/${filename}`).mode & 0o777).toBe(0o600);
		expect(readdirSync(root).filter((name) => name.startsWith(".acb-upload-"))).toEqual([]);
	});
});
