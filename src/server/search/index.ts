import { resolve } from "node:path";
import { truncate } from "../../shared/content.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { listProjects } from "../projects.js";
import { listAllSessions } from "../session-list.js";
import { embed, isEmbeddingAvailable } from "./embeddings.js";
import { ensureSessionIndexed } from "./indexer.js";
import {
	deleteSession,
	indexedSessionIds,
	isStoreAvailable,
	loadCache,
	searchVectors,
} from "./store.js";

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

export async function isSearchAvailable(): Promise<boolean> {
	if (process.env.AGENTCHATBOX_SEARCH_ENABLED !== "1") return false;
	const [store, embeddings] = await Promise.all([isStoreAvailable(), isEmbeddingAvailable()]);
	return store && embeddings;
}

let initialisation: Promise<void> | undefined;
let refresh: Promise<void> | undefined;
let refreshRequested = false;
let lastError: string | null = null;

/**
 * Progress of the sweep currently in flight, or null when none is running.
 * Reported to the UI so a long first-run index reads as work in progress
 * ("indexing 12 of 84 conversations") rather than a search that has hung.
 */
let progress: { done: number; total: number } | null = null;

function ensureInit(): Promise<void> {
	initialisation ??= loadCache().catch((error) => {
		initialisation = undefined;
		throw error;
	});
	return initialisation;
}

/**
 * Longest a single sweep pass may run before yielding to the next pass, so the
 * cache and SQLite work that stays on the main thread comes in bounded slices.
 */
export const SEARCH_SWEEP_BUDGET_MS = 15_000;

/** Pruning more than this many conversations at once, and over half the index, is treated as suspect. */
const MAX_SUSPECT_PRUNE = 20;

export function searchStatus() {
	return { indexing: !!refresh, error: lastError, progress };
}

/** Coalesce refresh requests; a run completing mid-sweep gets a subsequent pass. */
export function refreshSearchIndex(): Promise<void> {
	refreshRequested = true;
	if (refresh) return refresh;
	refresh = (async () => {
		if (!(await isSearchAvailable())) return;
		await ensureInit();
		do {
			refreshRequested = false;
			const sessions = listAllSessions([
				...new Set([config.piCwd, ...listProjects().map((p) => p.cwd)]),
			]);
			const ids = new Set(sessions.map((s) => s.id));
			const gone = indexedSessionIds().filter((id) => !ids.has(id));
			// A listing that suddenly lacks most of the index is far likelier a failed read than
			// hundreds of deletions; pruning on it would force a full, CPU-heavy re-embed.
			if (gone.length > MAX_SUSPECT_PRUNE && gone.length * 2 > indexedSessionIds().length) {
				log.warn("search prune skipped: listing is missing most indexed conversations", {
					missing: gone.length,
					indexed: indexedSessionIds().length,
					listed: sessions.length,
				});
			} else {
				if (gone.length) log.info("search prune", { removed: gone.length });
				for (const id of gone) await deleteSession(id);
			}
			let failed = 0;
			// A fresh object per pass (not a mutation of the previous one) so a
			// request in flight cannot read counters from the pass before it.
			const pass = { done: 0, total: sessions.length };
			progress = pass;
			const startedAt = Date.now();
			for (const session of sessions) {
				try {
					await ensureSessionIndexed(session);
				} catch (error) {
					failed++;
					log.warn("search session indexing failed", {
						sessionId: session.id,
						error: String(error),
					});
				}
				pass.done++;
				// Yield between sessions so requests are served during a sweep,
				// and hand the rest of the backlog to a follow-up pass.
				if (Date.now() - startedAt >= SEARCH_SWEEP_BUDGET_MS) {
					refreshRequested = true;
					break;
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			lastError = failed ? `${failed} conversations could not be indexed` : null;
		} while (refreshRequested);
	})()
		.catch((error) => {
			lastError = "Search index refresh failed";
			log.warn("search index refresh failed", { error: String(error) });
		})
		.finally(() => {
			refresh = undefined;
			progress = null;
		});
	return refresh;
}

export async function searchSessions(
	query: string,
	opts: { cwd?: string; limit?: number; refresh?: boolean } = {},
): Promise<SessionSearchResult[]> {
	if (!(await isSearchAvailable()) || !query.trim()) return [];
	await ensureInit();
	// Also reconcile external Pi edits when the user searches. Don't restart an active sweep.
	if (opts.refresh !== false && !refresh) void refreshSearchIndex();
	const queryVec = await embed(query.trim());
	const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
	return searchVectors(queryVec, limit, opts.cwd ? resolve(opts.cwd) : undefined).map((hit) => ({
		sessionId: hit.sessionId,
		msgIdx: hit.msgIdx,
		role: hit.role,
		snippet: truncate(hit.text, 320),
		createdAt: hit.createdAt,
		similarity: hit.similarity,
		title: hit.title || "Untitled",
		modifiedAt: hit.modifiedAt,
		messageCount: hit.messageCount,
	}));
}

export async function deleteIndexedSession(sessionId: string): Promise<void> {
	if (!(await isSearchAvailable())) return;
	await ensureInit();
	// In-flight embedding validates the source before committing, so it cannot resurrect a deleted file.
	await deleteSession(sessionId);
}
