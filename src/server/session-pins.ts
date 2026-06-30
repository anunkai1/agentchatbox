/**
 * Server-side session pin store — `data/pins.json`.
 *
 * Pinning has no equivalent in `pi` (no RPC, no JSONL field), so unlike
 * session names (which `pi` persists itself via `set_session_name`) the
 * pin set is an agentchatbox UI concern. To make it sync across devices
 * it lives on the server, as a flat JSON file of pinned session ids for
 * the configured `piCwd`.
 *
 * This mirrors the precedent set by the semantic-search feature, which
 * keeps its own `data/search.db` server-side store of data derived from
 * files `pi` wrote to disk. Both fit the transport-layer-only rule: the
 * server reads/writes a local data file, no `pi` subprocess involvement,
 * no agent logic.
 *
 * Format:
 *   { "<sessionId>": true, ... }
 *
 * Keys are session ids; presence with `true` = pinned. (A flat array
 * would also work; the map makes toggle/idempotency checks trivial and
 * tolerates future per-pin metadata without a migration.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { projectRoot } from "./paths.js";

/** Default location: `<projectRoot>/data/pins.json` (matches `data/search.db`). Overridable via AGENTCHATBOX_PINS_FILE for tests. */
function defaultPinsFile(): string {
	return process.env.AGENTCHATBOX_PINS_FILE
		? resolve(process.env.AGENTCHATBOX_PINS_FILE)
		: resolve(projectRoot, "data", "pins.json");
}

/** Read the pin set for a given cwd (absolute session ids). */
export function readPinnedSessions(): Set<string> {
	const file = defaultPinsFile();
	if (!existsSync(file)) return new Set();
	try {
		const raw = readFileSync(file, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out = new Set<string>();
			for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
				if (val === true) out.add(id);
			}
			return out;
		}
		return new Set();
	} catch {
		// Corrupt or partially-written file — treat as empty rather than
		// crashing the session list. The next write replaces it.
		return new Set();
	}
}

/** Is the given session id pinned? Cheap membership check. */
export function isPinned(sessionId: string): boolean {
	return readPinnedSessions().has(sessionId);
}

/**
 * Set or clear the pin for a session id. Returns the new pinned state.
 * Writes atomically enough for a single-user homelab (writeFileSync then
 * the OS flushes); concurrent writers would race, but the only writers
 * are this server's own WS handlers.
 */
export function setPinned(sessionId: string, pinned: boolean): boolean {
	const current = readPinnedSessions();
	if (pinned) {
		current.add(sessionId);
	} else {
		current.delete(sessionId);
	}
	writePins(current);
	return pinned;
}

function writePins(ids: Set<string>): void {
	const file = defaultPinsFile();
	try {
		mkdirSync(dirname(file), { recursive: true });
	} catch {
		/* dir may already exist */
	}
	const obj: Record<string, true> = {};
	for (const id of ids) obj[id] = true;
	writeFileSync(file, JSON.stringify(obj, null, 2));
}
