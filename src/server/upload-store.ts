import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export const UPLOAD_RESERVATION_PREFIX = ".acb-upload-reservation-";

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

function reservationOwner(name: string): number | null {
	const match = name.match(/^\.acb-upload-reservation-(\d+)-/);
	if (!match) return null;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * Process-wide admission control for uploaded files. Every in-flight writer
 * creates a unique sparse reservation before scanning the shared directory.
 * On a local filesystem the later creator must observe the earlier claim, so
 * concurrent HTTP and extension writers cannot both admit past the quota.
 * Unlike stale directory-lock recovery, removing one unique dead claim cannot
 * delete a replacement claim belonging to another process.
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
		// No HTTP request survives process boot, and systemd stops all pi
		// descendants before starting ACB again. Remove abandoned staging and
		// reservations left by the prior service generation.
		rmSync(this.tempDir, { recursive: true, force: true });
		mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
		for (const entry of readdirSync(uploadsDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.startsWith(UPLOAD_RESERVATION_PREFIX)) {
				rmSync(join(uploadsDir, entry.name), { force: true });
			}
		}
	}

	reserve(): string {
		this.removeDeadReservations();
		const token = randomUUID();
		const reservationPath = join(
			this.uploadsDir,
			`${UPLOAD_RESERVATION_PREFIX}${process.pid}-${token}`,
		);
		const fd = openSync(reservationPath, "wx", 0o600);
		try {
			// Sparse logical size is visible to independent image-extension scans
			// but consumes effectively no disk blocks while the body streams.
			ftruncateSync(fd, this.maxUploadBytes);
		} catch (error) {
			rmSync(reservationPath, { force: true });
			throw error;
		} finally {
			closeSync(fd);
		}
		this.reservations.set(token, reservationPath);
		const allocation = this.scanAllocation();
		if (allocation.bytes + allocation.reservedBytes > this.quotaBytes) {
			this.reservations.delete(token);
			rmSync(reservationPath, { force: true });
			throw new UploadQuotaError();
		}
		return token;
	}

	/** Publish a completed temporary file by same-filesystem atomic rename. */
	publish(token: string, tempPath: string, extension: string): string {
		const reservationPath = this.reservations.get(token);
		if (!reservationPath) throw new Error("invalid upload reservation");
		const filename = `${randomUUID()}${extension}`;
		const destination = join(this.uploadsDir, filename);
		try {
			renameSync(tempPath, destination);
			chmodSync(destination, 0o600);
			return filename;
		} finally {
			rmSync(reservationPath, { force: true });
			this.reservations.delete(token);
		}
	}

	cancel(token: string | undefined, tempPath?: string): void {
		const reservationPath = token ? this.reservations.get(token) : undefined;
		if (token) this.reservations.delete(token);
		if (reservationPath) rmSync(reservationPath, { force: true });
		if (tempPath) rmSync(tempPath, { force: true });
	}

	usage(): UploadUsage {
		this.removeDeadReservations();
		const allocation = this.scanAllocation();
		return {
			...allocation,
			quotaBytes: this.quotaBytes,
			warning: allocation.bytes + allocation.reservedBytes >= this.quotaBytes * 0.75,
		};
	}

	private removeDeadReservations(): void {
		for (const entry of readdirSync(this.uploadsDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const pid = reservationOwner(entry.name);
			if (pid !== null && processIsGone(pid)) {
				// Reservation names contain an unguessable UUID and are never reused;
				// unlinking this exact dead claim cannot affect a replacement writer.
				rmSync(join(this.uploadsDir, entry.name), { force: true });
			}
		}
	}

	private scanAllocation(): { bytes: number; files: number; reservedBytes: number } {
		if (!existsSync(this.uploadsDir)) return { bytes: 0, files: 0, reservedBytes: 0 };
		// Publication renames staging to a target before removing its reservation.
		// If a reservation vanishes after readdir but before stat, retry the whole
		// snapshot so we see the replacement target rather than undercounting both.
		for (let attempt = 0; attempt < 10; attempt++) {
			let bytes = 0;
			let files = 0;
			let reservedBytes = 0;
			let changed = false;
			for (const entry of readdirSync(this.uploadsDir, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				// Extension staging files are already covered by their exact-size
				// reservations and never become externally visible under this name.
				if (entry.name.startsWith(".") && entry.name.endsWith(".part")) continue;
				try {
					const file = statSync(join(this.uploadsDir, entry.name));
					if (!file.isFile()) continue;
					if (entry.name.startsWith(UPLOAD_RESERVATION_PREFIX)) {
						reservedBytes += file.size;
					} else {
						bytes += file.size;
						files++;
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					changed = true;
					break;
				}
			}
			if (!changed) return { bytes, files, reservedBytes };
		}
		throw new Error("upload directory changed too quickly to calculate quota safely");
	}
}

export const uploadStore = new UploadStore(
	config.uploadsDir,
	config.maxUploadBytes,
	config.maxUploadStorageBytes,
);
