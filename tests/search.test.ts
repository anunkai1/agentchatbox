import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "acb-search-test-"));
vi.stubEnv("AGENTCHATBOX_SEARCH_DB", join(dir, "search.db"));
const store = await import("../src/server/search/store.js");
const { chunkText, searchableChunks } = await import("../src/server/search/indexer.js");
afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

const vector = (score = 1) => {
	const v = new Float32Array(384);
	v[0] = score;
	return v;
};
const meta = (id: string, cwd = "/a", mtime = "1") => ({
	sessionId: id,
	cwd,
	mtime,
	msgCount: 1,
	title: id,
	modifiedAt: "2026-01-01",
});
const passage = (msgIdx: number, text = "conversation") => ({
	msgIdx,
	role: "user",
	text,
	createdAt: "2026-01-01",
});

describe("semantic search passages", () => {
	it("preserves later text and overlaps bounded passages", () => {
		const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
		const chunks = chunkText(words.join(" "));
		expect(chunks.at(-1)).toContain("word399");
		expect(chunks[0]).toContain("word96");
		expect(chunks[1]).toContain("word96");
		expect(chunks.every((c) => c.split(" ").length <= 128)).toBe(true);
	});
	it("ignores tool output and indexes conversational text", () => {
		const raw = ["user", "toolResult", "assistant"]
			.map((role) => JSON.stringify({ type: "message", message: { role, content: "hello" } }))
			.join("\n");
		expect(searchableChunks(raw).map((c) => c.role)).toEqual(["user", "assistant"]);
	});
});

describe("semantic search store", () => {
	it("filters before limiting, deduplicates conversations and updates metadata", async () => {
		await store.loadCache();
		await store.indexSession(meta("one"), [passage(0), passage(1)], async () => vector());
		await store.indexSession(meta("two", "/b"), [passage(0)], async () => vector(0.8));
		expect(store.searchVectors(vector(), 10).map((h) => h.sessionId)).toEqual(["one", "two"]);
		expect(store.searchVectors(vector(), 1, "/b")[0].sessionId).toBe("two");
		await store.indexSession(
			{ ...meta("one", "/a", "2"), title: "Renamed" },
			[passage(0, "updated")],
			async () => vector(),
		);
		expect(store.searchVectors(vector(), 1)[0]).toMatchObject({
			title: "Renamed",
			text: "updated",
		});
		expect(await store.isIndexed("one", "1")).toBe(false);
		await store.loadCache();
		expect(store.searchVectors(vector(), 1)[0].title).toBe("Renamed");
		await store.deleteSession("one");
		expect(store.searchVectors(vector(), 10).map((h) => h.sessionId)).toEqual(["two"]);
	});
	it("does not commit embeddings if the source changes or disappears", async () => {
		await store.indexSession(
			meta("deleted"),
			[passage(0)],
			async () => vector(),
			() => false,
		);
		expect(await store.isIndexed("deleted", "1")).toBe(false);
	});
});
