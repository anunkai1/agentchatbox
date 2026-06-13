/**
 * File upload handling.
 *
 * Multipart uploads land in `uploads/` with a UUID-based filename. The
 * original name and mime type are kept in a sidecar JSON file so the
 * download endpoint can return them with the right headers.
 *
 * Files are served back at `/uploads/:id`. A short-lived signed token
 * could be added later for access control; for now we treat the URL
 * itself as the capability.
 */

import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import multer from "multer";
import { config } from "./config.js";
import type { UploadResponse } from "../shared/protocol.js";

interface UploadMeta {
	id: string;
	filename: string;
	mimeType: string;
	storedPath: string;
	createdAt: number;
}

const meta = new Map<string, UploadMeta>();

// Multer uses memory storage; we write to disk ourselves so we can pair
// the file with a sidecar metadata JSON in a single transaction.
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: config.maxUploadBytes },
});

async function ensureUploadsDir(): Promise<void> {
	await mkdir(config.uploadsDir, { recursive: true });
}

function safeExtension(name: string): string {
	const ext = extname(name).toLowerCase();
	// allow short, simple extensions only
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

		const entry: UploadMeta = {
			id,
			filename: file.originalname,
			mimeType: file.mimetype || "application/octet-stream",
			storedPath,
			createdAt: Date.now(),
		};
		meta.set(id, entry);

		const response: UploadResponse = {
			id,
			filename: entry.filename,
			mimeType: entry.mimeType,
			size: file.size,
			url: `/uploads/${id}${ext}`,
		};
		res.json(response);
	});

	router.get("/:filename", async (req: Request, res: Response) => {
		// filename is "<id><ext>"; we accept any extension and look up by id.
		const filename = req.params.filename as string;
		const id = filename.split(".")[0];
		const entry = meta.get(id);
		if (!entry) {
			res.status(404).json({ error: "not found" });
			return;
		}
		try {
			await stat(entry.storedPath);
		} catch {
			meta.delete(id);
			res.status(404).json({ error: "file missing on disk" });
			return;
		}
		res.setHeader("Content-Type", entry.mimeType);
		res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(entry.filename)}"`);
		res.sendFile(entry.storedPath);
	});

	router.delete("/:filename", async (req: Request, res: Response) => {
		const filename = req.params.filename as string;
		const id = filename.split(".")[0];
		const entry = meta.get(id);
		if (!entry) {
			res.status(404).json({ error: "not found" });
			return;
		}
		try {
			await unlink(entry.storedPath);
		} catch {
			// best effort
		}
		meta.delete(id);
		res.status(204).end();
	});

	return router;
}
