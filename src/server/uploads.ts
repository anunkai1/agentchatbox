/**
 * File upload handling.
 *
 * Multipart uploads land in `uploads/<uuid><ext>` and are served back at
 * `/uploads/<uuid><ext>` by the express.static mount in index.ts (which
 * guesses a sane Content-Type from the preserved extension). That static
 * mount is the sole serving path, so this router is POST-only: it writes
 * the body and returns the URL.
 *
 * Files are treated as capability tokens — the unguessable UUID in the
 * URL is the only access control (sufficient for this single-user,
 * Authelia-gated app).
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import multer from "multer";
import type { UploadResponse } from "../shared/protocol.js";
import { config } from "./config.js";

// Multer uses memory storage; we write to disk ourselves so we control
// the stored filename (uuid + sanitized extension).
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: config.maxUploadBytes },
});

async function ensureUploadsDir(): Promise<void> {
	await mkdir(config.uploadsDir, { recursive: true });
}

/** Keep short, simple extensions only (defends against weird originals). */
function safeExtension(name: string): string {
	const ext = extname(name).toLowerCase();
	if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
	return "";
}

export function createUploadsRouter(): Router {
	const router = express.Router();

	router.post("/", upload.single("file"), async (req: Request, res: Response) => {
		await ensureUploadsDir();
		const file = (req as Request & { file?: Express.Multer.File }).file;
		if (!file) {
			res.status(400).json({ error: "no file uploaded (field name: 'file')" });
			return;
		}

		const id = randomUUID();
		const ext = safeExtension(file.originalname);
		const storedName = `${id}${ext}`;
		const storedPath = join(config.uploadsDir, storedName);

		try {
			await writeFile(storedPath, file.buffer);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			res.status(500).json({ error: `failed to write upload: ${message}` });
			return;
		}

		const response: UploadResponse = {
			id,
			filename: file.originalname,
			mimeType: file.mimetype || "application/octet-stream",
			size: file.size,
			url: `/uploads/${id}${ext}`,
		};
		res.json(response);
	});

	return router;
}
