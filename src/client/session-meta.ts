/**
 * Client-side session display metadata: pinning and custom (renamed)
 * titles shown in the sidebar.
 *
 * This is pure UI preference — it is NOT agent logic, session content,
 * or anything the `pi` subprocess owns. Per the project's "transport
 * layer only" rule, the server is never involved; these overrides live
 * in the browser's localStorage, keyed by session id, and are applied
 * purely at render time in the sidebar.
 *
 * Keys are namespaced per-origin so multiple installs (or a server
 * move) don't collide. The store is a flat map:
 *   { "<sessionId>": { pinned?: true, title?: string } }
 */

const STORAGE_KEY = "agentchatbox:session-meta:v1";

interface SessionMetaEntry {
	pinned?: true;
	title?: string;
}

type SessionMetaMap = Record<string, SessionMetaEntry>;

let cache: SessionMetaMap | null = null;
const subscribers = new Set<() => void>();

function read(): SessionMetaMap {
	if (cache) return cache;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		cache = raw ? (JSON.parse(raw) as SessionMetaMap) : {};
	} catch {
		cache = {};
	}
	if (typeof cache !== "object" || cache === null) cache = {};
	return cache;
}

function write(map: SessionMetaMap): void {
	cache = map;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
	} catch {
		/* storage full / disabled — in-memory cache still works for the session */
	}
	notify();
}

function notify(): void {
	for (const fn of subscribers) {
		try {
			fn();
		} catch {
			/* a bad subscriber must not break the others */
		}
	}
}

/** Ensure an entry exists in the map (no-op if already present). */
function ensureEntry(map: SessionMetaMap, id: string): SessionMetaEntry {
	let entry = map[id];
	if (!entry) {
		entry = {};
		map[id] = entry;
	}
	return entry;
}

/** Remove an entry entirely once it carries no overrides. */
function pruneEntry(map: SessionMetaMap, id: string): void {
	const entry = map[id];
	if (entry && !entry.pinned && (entry.title === undefined || entry.title === "")) {
		delete map[id];
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True if the session is pinned to the top of the sidebar. */
export function isPinned(id: string): boolean {
	return Boolean(read()[id]?.pinned);
}

/** Toggle a session's pin state. Returns the new pinned state. */
export function togglePin(id: string): boolean {
	const map = read();
	const entry = ensureEntry(map, id);
	if (entry.pinned) {
		delete entry.pinned;
	} else {
		entry.pinned = true;
	}
	pruneEntry(map, id);
	write({ ...map });
	return isPinned(id);
}

/**
 * Get the user-overridden display title for a session, or `null` if the
 * session has no custom title (caller should fall back to the server's
 * `title` field).
 */
export function getCustomTitle(id: string): string | null {
	const t = read()[id]?.title;
	if (t === undefined || t === "") return null;
	return t;
}

/** Set or clear the custom display title for a session. */
export function setCustomTitle(id: string, title: string | null): void {
	const map = read();
	const entry = ensureEntry(map, id);
	const trimmed = title?.trim() ?? "";
	if (trimmed === "") {
		delete entry.title;
	} else {
		entry.title = trimmed;
	}
	pruneEntry(map, id);
	write({ ...map });
}

/** All session ids that are currently pinned. */
export function pinnedIds(): string[] {
	const map = read();
	return Object.keys(map).filter((id) => map[id]?.pinned);
}

/**
 * Subscribe to store changes (pin toggled / title edited). Returns an
 * unsubscribe function. The renderer uses this to re-paint the sidebar
 * whenever an override changes.
 */
export function subscribe(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}
