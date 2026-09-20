import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), index: vi.fn(), remove: vi.fn(), load: vi.fn() }));
vi.mock("../src/server/config.js", () => ({ config: { piCwd: "/global" } }));
vi.mock("../src/server/projects.js", () => ({ listProjects: () => [{ cwd: "/project" }] }));
vi.mock("../src/server/session-list.js", () => ({ listAllSessions: mocks.list }));
vi.mock("../src/server/search/indexer.js", () => ({ ensureSessionIndexed: mocks.index }));
vi.mock("../src/server/search/embeddings.js", () => ({
	isEmbeddingAvailable: async () => true,
	embed: vi.fn(),
}));
vi.mock("../src/server/search/store.js", () => ({
	isStoreAvailable: async () => true,
	loadCache: mocks.load,
	indexedSessionIds: () => ["removed"],
	deleteSession: mocks.remove,
	searchVectors: vi.fn(),
}));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	mocks.load.mockResolvedValue(undefined);
	vi.stubEnv("AGENTCHATBOX_SEARCH_ENABLED", "1");
	mocks.list.mockReturnValue([{ id: "new" }]);
});

it("reconciles all projects and deletions on every refresh", async () => {
	const search = await import("../src/server/search/index.js");
	await search.refreshSearchIndex();
	expect(mocks.list).toHaveBeenCalledWith(["/global", "/project"]);
	expect(mocks.remove).toHaveBeenCalledWith("removed");
	expect(mocks.index).toHaveBeenCalledWith({ id: "new" });
	mocks.list.mockReturnValue([{ id: "updated" }]);
	await search.refreshSearchIndex();
	expect(mocks.index).toHaveBeenCalledWith({ id: "updated" });
	expect(mocks.load).toHaveBeenCalledTimes(1);
	expect(search.searchStatus()).toEqual({ indexing: false, error: null, progress: null });
});

it("reports sweep progress while indexing and clears it after", async () => {
	const search = await import("../src/server/search/index.js");
	mocks.list.mockReturnValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
	const seen: Array<{ done: number; total: number } | null> = [];
	mocks.index.mockImplementation(async () => {
		// Snapshot: the sweep mutates one progress object in place, so a stored
		// reference would read its final value at assertion time.
		const p = search.searchStatus().progress;
		seen.push(p ? { ...p } : null);
	});
	const sweep = search.refreshSearchIndex();
	await sweep;
	// The first session is indexed before any counter moves: 0 of 3, then 1, 2.
	expect(seen).toEqual([
		{ done: 0, total: 3 },
		{ done: 1, total: 3 },
		{ done: 2, total: 3 },
	]);
	expect(search.searchStatus().progress).toBeNull();
});

it("reports per-session indexing failures rather than silently hiding them", async () => {
	mocks.index.mockRejectedValueOnce(new Error("test failure"));
	const search = await import("../src/server/search/index.js");
	await search.refreshSearchIndex();
	expect(search.searchStatus().error).toBe("1 conversations could not be indexed");
});

it("disabled search never opens the index", async () => {
	vi.stubEnv("AGENTCHATBOX_SEARCH_ENABLED", "0");
	const search = await import("../src/server/search/index.js");
	await search.refreshSearchIndex();
	expect(mocks.load).not.toHaveBeenCalled();
});
