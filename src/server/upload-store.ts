import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export const UPLOAD_QUOTA_LOCK_DIR = ".acb-upload-quota.lock";
export const UPLOAD_RESERVATION_PREFIX = ".acb-upload-reservation-";
const LOCK_RETRY_MS = 25;
const LOCK_MAX_ATTEMPTS = 400;
const LOCK_STALE_MS = 5 * 60_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

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

function ownerIsGone(lockDir: string): boolean {
	try {
		const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")) as {
			pid?: unknown;
		};
		if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
			try {
				process.kill(owner.pid, 0);
				return false;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "ESRCH";
			}
		}
	} catch {
		/* owner may not have been written yet */
	}
	try {
		return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
	} catch {
		return true;
	}
}

/** Same lock protocol as pi-image-core, allowing independent pi processes. */
function acquireUploadQuotaLock(uploadsDir: string): () => void {
	const lockDir = join(uploadsDir, UPLOAD_QUOTA_LOCK_DIR);
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			mkdirSync(lockDir, { mode: 0o700 });
			try {
				writeFileSync(
					join(lockDir, "owner.json"),
					JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
					{ mode: 0o600, flag: "wx" },
				);
			} catch (error) {
				rmSync(lockDir, { recursive: true, force: true });
				throw error;
			}
			return () => rmSync(lockDir, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (ownerIsGone(lockDir)) {
				rmSync(lockDir, { recursive: true, force: true });
				continue;
			}
			Atomics.wait(WAIT_BUFFER, 0, 0, LOCK_RETRY_MS);
		}
	}
	throw new Error("timed out waiting for the upload storage quota lock");
}

/**
 * Process-wide admission control for uploaded files. Every in-flight upload
 * reserves the full per-file allowance. The reservation is also represented
 * by a sparse file under a cross-process lock, so pi image extensions count it
 * and cannot race an HTTP upload past the aggregate quota.
 */
export class UploadStore {
	readonly tempDir: string;
	private readonly reservations = new Map<string, string>();

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
		// No HTTP request survives process boot. Remove incomplete body staging
		// and sparse reservations left by a prior crash.
		rmSync(this.tempDir, { recursive: true, force: true });
		mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
		for (const entry of readdirSync(uploadsDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.startsWith(UPLOAD_RESERVATION_PREFIX)) {
				rmSync(join(uploadsDir, entry.name), { force: true });
			}
		}
	}

	reserve(): string {
		const release = acquireUploadQuotaLock(this.uploadsDir);
		try {
			const used = this.scanUsage();
			const reserved = this.reservations.size * this.maxUploadBytes;
			if (used.bytes + reserved + this.maxUploadBytes > this.quotaBytes) {
				throw new UploadQuotaError();
			}
			const token = randomUUID();
			const reservationPath = join(this.uploadsDir, `${UPLOAD_RESERVATION_PREFIX}${token}`);
			const fd = openSync(reservationPath, "wx", 0o600);
			try {
				// Sparse logical size is visible to extension quota scans but consumes
				// effectively no disk blocks while the browser streams to .tmp.
				ftruncateSync(fd, this.maxUploadBytes);
			} finally {
				closeSync(fd);
			}
			this.reservations.set(token, reservationPath);
			return token;
		} finally {
			release();
		}
	}

	/** Publish a completed temporary file by same-filesystem atomic rename. */
	publish(token: string, tempPath: string, extension: string): string {
		const reservationPath = this.reservations.get(token);
		if (!reservationPath) throw new Error("invalid upload reservation");
		const filename = `${randomUUID()}${extension}`;
		const destination = join(this.uploadsDir, filename);
		const release = acquireUploadQuotaLock(this.uploadsDir);
		try {
			renameSync(tempPath, destination);
			chmodSync(destination, 0o600);
			rmSync(reservationPath, { force: true });
			this.reservations.delete(token);
			return filename;
		} catch (error) {
			rmSync(reservationPath, { force: true });
			this.reservations.delete(token);
			throw error;
		} finally {
			release();
		}
	}

	cancel(token: string | undefined, tempPath?: string): void {
		const reservationPath = token ? this.reservations.get(token) : undefined;
		let release: (() => void) | undefined;
		try {
			if (reservationPath) release = acquireUploadQuotaLock(this.uploadsDir);
			if (token) this.reservations.delete(token);
			if (reservationPath) rmSync(reservationPath, { force: true });
			if (tempPath) rmSync(tempPath, { force: true });
		} finally {
			release?.();
		}
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
			if (!entry.isFile() || entry.name.startsWith(UPLOAD_RESERVATION_PREFIX)) continue;
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
