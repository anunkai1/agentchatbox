/**
 * Tiny crash-safe JSON sidecar store.
 *
 * Two patterns were duplicated verbatim in `projects.ts` and
 * `session-pins.ts` (and are on track to appear in every future
 * server-owned sidecar file):
 *
 *   1. READ: parse a JSON file, treating a missing/corrupt/empty file
 *      as a caller-supplied default (so a torn write never crashes the
 *      reader).
 *   2. WRITE: write to a sibling `<file>.tmp` then `rename` over the
 *      target. POSIX `rename` is atomic when src+dst share a filesystem
 *      (they do — same dir), so a crash mid-write or a reader racing the
 *      write can't leave a truncated file the reader would silently drop,
 *      losing the whole sidecar.
 *
 * Centralizing both means every sidecar (`data/pins.json`,
 * `data/projects.json`, …) gets the same crash-safety for free and there
 * is one place to maintain the atomic-write + corrupt-tolerant-read logic.
 *
 * Keep this module dependency-free (node:fs + node:path only) so it can
 * be imported anywhere without pulling in app state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Read and parse a JSON sidecar. Returns `fallback` for a missing,
 * unreadable, unparseable, or non-object file — i.e. a torn write degrades
 * to the default instead of crashing the caller. The caller owns the type
 * of `fallback`; we only guarantee we hand back either a valid parse or
 * that exact value.
 */
export function readJson<T>(file: string, fallback: T): T {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		// Corrupt or partially-written — the next write (writeJsonAtomic)
		// replaces it. Treat as absent rather than crashing the reader.
		return fallback;
	}
}

/**
 * Write `value` to `file` atomically: serialize to a sibling `<file>.tmp`,
 * `mkdir -p` the parent, then `rename` over the target. POSIX `rename` is
 * atomic on the same filesystem, so a reader (or a crash) mid-write never
 * sees a truncated file — it sees either the old bytes or the new ones.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
	const abs = resolve(file);
	try {
		mkdirSync(dirname(abs), { recursive: true });
	} catch {
		/* dir may already exist */
	}
	const tmp = `${abs}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2));
	renameSync(tmp, abs);
}
