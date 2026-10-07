import { statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { extractText } from "../../shared/content.js";
import {
	findPiSessionFile,
	jsonlLineType,
	parseJsonl,
	type SessionSummary,
} from "../session-list.js";
import { embedBatch } from "./embeddings.js";
import { indexedSessionState, indexSession, isIndexed } from "./store.js";

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

type Passage = { msgIdx: number; role: string; text: string; createdAt: string };

/** The searchable passages of one JSONL entry (none unless it is a user/assistant message). */
function entryPassages(
	entry: Record<string, unknown>,
): Array<{ role: string; text: string; createdAt: string }> {
	if (entry.type !== "message") return [];
	const message = entry.message as { role?: string; content?: unknown } | undefined;
	if (message?.role !== "user" && message?.role !== "assistant") return [];
	const role = message.role;
	return chunkText(extractText(message.content)).map((text) => ({
		role,
		text,
		createdAt: String(entry.timestamp ?? ""),
	}));
}

export function searchableChunks(raw: string): Passage[] {
	const chunks: Passage[] = [];
	for (const entry of parseJsonl(raw)) {
		// msgIdx is the stable passage ordinal in this derived index, not a transcript offset.
		for (const passage of entryPassages(entry)) chunks.push({ msgIdx: chunks.length, ...passage });
	}
	return chunks;
}

/**
 * Read the complete lines of a transcript from `startByte` on, one 1 MiB read
 * at a time, so a 150 MiB session never sits in memory. Passages are numbered
 * from `startIdx`. A trailing line without its newline (pi is mid-write) is
 * left for the next pass: `endByte` stops at the last newline consumed.
 */
async function readPassages(
	file: string,
	startByte: number,
	startIdx: number,
): Promise<{ passages: Passage[]; endByte: number }> {
	const passages: Passage[] = [];
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let pending: Buffer[] = [];
		let position = startByte;
		let endByte = startByte;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			let from = 0;
			for (;;) {
				const newline = chunk.indexOf(0x0a, from);
				if (newline < 0) break;
				const line = Buffer.concat([...pending, chunk.subarray(from, newline)]).toString("utf8");
				pending = [];
				endByte = position + newline + 1;
				from = newline + 1;
				const text = line.trim();
				if (!text) continue;
				// Only message entries are searchable; skip parsing the rest. (Pi
				// writes `type` first; if it is not, parse and let entryPassages decide.)
				const type = jsonlLineType(text);
				if (type !== null && type !== "message") continue;
				try {
					const entry = JSON.parse(text) as Record<string, unknown>;
					for (const passage of entryPassages(entry)) {
						passages.push({ msgIdx: startIdx + passages.length, ...passage });
					}
				} catch {
					/* skip malformed */
				}
			}
			// Copy: `buffer` is reused by the next read.
			if (from < chunk.length) pending.push(Buffer.from(chunk.subarray(from)));
			position += bytesRead;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		return { passages, endByte };
	} finally {
		await handle.close();
	}
}

/** Does byte `offset - 1` of the file end a line (so indexing can resume at `offset`)? */
async function endsAtLineBoundary(file: string, offset: number): Promise<boolean> {
	if (offset <= 0) return false;
	const handle = await open(file, "r");
	try {
		const one = Buffer.alloc(1);
		const { bytesRead } = await handle.read(one, 0, 1, offset - 1);
		return bytesRead === 1 && one[0] === 0x0a;
	} finally {
		await handle.close();
	}
}

export async function ensureSessionIndexed(session: SessionSummary): Promise<number> {
	const file = findPiSessionFile(session.cwd, session.id);
	if (!file) return 0;
	const { mtimeMs, size } = await stat(file);
	const stamp = mtimeMs.toString();
	if (await isIndexed(session.id, stamp)) return 0;

	// Transcripts are append-only: resume after what is already indexed, as
	// long as it was recorded for this same file (a move rewrites the header,
	// so a changed cwd means the offsets no longer apply).
	const prior = indexedSessionState(session.id);
	const append =
		prior !== undefined &&
		prior.cwd === session.cwd &&
		prior.indexedBytes !== undefined &&
		prior.nextIdx !== undefined &&
		prior.indexedBytes <= size &&
		(await endsAtLineBoundary(file, prior.indexedBytes));
	const startByte = append ? prior.indexedBytes! : 0;
	const startIdx = append ? prior.nextIdx! : 0;

	const { passages, endByte } = await readPassages(file, startByte, startIdx);
	await indexSession(
		{
			sessionId: session.id,
			cwd: session.cwd,
			mtime: stamp,
			msgCount: session.messageCount,
			title: session.title,
			modifiedAt: session.modifiedAt,
			indexedBytes: endByte,
			nextIdx: startIdx + passages.length,
		},
		passages,
		embedBatch,
		() => {
			try {
				return statSync(file).mtimeMs.toString() === stamp;
			} catch {
				return false;
			}
		},
		{ append },
	);
	return passages.length;
}
