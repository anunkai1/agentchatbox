import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePromptImages } from "../src/server/prompt-images.js";
import { parseClientMessage } from "../src/server/protocol-validation.js";
import type { PromptImage } from "../src/shared/protocol.js";

// Exercise the actual validation/read/encoding paths with byte-sized fixtures.
// Scale production MiB budgets to bytes without changing their ratio/counts.
vi.mock("../src/shared/limits.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/shared/limits.js")>();
	return {
		...actual,
		MAX_PROMPT_IMAGE_BYTES: actual.MAX_PROMPT_IMAGE_BYTES / (1024 * 1024),
		MAX_PROMPT_IMAGE_TOTAL_BYTES: actual.MAX_PROMPT_IMAGE_TOTAL_BYTES / (1024 * 1024),
	};
});

let dir: string;
const bytes = Buffer.alloc(25);
bytes.set([0xff, 0xd8, 0xff]);
const inline: PromptImage = { data: bytes.toString("base64"), mimeType: "image/jpeg" };
const upload: PromptImage = { url: "/uploads/photo.jpg" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "acb-image-budget-"));
	writeFileSync(join(dir, "photo.jpg"), bytes);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function batch(kind: string, count: number): PromptImage[] {
	return Array.from({ length: count }, (_, i) =>
		kind === "inline" || (kind === "mixed" && i % 2 === 0) ? inline : upload,
	);
}

describe("combined image budget", () => {
	it.each(["inline", "upload", "mixed"])("accepts exactly 300 bytes of %s images", async (kind) => {
		const parsed = parseClientMessage({ type: "prompt", text: "look", images: batch(kind, 12) });
		if (parsed.type !== "prompt") throw new Error("expected prompt");
		await expect(resolvePromptImages(parsed.images, dir)).resolves.toHaveLength(12);
	});

	it.each([
		"inline",
		"upload",
		"mixed",
	])("rejects %s images one byte over the total budget", async (kind) => {
		const images = [...batch(kind, 12), { data: "AQ==", mimeType: "image/jpeg" }];
		await expect(resolvePromptImages(images, dir)).rejects.toThrow("combined prompt limit");
	});

	it("rejects uploaded bytes beyond a full inline budget", async () => {
		await expect(resolvePromptImages([...batch("inline", 12), upload], dir)).rejects.toThrow(
			"combined prompt limit",
		);
	});

	it("rejects excess inline bytes during protocol validation", () => {
		expect(() =>
			parseClientMessage({
				type: "prompt",
				text: "look",
				images: [...batch("inline", 12), { data: "AQ==", mimeType: "image/jpeg" }],
			}),
		).toThrow("combined prompt limit");
	});

	it("retains per-image and image-count limits", async () => {
		writeFileSync(join(dir, "photo.jpg"), Buffer.concat([bytes, Buffer.from([0])]));
		await expect(resolvePromptImages([upload], dir)).rejects.toThrow("per-image prompt limit");
		await expect(resolvePromptImages(batch("inline", 21), dir)).rejects.toThrow("20-image limit");
		expect(() =>
			parseClientMessage({ type: "prompt", text: "look", images: batch("inline", 21) }),
		).toThrow("at most 20");
	});
});
