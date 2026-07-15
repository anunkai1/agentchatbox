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

import { resolve } from "node:path";
import { readJson, writeJsonAtomic } from "./json-store.js";
import { projectRoot } from "./paths.js";

/** Default location: `<projectRoot>/data/pins.json` (matches `data/search.db`). Overridable via AGENTCHATBOX_PINS_FILE for tests. */
function defaultPinsFile(): string {
	return process.env.AGENTCHATBOX_PINS_FILE
		? resolve(process.env.AGENTCHATBOX_PINS_FILE)
		: resolve(projectRoot, "data", "pins.json");
}

/** Read the pin set for a given cwd (absolute session ids). */
export function readPinnedSessions(): Set<string> {
	// readJson tolerates a missing/corrupt file (degrades to the empty
	// object); we then keep only entries whose value is exactly `true`.
	const parsed = readJson<Record<string, unknown>>(defaultPinsFile(), {});
	const out = new Set<string>();
	for (const [id, val] of Object.entries(parsed)) {
		if (val === true) out.add(id);
	}
	return out;
}

/**
 * Set or clear the pin for a session id. Returns the new pinned state.
 * Only writers are this server's own WS handlers, so no concurrency — but
 * the write is still atomic (tmp + rename) so a crash mid-write or a
 * reader racing the write can't corrupt pins.json into a state
 * readPinnedSessions() would silently drop, losing the whole pin set.
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
	// Serialize as { id: true } for both the file and the in-memory shape.
	const obj: Record<string, true> = {};
	for (const id of ids) obj[id] = true;
	writeJsonAtomic(defaultPinsFile(), obj);
}
