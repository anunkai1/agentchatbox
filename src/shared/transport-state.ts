/** Durable transport receipts, not agent/task policy. Node-only; never bundle into the client. */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function transportStateDir(origin: string): string {
	const port = new URL(origin).port || "80";
	return join(
		process.env.ACB_TRANSPORT_STATE_DIR ?? join(homedir(), ".config", "acb", "transport"),
		port,
	);
}

export function readState<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error; // Corrupt state is not permission to repeat a delivery.
	}
}

/** Rename plus file/directory fsync: survive process crashes and completed writes across reboot. */
export function durableState(file: string, value: unknown): void {
	const created = mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, file);
	// Newly created directory entries also need their parents flushed.
	let path = dirname(file);
	for (;;) {
		const dir = openSync(path, "r");
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
		if (!created || path === dirname(created)) break;
		path = dirname(path);
	}
}

export function recordTransportStop(origin: string, sessionId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return;
	durableState(join(transportStateDir(origin), "stops", `${sessionId}.json`), { at: Date.now() });
}

export function transportStoppedSince(origin: string, sessionId: string, since: number): boolean {
	const stop = readState<{ at: number }>(
		join(transportStateDir(origin), "stops", `${sessionId}.json`),
	);
	return stop !== null && stop.at >= since;
}
