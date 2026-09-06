import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectPromptImageMime, resolvePromptImages } from "../src/server/prompt-images.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "acb-prompt-images-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("prompt image upload references", () => {
	it("detects common raster magic without trusting a filename", () => {
		expect(detectPromptImageMime(Buffer.from("89504e470d0a1a0a", "hex"))).toBe("image/png");
		expect(detectPromptImageMime(Buffer.from("ffd8ffe000104a464946", "hex"))).toBe("image/jpeg");
		expect(detectPromptImageMime(Buffer.from("plain text"))).toBeNull();
	});

	it("reads an uploaded raster into pi ImageContent", async () => {
		const dir = tempDir();
		const bytes = Buffer.concat([
			Buffer.from("89504e470d0a1a0a", "hex"),
			Buffer.from("bounded-test-image"),
		]);
		writeFileSync(join(dir, "camera.png"), bytes, { mode: 0o600 });

		await expect(resolvePromptImages([{ url: "/uploads/camera.png" }], dir)).resolves.toEqual([
			{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
		]);
	});

	it("keeps legacy inline images working across a rolling deploy", async () => {
		await expect(
			resolvePromptImages([{ data: "AQ==", mimeType: "image/png" }], tempDir()),
		).resolves.toEqual([{ type: "image", data: "AQ==", mimeType: "image/png" }]);
	});

	it("rejects image sets that exceed the combined prompt limit", async () => {
		const dir = tempDir();
		const bytes = (size: number) =>
			Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(size)]);
		writeFileSync(join(dir, "one.jpg"), bytes(17 * 1024 * 1024), { mode: 0o600 });
		writeFileSync(join(dir, "two.jpg"), bytes(17 * 1024 * 1024), { mode: 0o600 });

		await expect(
			resolvePromptImages(
				[{ url: "/uploads/one.jpg" }, { url: "/uploads/two.jpg" }],
				dir,
			),
		).rejects.toThrow("32 MiB combined prompt limit");
	});

	it("rejects missing, non-raster, and symlink upload references", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "notes.jpg"), "not an image", { mode: 0o600 });
		writeFileSync(join(dir, "real.jpg"), Buffer.from("ffd8ffe000104a464946", "hex"), {
			mode: 0o600,
		});
		symlinkSync(join(dir, "real.jpg"), join(dir, "linked.jpg"));

		await expect(resolvePromptImages([{ url: "/uploads/missing.jpg" }], dir)).rejects.toThrow(
			"no longer available",
		);
		await expect(resolvePromptImages([{ url: "/uploads/notes.jpg" }], dir)).rejects.toThrow(
			"supported raster",
		);
		await expect(resolvePromptImages([{ url: "/uploads/linked.jpg" }], dir)).rejects.toThrow(
			"no longer available",
		);
	});
});
