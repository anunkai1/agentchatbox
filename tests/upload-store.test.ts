import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UploadQuotaError, UploadStore } from "../src/server/upload-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "acb-upload-store-"));
	roots.push(value);
	return value;
}

describe("UploadStore", () => {
	it("reserves pessimistically so concurrent uploads cannot cross quota", () => {
		const dir = root();
		const store = new UploadStore(dir, 60, 100);
		const first = store.reserve();
		expect(() => store.reserve()).toThrow(UploadQuotaError);
		store.cancel(first);
		expect(store.reserve()).toBeTruthy();
	});

	it("counts extension-created files and publishes private files atomically", () => {
		const dir = root();
		writeFileSync(join(dir, "extension-output.png"), Buffer.alloc(20));
		const store = new UploadStore(dir, 60, 100);
		expect(store.usage()).toMatchObject({ bytes: 20, files: 1, quotaBytes: 100 });
		const token = store.reserve();
		const temp = join(store.tempDir, "part");
		writeFileSync(temp, "hello");
		const filename = store.publish(token, temp, ".txt");
		expect(readFileSync(join(dir, filename), "utf8")).toBe("hello");
		expect(statSync(join(dir, filename)).mode & 0o777).toBe(0o600);
	});

	it("removes abandoned staging files on startup", () => {
		const dir = root();
		const temp = join(dir, ".tmp");
		mkdirSync(temp);
		writeFileSync(join(temp, "abandoned.part"), "partial");
		new UploadStore(dir, 50, 100);
		expect(existsSync(join(temp, "abandoned.part"))).toBe(false);
	});
});
