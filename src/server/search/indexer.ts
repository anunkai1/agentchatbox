/**
 * Walks `pi`'s on-disk session JSONL files and feeds per-message text into the
 * embedding store. Reuses `pi`'s own documented session format — sessions live
 * under `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl`, each line is a
 * JSON record, `type:"message"` records carry the SDK `Message` shape.
 *
 * Indexing is **mtime-driven**: a session is re-indexed only when its JSONL
 * file's mtime changed since the last index. Append-only JSONL means a session
 * that grew gets fully re-embedded (simple + correct; sessions are small).
 *
 * This module deliberately does NOT touch `pi` or the live `session-registry`.
 * It reads files `pi` already wrote, like `session-list.ts` does — pure
 * transport-layer data work, not agent logic.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	listPiSessions,
	sessionsDirFor,
	type SessionSummary,
} from "../session-list.js";
import { embed } from "./embeddings.js";
import { indexSession, isIndexed } from "./store.js";

/** Pull the plain text out of a SDK `Message` content (string or block array). */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
				parts.push(String((block as { text?: string }).text ?? ""));
			}
		}
		return parts.join("");
	}
	return "";
}

interface ParsedMessage {
	msgIdx: number;
	role: string;
	text: string;
	createdAt: string;
}

/**
 * Read a session's JSONL and return one entry per `type:"message"` line, with
 * its sequence index (its position among messages), role, text, and timestamp.
 * Long tool-result blobs are truncated so they don't dominate the embedding.
 */
function readSessionMessages(sessionDir: string, name: string): ParsedMessage[] {
	const file = join(sessionDir, name);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: ParsedMessage[] = [];
	let idx = 0;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(t) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: string; content?: unknown } | undefined;
		if (!msg) continue;
		let text = extractText(msg.content);
		// Truncate very long messages (typically tool output) — keeps the index
		// lean and avoids blowing the embedding context.
		if (text.length > 500) text = `${text.slice(0, 500)}…`;
		out.push({
			msgIdx: idx++,
			role: String(msg.role ?? "unknown"),
			text,
			createdAt: String(entry.timestamp ?? new Date().toISOString()),
		});
	}
	return out;
}

/**
 * Ensure a single session is indexed (re-index if its JSONL changed). Returns
 * the number of messages indexed, or 0 if it was already current.
 */
export async function ensureSessionIndexed(session: SessionSummary): Promise<number> {
	const mtimeIso = session.modifiedAt;
	if (await isIndexed(session.id, mtimeIso)) return 0;

	const dir = sessionsDirFor(resolve(session.cwd));
	// Find the JSONL file whose first-line session id matches.
	let messages: ParsedMessage[] = [];
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(dir, name);
			const firstLine = readFileSync(file, "utf8")
				.split("\n")
				.find((l) => l.trim());
			if (!firstLine) continue;
			try {
				const parsed = JSON.parse(firstLine) as Record<string, unknown>;
				if (parsed.type === "session" && String(parsed.id) === session.id) {
					messages = readSessionMessages(dir, name);
					break;
				}
			} catch {}
		}
	}

	await indexSession(
		{
			sessionId: session.id,
			cwd: session.cwd,
			mtime: mtimeIso,
			msgCount: session.messageCount,
			title: session.title,
			modifiedAt: session.modifiedAt,
		},
		messages,
		embed,
	);
	return messages.length;
}

/**
 * Index every session for a cwd that is new or changed since last index.
 * Returns `{ scanned, indexed }`. Safe to run repeatedly — already-current
 * sessions are a cheap mtime-check no-op.
 */
export async function indexAll(cwd: string): Promise<{ scanned: number; indexed: number }> {
	const sessions = listPiSessions(cwd);
	let indexed = 0;
	for (const s of sessions) {
		try {
			const n = await ensureSessionIndexed(s);
			if (n > 0) indexed++;
		} catch {
			// One bad session shouldn't abort the sweep.
		}
	}
	return { scanned: sessions.length, indexed };
}

/** Re-export the message type for callers that want it. */
export type { Message };
