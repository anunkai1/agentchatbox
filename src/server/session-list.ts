/**
 * Session discovery for `pi --mode rpc` subprocesses.
 *
 * `pi` stores sessions as JSONL files under
 *   `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<sessionId>.jsonl`
 *
 * (The `pi` 0.79.x convention is `--<cwd>--` literally wrapping the
 * working directory path with `--` delimiters — NOT a sha1 hash as
 * older docs claimed. The first line of every JSONL file is a
 * `session` entry: `{"type":"session","version":3,"id":"<uuidv7>",
 * "timestamp":"<iso>","cwd":"<cwd>"}`.)
 *
 * This module:
 *   - lists sessions for a given cwd
 *   - reads back the prior transcript for a session id (used by
 *     chat.ts to send a `transcript` message to the browser before
 *     the live events start flowing on resume)
 *
 * Used by:
 *   - chat.ts — for resume's transcript replay
 *   - index.ts — for the `GET /api/sessions` and `GET /api/sessions/:id`
 *     REST endpoints
 */

import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { extractText, truncate } from "../shared/content.js";
import { readPinnedSessions } from "./session-pins.js";
import { GLOBAL_PROJECT_ID, projectIdForCwd } from "./projects.js";

/**
 * Read just the first non-empty line of a file without loading the whole
 * thing into memory. Used everywhere we only need the JSONL's `session`
 * header (id / cwd lookup) — session transcripts can be hundreds of KB to
 * megabytes, and the prior code did `readFileSync(file, 'utf8')` on every
 * file in the dir just to peek line one. Returns `null` if the file has no
 * non-empty line within the first `maxBytes` (8 KB is plenty for a
 * `session` header line). On any I/O error returns `null` (callers treat a
 * missing header as "not this session").
 */
function readFirstLine(path: string, maxBytes = 8192): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(maxBytes);
		const n = readSync(fd, buf, 0, maxBytes, 0);
		const slice = buf.subarray(0, n).toString("utf8");
		const nl = slice.indexOf("\n");
		const line = (nl < 0 ? slice : slice.slice(0, nl)).trim();
		return line.length > 0 ? line : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Default root for `pi`'s session storage. Overridable via the
 * PI_CODING_AGENT_SESSION_DIR env var (the env var `pi` itself reads).
 * Exported so the search indexer (and other readers of pi's on-disk
 * format) share one definition of where sessions live.
 */
export function defaultSessionsRoot(): string {
	return process.env.PI_CODING_AGENT_SESSION_DIR ?? `${homedir()}/.pi/agent/sessions`;
}

/**
 * The per-cwd subdirectory `pi` writes sessions into. The convention
 * in pi 0.79.x is to strip the leading "/" from the cwd, replace every
 * remaining "/" with "-", and wrap the result in "--" delimiters — so
 * `/home/architect/agentchatbox` becomes `--home-architect-agentchatbox--`
 * (NOT `--/home/...--`). Exported so the search indexer reuses the exact
 * same path derivation (no second copy to drift).
 */
export function sessionsDirFor(cwd: string, root: string = defaultSessionsRoot()): string {
	const stripped = cwd.startsWith("/") ? cwd.slice(1) : cwd;
	return `${root}/--${stripped.replace(/\//g, "-")}--`;
}

export interface SessionSummary {
	/** Session UUID (the `id` from the JSONL's first line). */
	id: string;
	/** CWD the session was created in. */
	cwd: string;
	/** ISO timestamp the session was created. */
	createdAt: string;
	/** File mtime as ISO — used to sort "most recent" by default. */
	modifiedAt: string;
	/**
	 * Display title. Preference order: (1) the name the user set via
	 * `set_session_name` (pi persists this as a `session_info` line —
	 * the last one wins, so renames take effect), (2) the first user
	 * message text, truncated, (3) "(empty session)".
	 */
	title: string;
	/** Number of `message` entries in the JSONL. */
	messageCount: number;
	/** True if pinned to the top of the sidebar (from `data/pins.json`). */
	pinned?: boolean;
	/**
	 * Project id derived from this session's cwd (matched against
	 * `data/projects.json`). `"global"` for the Global project, `"other"`
	 * for orphaned sessions in a deleted project's cwd. Absent when the
	 * single-cwd `listPiSessions` is used (no project context).
	 */
	projectId?: string;
}

/**
 * List all sessions for a given cwd, newest first. Skips JSONL files
 * whose first line is malformed (defensive — `pi` should never write
 * a malformed first line, but a torn write on hard kill could).
 */
export function listPiSessions(cwd: string): SessionSummary[] {
	return finishSessions(listSessionsInCwd(cwd));
}

/**
 * mtime-keyed cache of per-file session summaries. The sidebar refresh
 * re-lists every session in every project cwd on each pin/rename/fork/
 * broadcast; without this each refresh re-read + re-parsed every JSONL
 * in full (some are MB-sized). An unchanged file is now a stat + Map
 * lookup. The cached summary excludes the derived `pinned`/`projectId`
 * fields (applied per-refresh), and we return a fresh copy so callers
 * can mutate without polluting the cache.
 */
const sessionFileCache = new Map<string, { mtime: number; summary: SessionSummary }>();

/**
 * Parse the JSONL files for a single cwd into raw (untagged) summaries.
 * Extracted so the multi-project sidebar listing can reuse it without
 * re-implementing the parser. Returns newest-first within this cwd.
 */
function listSessionsInCwd(cwd: string): SessionSummary[] {
	const dir = sessionsDirFor(resolve(cwd));
	if (!existsSync(dir)) return [];

	const out: SessionSummary[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dir, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(file);
		} catch {
			continue;
		}

		// Fast path: unchanged file → reuse the cached summary (fresh copy;
		// callers add the derived pinned/projectId fields by mutation).
		const mtime = st.mtimeMs;
		const cached = sessionFileCache.get(file);
		if (cached && cached.mtime === mtime) {
			out.push({ ...cached.summary });
			continue;
		}

		const raw = readFileSync(file, "utf8");
		const lines = raw.split("\n");

		// First non-empty line is the `session` entry.
		let firstLine: Record<string, unknown> | null = null;
		for (const l of lines) {
			const t = l.trim();
			if (!t) continue;
			try {
				firstLine = JSON.parse(t) as Record<string, unknown>;
			} catch {
				/* skip */
			}
			break;
		}
		if (firstLine?.type !== "session") continue;

		const sessionCwd = String(firstLine.cwd ?? "");
		// Filter to only this cwd — sessions from a different project
		// might live in a sibling directory but we also defensively
		// check the cwd field on the session line.
		if (sessionCwd !== resolve(cwd)) continue;

		// Count `type: "message"` entries (skip `model_change`,
		// `thinking_level_change`, etc.). These are the entries the
		// browser will render.
		let messageCount = 0;
		// First user message text becomes the fallback title.
		let firstUserText: string | null = null;
		// pi persists a user-set session name as a `session_info` line:
		//   {"type":"session_info","id":"...","name":"my-feature-work"}
		// The LAST such line wins (a rename overwrites the prior name),
		// and an empty/whitespace name clears it. This is the same field
		// `get_state` reports as `sessionName` and the TUI session picker
		// shows — reading it back here makes a rename done on any device
		// (CLI, another browser) appear in the sidebar everywhere.
		let sessionName: string | null = null;
		for (const l of lines) {
			const t = l.trim();
			if (!t) continue;
			try {
				const e = JSON.parse(t) as Record<string, unknown>;
				if (e.type === "message") {
					messageCount++;
					if (firstUserText === null) {
						const m = e.message as { role?: string; content?: unknown } | undefined;
						if (m?.role === "user" && m.content) {
							firstUserText = extractText(m.content);
						}
					}
				} else if (e.type === "session_info") {
					const n = e.name;
					// Empty string or whitespace clears the name (matches
					// pi's semantics). undefined = line had no name field,
					// leave whatever we had.
					if (typeof n === "string") {
						sessionName = n.trim() ? n : null;
					}
				}
			} catch {
				/* skip malformed */
			}
		}

		const summary: SessionSummary = {
			id: String(firstLine.id ?? name.replace(/\.jsonl$/, "")),
			cwd: sessionCwd,
			createdAt: String(firstLine.timestamp ?? st.mtime.toISOString()),
			modifiedAt: st.mtime.toISOString(),
			title: sessionName ?? (firstUserText ? truncate(firstUserText, 60) : "(empty session)"),
			messageCount,
		};
		sessionFileCache.set(file, { mtime, summary });
		out.push({ ...summary });
	}
	// NOTE: no sort here — every caller goes through finishSessions(),
	// which sorts the merged set. Sorting inside this helper would just
	// be thrown away by the per-cwd merge in listAllSessions / orphan scan.
	return out;
}

/**
 * Apply pin state + sort, shared by the single-cwd and multi-cwd listings.
 */
function finishSessions(items: SessionSummary[]): SessionSummary[] {
	items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

	// Apply the server-side pin set so the sidebar can float pinned
	// sessions to the top. Pin state is NOT a pi concept — it lives in
	// `data/pins.json` (see session-pins.ts).
	const pinned = readPinnedSessions();
	if (pinned.size > 0) {
		for (const s of items) {
			if (pinned.has(s.id)) s.pinned = true;
		}
	}
	return items;
}

/**
 * List sessions across many project cwds, tagging each with its derived
 * `projectId`. Used by the sidebar so the folder view shows every
 * project's sessions in one pass. Sessions whose cwd matches no known
 * project (a deleted project's orphans) get `projectId: "other"`.
 */
export function listAllSessions(cwds: string[]): SessionSummary[] {
	const seen = new Set<string>();
	const all: SessionSummary[] = [];
	for (const cwd of cwds) {
		for (const s of listSessionsInCwd(cwd)) {
			if (seen.has(s.id)) continue; // dedupe across cwds (shouldn't happen, defensive)
			seen.add(s.id);
			const pid = projectIdForCwd(s.cwd);
			s.projectId = pid === GLOBAL_PROJECT_ID ? "global" : pid;
			all.push(s);
		}
	}
	// Also surface orphaned sessions: any session under a cwd that maps to
	// Global but isn't one of the known project cwds is already captured
	// above (Global's cwd is included in `cwds`). Sessions in a deleted
	// project's cwd won't be in `cwds`, so we scan all session dirs under
	// the sessions root and tag unknown cwds as "other".
	for (const s of listOrphanedSessions(cwds)) {
		if (seen.has(s.id)) continue;
		seen.add(s.id);
		s.projectId = "other";
		all.push(s);
	}
	return finishSessions(all);
}

/**
 * Scan every session dir under the sessions root whose cwd is NOT in
 * `knownCwds` (a deleted project's leftover sessions). Returns raw
 * summaries; the caller tags them `projectId: "other"`.
 */
function listOrphanedSessions(knownCwds: string[]): SessionSummary[] {
	const root = defaultSessionsRoot();
	if (!existsSync(root)) return [];
	const known = new Set(knownCwds.map((c) => resolve(c)));
	const out: SessionSummary[] = [];
	for (const name of readdirSync(root)) {
		const dir = join(root, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(dir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		// listSessionsInCwd resolves cwd from each JSONL's first line, and
		// filters to sessions whose recorded cwd matches the dir's cwd. We
		// can't pass a cwd directly (we don't know it), so peek at each
		// file's first line to recover the cwd, then list that cwd if it's
		// not known.
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".jsonl")) continue;
			const firstLine = readFirstLine(join(dir, file));
			if (!firstLine) continue;
			try {
				const parsed = JSON.parse(firstLine) as Record<string, unknown>;
				if (parsed?.type !== "session") continue;
				const sessionCwd = String(parsed.cwd ?? "");
				if (known.has(resolve(sessionCwd))) continue; // belongs to a live project
				// Recover this orphan cwd's sessions once.
				for (const s of listSessionsInCwd(sessionCwd)) out.push(s);
				known.add(resolve(sessionCwd)); // don't re-scan the same orphan cwd
				break;
			} catch {
				continue;
			}
		}
	}
	return out;
}

/**
 * Lazily-built index of every session id → its recorded cwd, scanned
 * once across the whole sessions root. findSessionCwd uses it so an
 * orphaned / deleted-project session resume is an O(1) lookup instead
 * of a full filesystem scan every time. Rebuilt on a miss (a brand-new
 * session file pi just wrote may not be in the stale index yet) and
 * invalidated whenever this module writes a new session file (fork).
 */
let cwdIndex: Map<string, string> | null = null;

function buildCwdIndex(): Map<string, string> {
	const idx = new Map<string, string>();
	const root = defaultSessionsRoot();
	if (!existsSync(root)) return idx;
	for (const subdir of readdirSync(root)) {
		const dir = join(root, subdir);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const firstLine = readFirstLine(join(dir, name));
			if (!firstLine) continue;
			try {
				const parsed = JSON.parse(firstLine) as Record<string, unknown>;
				if (parsed?.type === "session" && parsed.id) {
					idx.set(String(parsed.id), String(parsed.cwd ?? ""));
				}
			} catch {
				continue;
			}
		}
	}
	return idx;
}

/**
 * Find which cwd (among the known project cwds) a session id lives in.
 * Used on resume/reconnect to spawn `pi` in the correct project folder.
 * Checks known project cwds first (fast; the common case), then a cached
 * root-wide id→cwd index, rebuilding it on a miss in case pi just wrote
 * a new session file. Returns the absolute cwd, or null if not found.
 */
export function findSessionCwd(sessionId: string, knownCwds: string[]): string | null {
	const checked = new Set<string>();
	for (const cwd of knownCwds) {
		const ac = resolve(cwd);
		if (checked.has(ac)) continue;
		checked.add(ac);
		if (findPiSessionFile(ac, sessionId)) return ac;
	}
	if (cwdIndex === null) cwdIndex = buildCwdIndex();
	let cwd = cwdIndex.get(sessionId);
	if (cwd === undefined) {
		// Miss → a new session file may have appeared since the index was
		// built. Rebuild once and look again.
		cwdIndex = buildCwdIndex();
		cwd = cwdIndex.get(sessionId);
	}
	return cwd || null;
}

/**
 * Find the JSONL file for a session id under the cwd's session dir.
 * Returns the absolute path, or null if no file's first line matches.
 * (Reuses the same first-line `session` header check as
 * readPiSessionMessages.) Public so session-rename can target the file.
 */
export function findPiSessionFile(cwd: string, sessionId: string): string | null {
	const dir = sessionsDirFor(resolve(cwd));
	if (!existsSync(dir)) return null;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dir, name);
		const firstLine = readFirstLine(file);
		if (!firstLine) continue;
		try {
			const parsed = JSON.parse(firstLine) as Record<string, unknown>;
			if (parsed?.type === "session" && String(parsed.id) === sessionId) return file;
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Rename a session by appending a `session_info` line to its JSONL.
 *
 * This is pi's own persistence format — pi itself writes the identical
 * `{"type":"session_info","id":"...","name":"..."}` line when you call
 * `set_session_name`, and reads the last such line back as the session
 * name (the TUI picker and `get_state`'s `sessionName` both come from
 * it). Appending it here lets the sidebar rename ANY session (not just
 * the one currently bound to a live pi child), and because the JSONL is
 * the shared on-disk source of truth the rename is immediately visible
 * to every device. An empty/whitespace name clears it (matches pi's
 * `set_session_name` semantics).
 *
 * Trade-off vs forwarding `set_session_name` to the live child: a
 * currently-active session's pi child keeps its old in-memory name until
 * the next resume re-reads the JSONL — acceptable for a single-user
 * homelab, and the sidebar (which reads the JSONL directly) is correct
 * immediately. Symmetric with how the server already reads these files
 * (session-list.ts, search/).
 */
export function setPiSessionName(cwd: string, sessionId: string, name: string): boolean {
	const file = findPiSessionFile(cwd, sessionId);
	if (!file) return false;
	const line = JSON.stringify({ type: "session_info", id: sessionId, name }) + "\n";
	appendFileSync(file, line);
	return true;
}
/**
 * Read the full message transcript for a session. Used by chat.ts to
 * send a `transcript` server message to the browser on resume, so the
 * user sees the past conversation before the live events arrive.
 *
 * Returns an array of SDK-shape messages (`UserMessage | AssistantMessage |
 * ToolResultMessage`). The renderer can hand these straight to its
 * existing message-node projection.
 */
export function readPiSessionMessages(cwd: string, sessionId: string): Message[] {
	// Locate the JSONL via the shared first-line header check, then read
	// just that one file (previously this rescanned the dir itself).
	const file = findPiSessionFile(cwd, sessionId);
	if (!file) return [];

	// This is the file — now read the full transcript.
	const raw = readFileSync(file, "utf8");
	// Walk every line, collect `type: "message"` entries' `.message` field.
	// pi writes SDK-shape `Message` objects here; cast through unknown
	// since JSON.parse returns unknown and we trust the writer.
	const messages: Message[] = [];
	for (const l of raw.split("\n")) {
		const t = l.trim();
		if (!t) continue;
		try {
			const e = JSON.parse(t) as Record<string, unknown>;
			if (e.type === "message" && e.message) {
				messages.push(e.message as Message);
			} else if (e.type === "custom_message") {
				// Persisted custom message (e.g. pi-voice-reply's voice-reply
				// entry, which carries the long/short spoken variants).
				// pi writes these as top-level `custom_message` JSONL lines,
				// NOT nested under `.message`, so the `type==="message"`
				// branch above skips them. Reconstruct the live event's
				// message shape (role:"custom" + customType + details) so the
				// transcript projection re-attaches the variants to their
				// assistant message on reconnect. Without this, a page refresh
				// / WS reconnect drops the in-memory variants and the
				// Long/Short buttons regenerate (a full LLM round-trip) on
				// every press.
				messages.push({
					role: "custom",
					customType: e.customType,
					content: e.content,
					details: e.details,
				} as unknown as Message);
			}
		} catch {
			/* skip malformed */
		}
	}
	return messages;
}

/**
 * Fork (branch) a session: copy the source session's JSONL into a
 * brand-new session file (fresh id + timestamp, same cwd), keeping
 * only the first `messageCount` `type:"message"` entries plus the
 * metadata lines (session_info, model_change, thinking_level_change)
 * that fall within that prefix. The source file is never modified.
 *
 * This is pi's own persistence format — pi writes the identical lines
 * itself, and on `pi --session <newId>` it scans the session dir for a
 * file whose first-line `session.id` matches and replays the copied
 * transcript as prior context. So a fork is just a truncated copy of
 * the JSONL; the forked chat opens with the conversation up to the
 * fork point and continues from there.
 *
 * Returns the new session id, or null if the source session file
 * couldn't be found. `messageCount` is clamped to [0, total]; a 0 or
 * negative count forks an empty session (just the header).
 */
export function forkPiSession(
	cwd: string,
	sourceSessionId: string,
	messageCount: number,
): string | null {
	const file = findPiSessionFile(cwd, sourceSessionId);
	if (!file) return null;

	const raw = readFileSync(file, "utf8");
	const lines = raw.split("\n");

	// Recover the source `session` header so we can preserve its cwd +
	// version, then rewrite id + timestamp for the fork.
	let header: Record<string, unknown> | null = null;
	for (const l of lines) {
		const t = l.trim();
		if (!t) continue;
		try {
			const parsed = JSON.parse(t) as Record<string, unknown>;
			if (parsed.type === "session") {
				header = parsed;
				break;
			}
		} catch {
			/* skip */
		}
	}
	if (!header) return null;

	const newId = randomUUID();
	const now = new Date();
	const newHeader = {
		type: "session",
		version: header.version,
		id: newId,
		timestamp: now.toISOString(),
		cwd: header.cwd,
	};

	const count = Math.max(0, Math.floor(messageCount));
	const outLines: string[] = [JSON.stringify(newHeader)];
	let copied = 0;
	for (const l of lines) {
		if (copied >= count) break;
		const t = l.trim();
		if (!t) continue;
		try {
			const parsed = JSON.parse(t) as Record<string, unknown>;
			if (parsed.type === "session") continue; // drop the original header
			outLines.push(t);
			if (parsed.type === "message") copied++;
		} catch {
			/* skip malformed */
		}
	}

	const dir = sessionsDirFor(String(header.cwd ?? resolve(cwd)));
	// Match pi's filename convention
	// `<isoTimestamp-with-colons-as-dashes>_<sessionId>.jsonl` so the
	// session dir stays uniform (cosmetic — pi finds files by the
	// first-line id, not the name).
	const stamp = now.toISOString().replace(/:/g, "-");
	const newFile = join(dir, `${stamp}_${newId}.jsonl`);
	writeFileSync(newFile, `${outLines.join("\n")}\n`);
	// A new session file exists now — drop the id→cwd index so the next
	// resume finds this fork without waiting for a miss-triggered rebuild.
	cwdIndex = null;
	return newId;
}
