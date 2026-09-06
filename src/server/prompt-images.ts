import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { PromptImage } from "../shared/protocol.js";
import { config } from "./config.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Keep the single pi RPC message bounded when several images are attached. */
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;
const UPLOAD_URL_RE = /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/;

/** Identify the bounded raster formats accepted as prompt images from magic,
 * not from the browser-controlled filename or multipart Content-Type. */
export function detectPromptImageMime(header: Buffer): string | null {
	if (header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
	if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) {
		return "image/gif";
	}
	if (
		header.subarray(0, 4).toString("ascii") === "RIFF" &&
		header.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (header.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
	if (
		header.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
		header.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
	) {
		return "image/tiff";
	}
	if (header.subarray(4, 8).toString("ascii") === "ftyp") {
		const brand = header.subarray(8, 12).toString("ascii");
		if (brand === "avif" || brand === "avis") return "image/avif";
		if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
		if (["mif1", "msf1"].includes(brand)) return "image/heif";
	}
	return null;
}

/**
 * Resolve browser image references into pi's inline ImageContent wire shape.
 *
 * The upload has already crossed the HTTP transport and lives in uploadsDir;
 * reading that private immutable file here avoids sending a second 4/3-size
 * base64 copy through an Android browser WebSocket. O_NOFOLLOW, a single safe
 * basename, regular-file checks, a hard byte cap, and magic-derived MIME keep
 * the browser reference from becoming a general filesystem read primitive.
 * Legacy inline images remain supported for tabs open across a rolling deploy.
 */
export async function resolvePromptImages(
	images: PromptImage[] | undefined,
	uploadsDir = config.uploadsDir,
): Promise<ImageContent[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const resolved: ImageContent[] = [];
	let totalBytes = 0;

	for (const image of images) {
		if ("data" in image && image.data !== undefined) {
			const imageBytes = Buffer.byteLength(image.data, "base64");
			if (totalBytes + imageBytes > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
				throw new Error("image attachments exceed the 32 MiB combined prompt limit");
			}
			totalBytes += imageBytes;
			resolved.push({ type: "image", data: image.data, mimeType: image.mimeType });
			continue;
		}

		const match = UPLOAD_URL_RE.exec(image.url);
		if (!match) throw new Error("image attachment has an invalid upload reference");
		const handle = await open(
			join(uploadsDir, match[1]),
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		).catch(() => null);
		if (!handle) throw new Error("image attachment is no longer available");

		try {
			const before = await handle.stat();
			if (!before.isFile() || before.size <= 0 || before.size > MAX_IMAGE_BYTES) {
				throw new Error("image attachment is not a bounded regular file");
			}
			if (totalBytes + before.size > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
				throw new Error("image attachments exceed the 32 MiB combined prompt limit");
			}
			totalBytes += before.size;
			const header = Buffer.alloc(16);
			const { bytesRead } = await handle.read(header, 0, header.length, 0);
			const mimeType = detectPromptImageMime(header.subarray(0, bytesRead));
			if (!mimeType) throw new Error("image attachment is not a supported raster image");

			const data = await handle.readFile();
			const after = await handle.stat();
			if (
				data.length !== before.size ||
				after.size !== before.size ||
				data.length > MAX_IMAGE_BYTES
			) {
				throw new Error("image attachment changed while it was being read");
			}
			resolved.push({ type: "image", data: data.toString("base64"), mimeType });
		} finally {
			await handle.close().catch(() => {});
		}
	}

	return resolved;
}
