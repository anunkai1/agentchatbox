/**
 * Incremental session indexing: transcripts are append-only, so a changed
 * session embeds only its new passages and extends the in-memory cache in
 * place, instead of re-embedding the whole conversation every turn.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const embedCalls: string[][] = [];
/** One-hot vector keyed on the first word, so a query can target one passage. */
const vectorFor = (text: string) => {
	const v = new Float32Array(384);
	v[(text.charCodeAt(0) * 7) % 384] = 1;
	return v;
};
vi.mock("../src/server/search/embeddings.js", async (importActual) => ({
	...(await importActual<typeof import("../src/server/search/embeddings.js")>()),
	embedBatch: async (texts: string[]) => {
		embedCalls.push([...texts]);
		return texts.map(vectorFor);
	},
}));

const dir = mkdtempSync(join(tmpdir(), "acb-search-incr-"));
const sessionsRoot = join(dir, "sessions");
const cwd = "/home/test/project";
vi.stubEnv("AGENTCHATBOX_SEARCH_DB", join(dir, "search.db"));
vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessionsRoot);
const store = await import("../src/server/search/store.js");
const { ensureSessionIndexed } = await import("../src/server/search/indexer.js");

afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

const sessionDir = join(sessionsRoot, "--home-test-project--");
mkdirSync(sessionDir, { recursive: true });
let n = 0;
let file = "";
let id = "";
let clock = 1_800_000_000;

const message = (role: string, text: string) =>
	`${JSON.stringify({ type: "message", timestamp: "2026-10-07T00:00:00Z", message: { role, content: text } })}\n`;
/** Give the file a new mtime, as a real append would. */
const touch = () => {
	clock += 10;
	utimesSync(file, clock, clock);
};
const summary = () =>
	({
		id,
		cwd,
		title: "t",
		modifiedAt: "2026-10-07",
		messageCount: 0,
		// remaining SessionSummary fields are unused by the indexer
	}) as unknown as Parameters<typeof ensureSessionIndexed>[0];
const storedIdx = async () =>
	(
		(await store.getDb())
			.prepare("SELECT msg_idx FROM embeddings WHERE session_id = ? ORDER BY msg_idx")
			.all(id) as Array<{ msg_idx: number }>
	).map((r) => r.msg_idx);

beforeEach(async () => {
	n++;
	id = `incr-${n}`;
	file = join(sessionDir, `2026-10-07T00-00-0${n}_${id}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-07T00:00:00Z", cwd })}\n`,
	);
	embedCalls.length = 0;
	await store.loadCache();
});

describe("incremental indexing", () => {
	it("embeds only the appended passages and makes them searchable immediately", async () => {
		appendFileSync(file, message("user", "alpha question") + message("assistant", "beta answer"));
		touch();
		await ensureSessionIndexed(summary());
		expect(embedCalls).toEqual([["alpha question", "beta answer"]]);

		embedCalls.length = 0;
		appendFileSync(file, message("user", "gamma follow up"));
		touch();
		await ensureSessionIndexed(summary());
		expect(embedCalls).toEqual([["gamma follow up"]]);
		expect(await storedIdx()).toEqual([0, 1, 2]);
		// Found through the in-memory cache without a reload.
		expect(store.searchVectors(vectorFor("gamma"), 1)[0]).toMatchObject({
			sessionId: id,
			text: "gamma follow up",
			msgIdx: 2,
		});
	});

	it("leaves a half-written last line for the next pass and counts it once", async () => {
		appendFileSync(file, message("user", "alpha one"));
		appendFileSync(file, '{"type":"message","timestamp":"t","message":{"role":"assistant","con');
		touch();
		await ensureSessionIndexed(summary());
		expect(embedCalls).toEqual([["alpha one"]]);

		embedCalls.length = 0;
		appendFileSync(file, 'tent":"delta finished"}}\n');
		touch();
		await ensureSessionIndexed(summary());
		expect(embedCalls).toEqual([["delta finished"]]);
		expect(await storedIdx()).toEqual([0, 1]);
	});

	it("does a full re-index when the stored progress is missing or the cwd changed", async () => {
		appendFileSync(file, message("user", "alpha one") + message("assistant", "beta two"));
		touch();
		await ensureSessionIndexed(summary());

		// A database from before progress was recorded.
		(await store.getDb())
			.prepare(
				"UPDATE indexed_sessions SET indexed_bytes = NULL, next_idx = NULL WHERE session_id = ?",
			)
			.run(id);
		await store.loadCache();
		embedCalls.length = 0;
		appendFileSync(file, message("user", "gamma three"));
		touch();
		await ensureSessionIndexed(summary());
		expect(embedCalls).toEqual([["alpha one", "beta two", "gamma three"]]);
		expect(await storedIdx()).toEqual([0, 1, 2]);

		// Progress is recorded again, so the next change is incremental.
		embedCalls.length = 0;
		appendFileSync(file, message("user", "delta four"));
		touch();
		await ensureSessionIndexed(summary());
		expect(embedCalls).toEqual([["delta four"]]);
	});

	it("re-indexes fully if the transcript shrank", async () => {
		appendFileSync(file, message("user", "alpha one") + message("assistant", "beta two"));
		touch();
		await ensureSessionIndexed(summary());
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id, cwd })}\n${message("user", "zeta only")}`,
		);
		touch();
		embedCalls.length = 0;
		await ensureSessionIndexed(summary());
		expect(embedCalls).toEqual([["zeta only"]]);
		expect(await storedIdx()).toEqual([0]);
	});
});
