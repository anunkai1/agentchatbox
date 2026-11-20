import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Request, Response, Router } from "express";
import express from "express";
import { asyncHandler } from "./async-handler.js";
import { config } from "./config.js";

// Extensions may deliberately publish human-readable filenames. Permit one
// basename only (no slash, dot-prefix, control chars, or traversal segments).
const UPLOAD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/** Return a browser-safe raster MIME only when extension and magic agree. */
export function safeInlineRasterMime(name: string, header: Buffer): string | null {
	const ext = extname(name).toLowerCase();
	if (ext === ".png" && header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
		return "image/png";
	}
	if (ext === ".jpg" || ext === ".jpeg") {
		if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
	}
	if (ext === ".gif" && ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) {
		return "image/gif";
	}
	if (
		ext === ".webp" &&
		header.subarray(0, 4).toString("ascii") === "RIFF" &&
		header.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (ext === ".bmp" && header.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
	if (ext === ".avif" && header.subarray(4, 8).toString("ascii") === "ftyp") {
		const brand = header.subarray(8, 12).toString("ascii");
		if (brand === "avif" || brand === "avis") return "image/avif";
	}
	return null;
}

/** Return a browser-safe video MIME only when extension and magic agree. */
export function safeInlineVideoMime(name: string, header: Buffer): string | null {
	const ext = extname(name).toLowerCase();
	if (ext === ".mp4" && header.length >= 12) {
		const boxSize = header.readUInt32BE(0);
		if (
			(boxSize >= 8 || boxSize === 0 || boxSize === 1) &&
			header.subarray(4, 8).toString("ascii") === "ftyp"
		) {
			const brand = header.subarray(8, 12).toString("ascii");
			if (brand !== "qt  " && brand !== "avif" && brand !== "avis") return "video/mp4";
		}
	}
	if (ext === ".mov" && header.length >= 8) {
		const boxSize = header.readUInt32BE(0);
		const atom = header.subarray(4, 8).toString("ascii");
		if (boxSize >= 8 || boxSize === 0 || boxSize === 1) {
			if (
				atom === "ftyp" &&
				header.length >= 12 &&
				header.subarray(8, 12).toString("ascii") === "qt  "
			) {
				return "video/quicktime";
			}
			if (["moov", "mdat", "wide", "free", "skip"].includes(atom)) {
				return "video/quicktime";
			}
		}
	}
	if (
		ext === ".webm" &&
		header.length >= 4 &&
		header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
	) {
		const ascii = header.toString("latin1");
		if (ascii.includes("matroska") && !ascii.includes("webm")) return null;
		return "video/webm";
	}
	return null;
}

/**
 * Inline MIME for an upload, or null to force a download. SVG is shown
 * inline too: in an <img> browsers never run its scripts, and when opened
 * directly the sandbox CSP below gives it an opaque origin with scripts off.
 */
export function safeInlineMime(name: string, header: Buffer): string | null {
	if (extname(name).toLowerCase() === ".svg") return "image/svg+xml";
	return safeInlineRasterMime(name, header) ?? safeInlineVideoMime(name, header);
}

export type ParsedByteRange = { start: number; end: number } | "unsatisfiable" | null;

/** Parse a single RFC 9110 byte range header (`bytes=start-end`, `bytes=start-`, `bytes=-suffix`). */
export function parseByteRange(rangeHeader: string | undefined, size: number): ParsedByteRange {
	if (!rangeHeader) return null;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
	if (!match) return null;
	const [, startStr, endStr] = match;
	if (!startStr && !endStr) return null;
	if (size <= 0) return "unsatisfiable";
	if (!startStr) {
		const suffix = Number(endStr);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(startStr);
	const end = endStr === "" ? size - 1 : Math.min(Number(endStr), size - 1);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
		return "unsatisfiable";
	}
	return { start, end };
}

/**
 * Serve uploads without ever executing user-controlled active content on the
 * application origin. Valid raster images, videos, and sandboxed SVGs are inline
 * for previews; every other format is an octet-stream attachment. Supports HTTP
 * Range requests so inline <video> playback and seeking work.
 */
export function createUploadsServingRouter(): Router {
	const router = express.Router();
	router.get(
		"/:name",
		asyncHandler(async (req: Request, res: Response) => {
			const name = req.params.name;
			if (!UPLOAD_NAME_RE.test(name)) {
				res.status(404).json({ error: "upload not found" });
				return;
			}
			const target = join(config.uploadsDir, name);
			let handle: Awaited<ReturnType<typeof open>>;
			try {
				handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			} catch {
				res.status(404).json({ error: "upload not found" });
				return;
			}

			try {
				const stat = await handle.stat();
				if (!stat.isFile()) {
					await handle.close();
					res.status(404).json({ error: "upload not found" });
					return;
				}
				const header = Buffer.alloc(64);
				const { bytesRead } = await handle.read(header, 0, header.length, 0);
				const mime = safeInlineMime(name, header.subarray(0, bytesRead));
				res.setHeader("Accept-Ranges", "bytes");
				res.setHeader("Cache-Control", "private, max-age=3600");
				res.setHeader(
					"Content-Security-Policy",
					"sandbox; default-src 'none'; style-src 'unsafe-inline'",
				);
				res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
				res.setHeader("X-Content-Type-Options", "nosniff");
				if (mime) {
					res.setHeader("Content-Type", mime);
					res.setHeader("Content-Disposition", "inline");
				} else {
					res.setHeader("Content-Type", "application/octet-stream");
					res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
				}

				const parsedRange = parseByteRange(req.get("range"), stat.size);
				if (parsedRange === "unsatisfiable") {
					await handle.close();
					res.status(416);
					res.setHeader("Content-Range", `bytes */${stat.size}`);
					res.end();
					return;
				}
				if (parsedRange) {
					const { start, end } = parsedRange;
					res.status(206);
					res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
					res.setHeader("Content-Length", String(end - start + 1));
					if (req.method === "HEAD") {
						await handle.close();
						res.end();
						return;
					}
					await pipeline(handle.createReadStream({ autoClose: true, start, end }), res).catch(
						() => {},
					);
					return;
				}

				res.setHeader("Content-Length", String(stat.size));
				if (req.method === "HEAD" || stat.size === 0) {
					await handle.close();
					res.end();
					return;
				}
				// pipeline() destroys the file stream (closing its descriptor) when the
				// client aborts; a bare .pipe() would leak it until garbage collection.
				await pipeline(handle.createReadStream({ autoClose: true, start: 0 }), res).catch(() => {});
			} catch (error) {
				await handle.close().catch(() => {});
				throw error;
			}
		}),
	);
	return router;
}
