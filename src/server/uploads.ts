/** Quota-aware streaming multipart upload route. */

import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { extname, join } from "node:path";
import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import multer from "multer";
import type { UploadResponse } from "../shared/protocol.js";
import { uploadStore } from "./upload-store.js";

type UploadRequest = Request & { file?: Express.Multer.File; _uploadTempPath?: string };

/** Keep short, simple extensions only (defends against weird originals). */
export function safeExtension(name: string): string {
	const ext = extname(name).toLowerCase();
	if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
	return "";
}

export function createUploadsRouter(store = uploadStore): Router {
	const router = express.Router();
	const upload = multer({
		storage: multer.diskStorage({
			destination: (_req, _file, callback) => callback(null, store.tempDir),
			filename: (req, _file, callback) => {
				const name = `${randomUUID()}.part`;
				(req as UploadRequest)._uploadTempPath = join(store.tempDir, name);
				callback(null, name);
			},
		}),
		// Busboy emits its parts-limit event when the counter reaches the
		// threshold. Two therefore permits exactly our one file part; `files: 1`
		// and `fields: 0` still reject every additional file or form field.
		limits: { fileSize: store.maxUploadBytes, files: 1, fields: 0, parts: 2 },
	});

	router.post("/", (req: Request, res: Response, next: NextFunction) => {
		const uploadRequest = req as UploadRequest;
		let reservation: string;
		try {
			reservation = store.reserve();
		} catch (error) {
			next(error);
			return;
		}

		let settled = false;
		const cancelAborted = () => {
			if (settled) return;
			settled = true;
			store.cancel(reservation, uploadRequest._uploadTempPath);
		};
		req.once("aborted", cancelAborted);

		upload.single("file")(req, res, (error: unknown) => {
			req.off("aborted", cancelAborted);
			const file = uploadRequest.file;
			const tempPath = file?.path ?? uploadRequest._uploadTempPath;
			if (settled) {
				store.cancel(undefined, tempPath);
				return;
			}
			settled = true;
			if (error) {
				store.cancel(reservation, tempPath);
				next(error);
				return;
			}
			if (!file) {
				store.cancel(reservation);
				res.status(400).json({ error: "no file uploaded (field name: 'file')" });
				return;
			}

			try {
				// Multer creates the staging file before the service umask is
				// necessarily applied in tests; force private permissions explicitly.
				chmodSync(file.path, 0o600);
				const filename = store.publish(reservation, file.path, safeExtension(file.originalname));
				const ext = extname(filename);
				const id = filename.slice(0, filename.length - ext.length);
				const response: UploadResponse = {
					id,
					filename: file.originalname.slice(0, 1024),
					mimeType: file.mimetype || "application/octet-stream",
					size: file.size,
					url: `/uploads/${filename}`,
				};
				res.json(response);
			} catch (publishError) {
				store.cancel(reservation, tempPath);
				next(publishError);
			}
		});
	});

	return router;
}
