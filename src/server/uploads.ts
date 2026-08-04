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
import { mkdir } from "node:fs/promises";
import { extname } from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import multer from "multer";
import type { UploadResponse } from "../shared/protocol.js";
import { asyncHandler } from "./async-handler.js";
import { config } from "./config.js";

// Stream uploads directly to disk: buffering an allowed 2 GiB video in the
// Node process would make the upload limit an easy route to exhausting RAM.
const upload = multer({
	storage: multer.diskStorage({
		destination: (_req, _file, callback) => {
			void mkdir(config.uploadsDir, { recursive: true }).then(
				() => callback(null, config.uploadsDir),
				(err: unknown) => callback(err as Error, config.uploadsDir),
			);
		},
		filename: (_req, file, callback) => {
			callback(null, `${randomUUID()}${safeExtension(file.originalname)}`);
		},
	}),
	limits: { fileSize: config.maxUploadBytes },
});

/** Keep short, simple extensions only (defends against weird originals). */
function safeExtension(name: string): string {
	const ext = extname(name).toLowerCase();
	if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
	return "";
}

export function createUploadsRouter(): Router {
	const router = express.Router();

	router.post(
		"/",
		upload.single("file"),
		asyncHandler(async (req: Request, res: Response) => {
			const file = (req as Request & { file?: Express.Multer.File }).file;
			if (!file) {
				res.status(400).json({ error: "no file uploaded (field name: 'file')" });
				return;
			}

			const ext = extname(file.filename);
			const id = file.filename.slice(0, file.filename.length - ext.length);
			const response: UploadResponse = {
				id,
				filename: file.originalname,
				mimeType: file.mimetype || "application/octet-stream",
				size: file.size,
				url: `/uploads/${file.filename}`,
			};
			res.json(response);
		}),
	);

	return router;
}
