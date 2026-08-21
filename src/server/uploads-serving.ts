import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, join } from "node:path";
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

/**
 * Serve uploads without ever executing user-controlled active content on the
 * application origin. Valid raster images remain inline for previews; every
 * other format is an octet-stream attachment under a restrictive sandbox.
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
				const header = Buffer.alloc(16);
				const { bytesRead } = await handle.read(header, 0, header.length, 0);
				const mime = safeInlineRasterMime(name, header.subarray(0, bytesRead));
				res.setHeader("Cache-Control", "private, max-age=3600");
				res.setHeader("Content-Length", String(stat.size));
				res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
				res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
				res.setHeader("X-Content-Type-Options", "nosniff");
				if (mime) {
					res.setHeader("Content-Type", mime);
					res.setHeader("Content-Disposition", "inline");
				} else {
					res.setHeader("Content-Type", "application/octet-stream");
					res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
				}
				handle
					.createReadStream({ autoClose: true, start: 0 })
					.on("error", () => {
						try {
							res.destroy();
						} catch {
							/* client may already be gone */
						}
					})
					.pipe(res);
			} catch (error) {
				await handle.close().catch(() => {});
				throw error;
			}
		}),
	);
	return router;
}
