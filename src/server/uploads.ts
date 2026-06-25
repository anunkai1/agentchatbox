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
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import multer from "multer";
import type { UploadResponse } from "../shared/protocol.js";
import { config } from "./config.js";
import { log } from "./logger.js";

interface UploadMeta {
	id: string;
	filename: string;
	mimeType: string;
	/** Absolute path to the stored file body. */
	storedPath: string;
	createdAt: number;
}

/** Shape written to `<uploadsDir>/<id>.meta.json`. */
interface SidecarFile {
	id: string;
	filename: string;
	mimeType: string;
	storedName: string;
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

function sidecarPath(id: string): string {
	return join(config.uploadsDir, `${id}.meta.json`);
}

/** Load every `<id>.meta.json` in the uploads dir into the in-memory map.
 *  Called once at router construction (server boot) so uploads survive
 *  restarts. Orphaned sidecars whose body file is missing are skipped
 *  here — the GET handler also re-checks on disk, so this is just a
 *  boot-time tidy. */
async function loadSidecars(): Promise<void> {
	let names: string[];
	try {
		names = await readdir(config.uploadsDir);
	} catch {
		return; // dir doesn't exist yet
	}
	for (const name of names) {
		if (!name.endsWith(".meta.json")) continue;
		let parsed: SidecarFile;
		try {
			parsed = JSON.parse(await readFile(join(config.uploadsDir, name), "utf8")) as SidecarFile;
		} catch {
			continue; // corrupt sidecar — ignore
		}
		if (!parsed.id || !parsed.storedName) continue;
		meta.set(parsed.id, {
			id: parsed.id,
			filename: parsed.filename,
			mimeType: parsed.mimeType,
			storedPath: join(config.uploadsDir, parsed.storedName),
			createdAt: parsed.createdAt,
		});
	}
}

export function createUploadsRouter(): Router {
	// Rehydrate metadata from disk so previously uploaded files are still
	// downloadable after a server restart.
	void loadSidecars();

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

		// Persist the sidecar so the upload survives a server restart.
		// If this write fails we still serve the file for the lifetime of
		// this process, but log it so an operator notices.
		const sidecar: SidecarFile = {
			id,
			filename: entry.filename,
			mimeType: entry.mimeType,
			storedName,
			createdAt: entry.createdAt,
		};
		try {
			await writeFile(sidecarPath(id), JSON.stringify(sidecar));
		} catch (e) {
			log.warn("failed to persist upload sidecar", {
				id,
				error: e instanceof Error ? e.message : String(e),
			});
		}

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
			try {
				await unlink(sidecarPath(id));
			} catch {
				/* best effort */
			}
			res.status(404).json({ error: "file missing on disk" });
			return;
		}
		res.setHeader("Content-Type", entry.mimeType);
		res.setHeader(
			"Content-Disposition",
			`inline; filename="${encodeURIComponent(entry.filename)}"`,
		);
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
			// best effort — body may already be gone
		}
		try {
			await unlink(sidecarPath(id));
		} catch {
			// best effort — sidecar may already be gone
		}
		meta.delete(id);
		res.status(204).end();
	});

	return router;
}
