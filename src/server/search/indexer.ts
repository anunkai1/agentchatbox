import { readFileSync, statSync } from "node:fs";
import { extractText } from "../../shared/content.js";
import { findPiSessionFile, parseJsonl, type SessionSummary } from "../session-list.js";
import { embed } from "./embeddings.js";
import { indexSession, isIndexed } from "./store.js";

/** Small overlapping passages fit the existing MiniLM model better than whole replies. */
export function chunkText(text: string): string[] {
	const chunks: string[] = [];
	const words = text.trim().split(/\s+/).filter(Boolean);
	for (let start = 0; start < words.length; start += 96) {
		chunks.push(words.slice(start, start + 128).join(" "));
		if (start + 128 >= words.length) break;
	}
	return chunks;
}

export function searchableChunks(raw: string) {
	const chunks: Array<{ msgIdx: number; role: string; text: string; createdAt: string }> = [];
	for (const entry of parseJsonl(raw)) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		for (const text of chunkText(extractText(message.content))) {
			// msgIdx is the stable passage ordinal in this derived index, not a transcript offset.
			chunks.push({
				msgIdx: chunks.length,
				role: message.role,
				text,
				createdAt: String(entry.timestamp ?? ""),
			});
		}
	}
	return chunks;
}

export async function ensureSessionIndexed(session: SessionSummary): Promise<number> {
	const file = findPiSessionFile(session.cwd, session.id);
	if (!file) return 0;
	const stamp = statSync(file).mtimeMs.toString();
	if (await isIndexed(session.id, stamp)) return 0;
	const chunks = searchableChunks(readFileSync(file, "utf8"));
	await indexSession(
		{
			sessionId: session.id,
			cwd: session.cwd,
			mtime: stamp,
			msgCount: session.messageCount,
			title: session.title,
			modifiedAt: session.modifiedAt,
		},
		chunks,
		embed,
		() => {
			try {
				return statSync(file).mtimeMs.toString() === stamp;
			} catch {
				return false;
			}
		},
	);
	return chunks.length;
}
