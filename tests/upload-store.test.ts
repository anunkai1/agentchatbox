import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	UPLOAD_RESERVATION_PREFIX,
	UploadQuotaError,
	UploadStore,
} from "../src/server/upload-store.js";

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
		const reservation = readdirSync(dir).find((name) => name.startsWith(UPLOAD_RESERVATION_PREFIX));
		expect(reservation).toBeTruthy();
		expect(statSync(join(dir, reservation!)).size).toBe(60);
		expect(() => store.reserve()).toThrow(UploadQuotaError);
		store.cancel(first);
		expect(readdirSync(dir).some((name) => name.startsWith(UPLOAD_RESERVATION_PREFIX))).toBe(false);
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

	it("removes abandoned staging and sparse reservation files on startup", () => {
		const dir = root();
		const temp = join(dir, ".tmp");
		mkdirSync(temp);
		writeFileSync(join(temp, "abandoned.part"), "partial");
		writeFileSync(join(dir, `${UPLOAD_RESERVATION_PREFIX}stale`), "reservation");
		new UploadStore(dir, 50, 100);
		expect(existsSync(join(temp, "abandoned.part"))).toBe(false);
		expect(readdirSync(dir).some((name) => name.startsWith(UPLOAD_RESERVATION_PREFIX))).toBe(false);
	});
});
