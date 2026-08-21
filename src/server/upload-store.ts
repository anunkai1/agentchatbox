import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface UploadUsage {
	bytes: number;
	files: number;
	quotaBytes: number;
	reservedBytes: number;
	warning: boolean;
}

export class UploadQuotaError extends Error {
	readonly status = 507;
	readonly expose = true;
	constructor(message = "upload storage quota exceeded") {
		super(message);
		this.name = "UploadQuotaError";
	}
}

/**
 * Process-wide admission control for uploaded files. Every in-flight upload
 * reserves the full per-file allowance, so concurrent or falsely-sized
 * multipart requests cannot race past the aggregate quota.
 */
export class UploadStore {
	readonly tempDir: string;
	private readonly reservations = new Set<string>();

	constructor(
		readonly uploadsDir: string,
		readonly maxUploadBytes: number,
		readonly quotaBytes: number,
	) {
		this.tempDir = join(uploadsDir, ".tmp");
		mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
		try {
			chmodSync(uploadsDir, 0o700);
		} catch {
			/* a read-only test fixture will fail later with a useful write error */
		}
		// No request can be active while the process is booting. Removing this
		// private directory cleans partial files left by a crash/disconnect.
		rmSync(this.tempDir, { recursive: true, force: true });
		mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
	}

	reserve(): string {
		const used = this.scanUsage();
		const reserved = this.reservations.size * this.maxUploadBytes;
		if (used.bytes + reserved + this.maxUploadBytes > this.quotaBytes) {
			throw new UploadQuotaError();
		}
		const token = randomUUID();
		this.reservations.add(token);
		return token;
	}

	/** Publish a completed temporary file by same-filesystem atomic rename. */
	publish(token: string, tempPath: string, extension: string): string {
		if (!this.reservations.has(token)) throw new Error("invalid upload reservation");
		const filename = `${randomUUID()}${extension}`;
		const destination = join(this.uploadsDir, filename);
		try {
			renameSync(tempPath, destination);
			chmodSync(destination, 0o600);
			return filename;
		} finally {
			this.reservations.delete(token);
		}
	}

	cancel(token: string | undefined, tempPath?: string): void {
		if (token) this.reservations.delete(token);
		if (tempPath) rmSync(tempPath, { force: true });
	}

	usage(): UploadUsage {
		const usage = this.scanUsage();
		const reservedBytes = this.reservations.size * this.maxUploadBytes;
		return {
			...usage,
			quotaBytes: this.quotaBytes,
			reservedBytes,
			warning: usage.bytes + reservedBytes >= this.quotaBytes * 0.75,
		};
	}

	private scanUsage(): { bytes: number; files: number } {
		let bytes = 0;
		let files = 0;
		if (!existsSync(this.uploadsDir)) return { bytes, files };
		for (const entry of readdirSync(this.uploadsDir, { withFileTypes: true })) {
			// Ignore symlinks, directories, and the private staging directory.
			// Extension-generated images are normal root-level files and count.
			if (!entry.isFile()) continue;
			try {
				const stat = statSync(join(this.uploadsDir, entry.name));
				if (!stat.isFile()) continue;
				bytes += stat.size;
				files++;
			} catch {
				// A concurrently removed extension output simply vanishes from usage.
			}
		}
		return { bytes, files };
	}
}

export const uploadStore = new UploadStore(
	config.uploadsDir,
	config.maxUploadBytes,
	config.maxUploadStorageBytes,
);
