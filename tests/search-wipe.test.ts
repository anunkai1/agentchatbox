import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../src/server/logger.js", () => ({ log: { info: vi.fn(), warn } }));

const dir = mkdtempSync(join(tmpdir(), "acb-search-wipe-"));
const dbPath = join(dir, "search.db");
vi.stubEnv("AGENTCHATBOX_SEARCH_DB", dbPath);
afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

it("logs and backs up an index it wipes for a version mismatch", async () => {
	const old = new Database(dbPath);
	old.exec(`
		CREATE TABLE embeddings (session_id TEXT NOT NULL, msg_idx INTEGER NOT NULL, role TEXT, text TEXT, vector BLOB NOT NULL, created_at TEXT, PRIMARY KEY (session_id, msg_idx));
		CREATE TABLE indexed_sessions (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, mtime TEXT NOT NULL, msg_count INTEGER, title TEXT, modified_at TEXT);
		INSERT INTO indexed_sessions VALUES ('a', '/a', '1', 1, 'a', '2026-01-01');
		PRAGMA user_version = 1;
	`);
	old.close();

	const store = await import("../src/server/search/store.js");
	const db = await store.getDb();

	expect(warn).toHaveBeenCalledWith(
		"search index wiped: format version mismatch",
		expect.objectContaining({ foundVersion: 1, expectedVersion: 2, sessions: 1 }),
	);
	expect(readdirSync(dir).filter((n) => n.startsWith("search.db.pre-wipe-v1-"))).toHaveLength(1);
	expect((db.prepare("SELECT COUNT(*) AS n FROM indexed_sessions").get() as { n: number }).n).toBe(
		0,
	);
});
