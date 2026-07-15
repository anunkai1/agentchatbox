/**
 * Session search — the public entry point for the rest of the server.
 *
 * This module is the ONLY thing outside this folder that core code imports.
 * It exposes `isSearchAvailable()` and `searchSessions()`. Everything else
 * (embeddings, store, indexer) is internal. Delete this folder and the core
 * server compiles and runs identically — that is the pluggability contract.
 *
 * ENABLED when ALL of:
 *   - `AGENTCHATBOX_SEARCH_ENABLED=1` is set, AND
 *   - the optional `better-sqlite3` package is importable, AND
 *   - the optional `@huggingface/transformers` package is importable.
 * Otherwise `isSearchAvailable()` is false, the `/api/sessions/search`
 * endpoint returns 404, `/api/health` advertises `search: false`, and the
 * sidebar shows no search box.
 *
 * On first enable, a background sweep indexes all existing sessions for the
 * server's cwd (mtime-driven, so re-sweeps are cheap). Search queries return
 * whatever is indexed so far.
 */

import { truncate } from "../../shared/content.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { embed, isEmbeddingAvailable } from "./embeddings.js";
import { indexAll } from "./indexer.js";
import { getCacheStats, isStoreAvailable, loadCache, searchVectors } from "./store.js";

export interface SessionSearchResult {
	sessionId: string;
	msgIdx: number;
	role: string;
	snippet: string;
	createdAt: string;
	similarity: number;
	title: string;
	modifiedAt: string;
	messageCount: number;
}

let availabilityCache: boolean | null = null;
let initStarted = false;

/** Is the search feature installed and enabled? Probed once, cached. */
export async function isSearchAvailable(): Promise<boolean> {
	if (availabilityCache !== null) return availabilityCache;
	const flagOn = process.env.AGENTCHATBOX_SEARCH_ENABLED === "1";
	if (!flagOn) {
		availabilityCache = false;
		return false;
	}
	const [store, emb] = await Promise.all([isStoreAvailable(), isEmbeddingAvailable()]);
	availabilityCache = store && emb;
	return availabilityCache;
}

/**
 * Lazily bootstrap the index on first availability check: open the DB, load the
 * cache, and kick off a background sweep. Idempotent — only runs once.
 */
async function ensureInit(): Promise<void> {
	if (initStarted) return;
	initStarted = true;
	try {
		await loadCache();
		const stats = getCacheStats();
		log.info("search index loaded", stats);
		// Fire-and-forget background sweep. New/changed sessions get indexed;
		// already-current ones are cheap no-ops.
		void indexAll(config.piCwd)
			.then(({ scanned, indexed }) => {
				if (indexed > 0) log.info("search index sweep", { scanned, indexed });
			})
			.catch((e) => log.warn("search index sweep failed", { error: String(e) }));
	} catch (e) {
		log.warn("search index init failed", { error: String(e) });
	}
}

/**
 * Semantic search across indexed sessions. Embeds the query and brute-force
 * matches against the in-memory vector cache. Returns up to `limit` hits,
 * best-first. Each hit carries the matched message text as a snippet plus the
 * session metadata (title, date, message count) for the result card.
 */
export async function searchSessions(
	query: string,
	opts: { cwd?: string; limit?: number } = {},
): Promise<SessionSearchResult[]> {
	if (!(await isSearchAvailable())) return [];
	await ensureInit();

	const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
	const q = query.trim();
	if (!q) return [];

	const queryVec = await embed(q);
	const hits = searchVectors(queryVec, limit);
	return hits.map((h) => ({
		sessionId: h.sessionId,
		msgIdx: h.msgIdx,
		role: h.role,
		snippet: truncate(h.text, 160),
		createdAt: h.createdAt,
		similarity: h.similarity,
		title: h.title || "Untitled",
		modifiedAt: h.modifiedAt,
		messageCount: h.messageCount,
	}));
}
