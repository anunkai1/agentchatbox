/**
 * SQLite persistence + in-memory vector cache for session-search embeddings.
 *
 * Storage layout (one file, `data/search.db`):
 *   embeddings(session_id, msg_idx, role, text, vector BLOB, created_at)
 *   indexed_sessions(session_id, cwd, mtime, msg_count, title, modified_at)
 *
 * The DB is durable storage only. At module load we pull every vector into one
 * contiguous `Float32Array` and brute-force search it with a bounded heap — no
 * SQLite query per search, no sqlite-vec extension needed. At our scale (one
 * user, hundreds–thousands of sessions) this is ~15 MB of RAM and sub-100 ms
 * per query. (Resonant ships this exact shape and benchmarks it.)
 *
 * PLUGGABILITY: `better-sqlite3` is an OPTIONAL package, dynamically imported.
 * If it is not installed the store reports unavailable and the search module
 * degrades to off. No regular dep on the core server.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { projectRoot } from "../paths.js";
import { bufferToVector, EMBEDDING_DIM, vectorToBuffer } from "./embeddings.js";

export interface IndexedSessionMeta {
	sessionId: string;
	cwd: string;
	mtime: string; // ISO — the JSONL mtime we indexed at
	msgCount: number;
	title: string;
	modifiedAt: string;
}

export interface EmbeddedRow {
	sessionId: string;
	msgIdx: number;
	role: string;
	text: string;
	vector: Float32Array;
	createdAt: string;
}

export interface SearchHit {
	sessionId: string;
	msgIdx: number;
	role: string;
	text: string; // the matched message text (for a snippet)
	createdAt: string;
	similarity: number;
	// Joined session metadata, for rendering the result card.
	title: string;
	modifiedAt: string;
	messageCount: number;
}

type Database = SqliteDb;

/**
 * Minimal structural shape of the better-sqlite3 methods we use. Declared
 * locally (not imported from the optional package) so typecheck passes whether
 * or not `better-sqlite3` is installed.
 */
interface Statement {
	run(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	get(...params: unknown[]): unknown;
}
interface SqliteDb {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	transaction<T>(fn: () => T): () => T;
}

let db: Database | null = null;
let dbAvailable: boolean | null = null;

// ── in-memory cache (parallel arrays: metadata[i] ↔ vectors[i*DIM]) ───────
interface CacheMeta {
	sessionId: string;
	msgIdx: number;
	role: string;
	text: string;
	createdAt: string;
}
let cacheMeta: CacheMeta[] = [];
let cacheVectors: Float32Array = new Float32Array(0);
let sessionMeta = new Map<string, IndexedSessionMeta>(); // sessionId → meta
let cacheLoaded = false;

/**
 * Is `better-sqlite3` importable? Probed once and cached. Never throws.
 */
export async function isStoreAvailable(): Promise<boolean> {
	if (dbAvailable !== null) return dbAvailable;
	try {
		const pkg = "better-sqlite3";
		await import(pkg);
		dbAvailable = true;
	} catch {
		dbAvailable = false;
	}
	return dbAvailable;
}

/** Default location for the index: `<projectRoot>/data/search.db`. */
function defaultDbPath(): string {
	const override = process.env.AGENTCHATBOX_SEARCH_DB;
	return override ? resolve(override) : resolve(projectRoot, "data", "search.db");
}

/** Open (or reuse) the SQLite handle and create the schema. */
export async function getDb(): Promise<Database> {
	if (db) return db;
	const pkg = "better-sqlite3";
	const DatabaseCtor = ((await import(pkg)) as { default: new (path: string) => SqliteDb }).default;
	const path = defaultDbPath();
	mkdirSync(dirname(path), { recursive: true });
	db = new DatabaseCtor(path) as Database;
	db.exec(`
		CREATE TABLE IF NOT EXISTS embeddings (
			session_id TEXT NOT NULL,
			msg_idx    INTEGER NOT NULL,
			role       TEXT,
			text       TEXT,
			vector     BLOB NOT NULL,
			created_at TEXT,
			PRIMARY KEY (session_id, msg_idx)
		);
		CREATE INDEX IF NOT EXISTS idx_embeddings_session ON embeddings(session_id);
		CREATE TABLE IF NOT EXISTS indexed_sessions (
			session_id  TEXT PRIMARY KEY,
			cwd         TEXT NOT NULL,
			mtime       TEXT NOT NULL,
			msg_count   INTEGER,
			title       TEXT,
			modified_at TEXT
		);
	`);
	return db;
}

/** Load all embeddings + session metadata into the in-memory cache. */
export async function loadCache(): Promise<void> {
	const database = await getDb();
	const rows = database
		.prepare("SELECT session_id, msg_idx, role, text, vector, created_at FROM embeddings")
		.all() as Array<{
		session_id: string;
		msg_idx: number;
		role: string;
		text: string;
		vector: Buffer;
		created_at: string;
	}>;

	cacheMeta = new Array(rows.length);
	cacheVectors = new Float32Array(rows.length * EMBEDDING_DIM);
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		cacheMeta[i] = {
			sessionId: r.session_id,
			msgIdx: r.msg_idx,
			role: r.role,
			text: r.text,
			createdAt: r.created_at,
		};
		cacheVectors.set(bufferToVector(r.vector), i * EMBEDDING_DIM);
	}

	const metas = database
		.prepare("SELECT session_id, cwd, mtime, msg_count, title, modified_at FROM indexed_sessions")
		.all() as Array<{
		session_id: string;
		cwd: string;
		mtime: string;
		msg_count: number;
		title: string;
		modified_at: string;
	}>;
	sessionMeta = new Map(
		metas.map(
			(m) =>
				[
					m.session_id,
					{
						sessionId: m.session_id,
						cwd: m.cwd,
						mtime: m.mtime,
						msgCount: m.msg_count,
						title: m.title,
						modifiedAt: m.modified_at,
					} satisfies IndexedSessionMeta,
				] as const,
		),
	);
	cacheLoaded = true;
}

/** Has a session already been indexed at (or after) the given mtime? */
export async function isIndexed(sessionId: string, mtimeIso: string): Promise<boolean> {
	const database = await getDb();
	const row = database
		.prepare("SELECT mtime FROM indexed_sessions WHERE session_id = ?")
		.get(sessionId) as { mtime: string } | undefined;
	return !!row && row.mtime >= mtimeIso;
}

/**
 * Index a session's messages: wipe any prior rows for it, embed every message,
 * insert, and record its metadata. Mutates the in-memory cache incrementally.
 */
export async function indexSession(
	meta: IndexedSessionMeta,
	messages: Array<{ msgIdx: number; role: string; text: string; createdAt: string }>,
	embedFn: (text: string) => Promise<Float32Array>,
): Promise<void> {
	const database = await getDb();

	// Embed up-front (outside any transaction — ONNX is not transactional).
	// Skip empty messages: they add noise to the index.
	const vectors = new Map<number, Float32Array>();
	for (const m of messages) {
		if (!m.text?.trim()) continue;
		vectors.set(m.msgIdx, await embedFn(m.text));
	}

	// Persist in one synchronous transaction.
	const tx = database.transaction(() => {
		database.prepare("DELETE FROM embeddings WHERE session_id = ?").run(meta.sessionId);
		const ins = database.prepare(
			"INSERT OR REPLACE INTO embeddings (session_id, msg_idx, role, text, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const m of messages) {
			const v = vectors.get(m.msgIdx);
			if (!v) continue;
			ins.run(meta.sessionId, m.msgIdx, m.role, m.text, vectorToBuffer(v), m.createdAt);
		}
		database
			.prepare(
				"INSERT OR REPLACE INTO indexed_sessions (session_id, cwd, mtime, msg_count, title, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(meta.sessionId, meta.cwd, meta.mtime, meta.msgCount, meta.title, meta.modifiedAt);
	});
	tx();

	await refreshCacheForSession(meta.sessionId);
}

/**
 * Remove a session from the index entirely — wipe its embeddings and
 * metadata rows from SQLite AND drop its entries from the in-memory
 * cache. Idempotent (no-op if the session was never indexed). Used by
 * chat.ts's deleteSession handler so a deleted session's messages stop
 * surfacing in /api/sessions/search: the store is a DERIVED copy of the
 * JSONL transcript, so it must follow the source-of-truth deletion or
 * the messages linger here forever (the JSONL is gone, but search keeps
 * returning hits). Order matters: the caller deletes the JSONL first,
 * then calls this, so a future index sweep can't resurrect the rows.
 */
export async function deleteSession(sessionId: string): Promise<void> {
	const database = await getDb();
	const tx = database.transaction(() => {
		database.prepare("DELETE FROM embeddings WHERE session_id = ?").run(sessionId);
		database.prepare("DELETE FROM indexed_sessions WHERE session_id = ?").run(sessionId);
	});
	tx();
	sessionMeta.delete(sessionId);
	// If the cache hasn't been loaded yet, nothing to prune — the next
	// loadCache() reads from SQLite, where the rows are already gone.
	if (cacheLoaded) pruneCacheForSession(sessionId);
}

/** Drop a single session's entries from the in-memory cache (after a delete). */
function pruneCacheForSession(sessionId: string): void {
	let removed = 0;
	for (let i = 0; i < cacheMeta.length; i++) {
		if (cacheMeta[i].sessionId === sessionId) removed++;
	}
	if (removed === 0) return;
	const kept = cacheMeta.length - removed;
	const newVecs = new Float32Array(kept * EMBEDDING_DIM);
	const newMeta: CacheMeta[] = [];
	let w = 0;
	for (let i = 0; i < cacheMeta.length; i++) {
		if (cacheMeta[i].sessionId === sessionId) continue;
		newMeta.push(cacheMeta[i]);
		newVecs.set(
			cacheVectors.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM),
			w * EMBEDDING_DIM,
		);
		w++;
	}
	cacheMeta = newMeta;
	cacheVectors = newVecs;
}

/** Reload a single session's rows into the cache (after indexing). */
async function refreshCacheForSession(sessionId: string): Promise<void> {
	if (!cacheLoaded) await loadCache();
	const database = await getDb();
	// Drop old cache entries for this session, then re-insert its fresh rows.
	const kept: CacheMeta[] = [];
	const keptVecs: number[] = [];
	for (let i = 0; i < cacheMeta.length; i++) {
		if (cacheMeta[i].sessionId !== sessionId) {
			kept.push(cacheMeta[i]);
			keptVecs.push(i);
		}
	}
	const fresh = database
		.prepare(
			"SELECT msg_idx, role, text, vector, created_at FROM embeddings WHERE session_id = ? ORDER BY msg_idx",
		)
		.all(sessionId) as Array<{
		msg_idx: number;
		role: string;
		text: string;
		vector: Buffer;
		created_at: string;
	}>;

	const total = kept.length + fresh.length;
	const newVecs = new Float32Array(total * EMBEDDING_DIM);
	let w = 0;
	for (const idx of keptVecs) {
		newVecs.set(
			cacheVectors.subarray(idx * EMBEDDING_DIM, (idx + 1) * EMBEDDING_DIM),
			w * EMBEDDING_DIM,
		);
		w++;
	}
	const newMeta: CacheMeta[] = kept;
	for (const r of fresh) {
		newMeta.push({
			sessionId,
			msgIdx: r.msg_idx,
			role: r.role,
			text: r.text,
			createdAt: r.created_at,
		});
		newVecs.set(bufferToVector(r.vector), w * EMBEDDING_DIM);
		w++;
	}
	cacheMeta = newMeta;
	cacheVectors = newVecs;
}

/** Brute-force cosine search over the in-memory cache, top-N by similarity.
 *
 *  Uses a real min-heap (by dot product) of size `limit`, sifted down on
 *  every replacement — O(n log k) instead of the prior re-sort-the-whole-
 *  buffer-on-every-hit loop. We also defer the `SearchHit` construction
 *  (a sessionMeta Map lookup + object alloc per element) to ONLY the
 *  surviving top-N, so a 50k-vector scan allocates `limit` objects, not
 *  one per candidate. Vectors are L2-normalized at embed time, so the
 *  dot product IS the cosine similarity. */
export function searchVectors(query: Float32Array, limit: number): SearchHit[] {
	if (!cacheLoaded || cacheMeta.length === 0 || limit <= 0) return [];
	const dim = EMBEDDING_DIM;
	const n = cacheMeta.length;
	// Min-heap of {score, idx}, parallel arrays for cache-friendly sift.
	const heapScore = new Float64Array(limit);
	const heapIdx = new Int32Array(limit);
	heapIdx.fill(-1);
	let size = 0;

	for (let i = 0; i < n; i++) {
		const off = i * dim;
		let dot = 0;
		for (let d = 0; d < dim; d++) dot += query[d] * cacheVectors[off + d];

		if (size < limit) {
			// Heap not full yet — push up.
			heapScore[size] = dot;
			heapIdx[size] = i;
			let c = size;
			while (c > 0) {
				const p = (c - 1) >> 1;
				if (heapScore[p] <= heapScore[c]) break;
				heapScore[c] = heapScore[p];
				heapIdx[c] = heapIdx[p];
				heapScore[p] = dot;
				heapIdx[p] = i;
				c = p;
			}
			size++;
		} else if (dot > heapScore[0]) {
			// Beats the current min — replace root and sift down.
			heapScore[0] = dot;
			heapIdx[0] = i;
			let p = 0;
			const half = limit >> 1;
			while (p < half) {
				let best = 2 * p + 1;
				const r = best + 1;
				if (r < limit && heapScore[r] < heapScore[best]) best = r;
				if (heapScore[p] <= heapScore[best]) break;
				const s = heapScore[p];
				const x = heapIdx[p];
				heapScore[p] = heapScore[best];
				heapIdx[p] = heapIdx[best];
				heapScore[best] = s;
				heapIdx[best] = x;
				p = best;
			}
		}
	}

	// Build the result best-first, only for survivors.
	const out: SearchHit[] = [];
	for (let j = 0; j < size; j++) out.push(toHit(cacheMeta[heapIdx[j]], heapScore[j]));
	out.sort((a, b) => b.similarity - a.similarity);
	return out;
}

function toHit(m: CacheMeta, similarity: number): SearchHit {
	const meta = sessionMeta.get(m.sessionId);
	return {
		sessionId: m.sessionId,
		msgIdx: m.msgIdx,
		role: m.role,
		text: m.text,
		createdAt: m.createdAt,
		similarity,
		title: meta?.title ?? "",
		modifiedAt: meta?.modifiedAt ?? m.createdAt,
		messageCount: meta?.msgCount ?? 0,
	};
}

export function getCacheStats(): { count: number; memoryMb: number; sessions: number } {
	return {
		count: cacheMeta.length,
		memoryMb: Math.round((cacheVectors.byteLength / 1024 / 1024) * 10) / 10,
		sessions: sessionMeta.size,
	};
}
