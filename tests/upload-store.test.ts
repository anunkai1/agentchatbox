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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	UPLOAD_RESERVATION_PREFIX,
	UploadQuotaError,
	UploadStore,
} from "../src/server/upload-store.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
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

	it("counts an independent live writer's reservation before admitting HTTP", () => {
		const dir = root();
		const store = new UploadStore(dir, 60, 100);
		writeFileSync(
			join(dir, `${UPLOAD_RESERVATION_PREFIX}${process.pid}-extension`),
			Buffer.alloc(50),
		);
		expect(store.usage()).toMatchObject({ bytes: 0, files: 0, reservedBytes: 50 });
		expect(() => store.reserve()).toThrow(UploadQuotaError);
	});

	it("removes a dead writer's unique reservation without a shared lock", () => {
		const dir = root();
		const store = new UploadStore(dir, 60, 100);
		writeFileSync(join(dir, `${UPLOAD_RESERVATION_PREFIX}2147483647-dead`), Buffer.alloc(60));
		expect(store.reserve()).toBeTruthy();
		expect(readdirSync(dir).some((name) => name.includes("2147483647-dead"))).toBe(false);
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

	it("does not touch configured storage when store/router modules are imported", async () => {
		const dir = root();
		mkdirSync(join(dir, ".tmp"));
		const staging = join(dir, ".tmp", "active.part");
		const claim = join(dir, `${UPLOAD_RESERVATION_PREFIX}${process.pid}-active`);
		writeFileSync(staging, "partial");
		writeFileSync(claim, "claim");
		vi.stubEnv("UPLOADS_DIR", dir);
		vi.resetModules();
		await import("../src/server/upload-store.js");
		await import("../src/server/uploads.js");
		expect(readFileSync(staging, "utf8")).toBe("partial");
		expect(readFileSync(claim, "utf8")).toBe("claim");
	});

	it("preserves staging on construction; explicit boot recovery removes only dead claims", () => {
		const dir = root();
		const temp = join(dir, ".tmp");
		mkdirSync(temp);
		const staging = join(temp, "abandoned.part");
		const dead = join(dir, `${UPLOAD_RESERVATION_PREFIX}2147483647-dead`);
		const live = join(dir, `${UPLOAD_RESERVATION_PREFIX}${process.pid}-live`);
		writeFileSync(staging, "partial");
		writeFileSync(dead, "dead");
		writeFileSync(live, "live");
		const store = new UploadStore(dir, 50, 100);
		expect(existsSync(staging)).toBe(true);
		expect(existsSync(dead)).toBe(true);
		expect(existsSync(live)).toBe(true);
		store.recoverAbandonedUploads();
		expect(existsSync(staging)).toBe(false);
		expect(existsSync(dead)).toBe(false);
		expect(readFileSync(live, "utf8")).toBe("live");
	});

	it("releases the claim when a quota scan throws, allowing the next upload", () => {
		const dir = root();
		const store = new UploadStore(dir, 60, 100);
		const error = new Error("upload directory changed too quickly to calculate quota safely");
		// Fault-inject the scan boundary after the real sparse claim is created.
		vi.spyOn(
			store as unknown as { scanAllocation(): unknown },
			"scanAllocation",
		).mockImplementationOnce(() => {
			throw error;
		});
		expect(() => store.reserve()).toThrow(error);
		expect(store.usage().reservedBytes).toBe(0);
		expect(readdirSync(dir).filter((name) => name.startsWith(UPLOAD_RESERVATION_PREFIX))).toEqual(
			[],
		);
		const token = store.reserve();
		expect(store.usage().reservedBytes).toBe(60);
		store.cancel(token);
	});
});
