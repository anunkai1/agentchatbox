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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";

/**
 * Default root for `pi`'s session storage. Overridable via the
 * PI_CODING_AGENT_SESSION_DIR env var (the env var `pi` itself reads).
 */
function defaultSessionsRoot(): string {
	return process.env.PI_CODING_AGENT_SESSION_DIR ?? `${homedir()}/.pi/agent/sessions`;
}

/**
 * The per-cwd subdirectory `pi` writes sessions into. The convention
 * in pi 0.79.x is to strip the leading "/" from the cwd, replace
 * every remaining "/" with "-", and wrap the result in "--"
 * delimiters — so `/home/architect/agentchatbox` becomes
 * `--home-architect-agentchatbox--` (NOT `--/home/...--`).
 *
 * (Earlier versions of the docs described a different convention; the
 * installed binary uses this form. Verified empirically on the host's
 * `~/.pi/agent/sessions/`.)
 */
function sessionsDirFor(cwd: string, root: string = defaultSessionsRoot()): string {
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
	/** Display title — the first user message text, truncated. */
	title: string;
	/** Number of `message` entries in the JSONL. */
	messageCount: number;
}

/**
 * List all sessions for a given cwd, newest first. Skips JSONL files
 * whose first line is malformed (defensive — `pi` should never write
 * a malformed first line, but a torn write on hard kill could).
 */
export function listPiSessions(cwd: string): SessionSummary[] {
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
		// First user message text becomes the title.
		let firstUserText: string | null = null;
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
				}
			} catch {
				/* skip malformed */
			}
		}

		out.push({
			id: String(firstLine.id ?? name.replace(/\.jsonl$/, "")),
			cwd: sessionCwd,
			createdAt: String(firstLine.timestamp ?? st.mtime.toISOString()),
			modifiedAt: st.mtime.toISOString(),
			title: firstUserText ? truncate(firstUserText, 60) : "(empty session)",
			messageCount,
		});
	}

	// Newest first by createdAt.
	out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return out;
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
	const dir = sessionsDirFor(resolve(cwd));
	// Find the JSONL whose first line has matching id.
	if (!existsSync(dir)) return [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dir, name);
		const raw = readFileSync(file, "utf8");
		const firstLine = raw.split("\n").find((l) => l.trim());
		if (!firstLine) continue;
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = JSON.parse(firstLine) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed?.type !== "session" || String(parsed.id) !== sessionId) continue;

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
				}
			} catch {
				/* skip malformed */
			}
		}
		return messages;
	}
	return [];
}

/** Public for tests. */
export const _internal = { sessionsDirFor, defaultSessionsRoot };

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

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}
