/**
 * search/ — pluggability contract tests.
 *
 * The whole point of the search module is that it degrades cleanly to "off"
 * when not enabled or when its optional packages aren't installed. These tests
 * pin that contract so a future change can't accidentally make the core server
 * depend on `better-sqlite3` / `@huggingface/transformers`.
 *
 * We don't test the actual embedding/retrieval path here — it requires the
 * optional native packages and the HuggingFace model. The end-to-end behavior
 * is validated by the upstream project (Resonant) whose design we ported.
 */

import { afterEach, describe, expect, it } from "vitest";

const origFlag = process.env.AGENTCHATBOX_SEARCH_ENABLED;

afterEach(() => {
	if (origFlag === undefined) delete process.env.AGENTCHATBOX_SEARCH_ENABLED;
	else process.env.AGENTCHATBOX_SEARCH_ENABLED = origFlag;
});

describe("search availability (pluggability)", () => {
	it("is unavailable when the enable flag is not set", async () => {
		delete process.env.AGENTCHATBOX_SEARCH_ENABLED;
		const mod = await import("../src/server/search/index.js");
		expect(await mod.isSearchAvailable()).toBe(false);
	});

	it("is unavailable when explicitly disabled", async () => {
		process.env.AGENTCHATBOX_SEARCH_ENABLED = "0";
		const mod = await import("../src/server/search/index.js");
		expect(await mod.isSearchAvailable()).toBe(false);
	});

	it("returns no results when unavailable", async () => {
		delete process.env.AGENTCHATBOX_SEARCH_ENABLED;
		const mod = await import("../src/server/search/index.js");
		const results = await mod.searchSessions("anything");
		expect(results).toEqual([]);
	});

	it("probing availability never throws (even with flag on and packages missing)", async () => {
		process.env.AGENTCHATBOX_SEARCH_ENABLED = "1";
		const mod = await import("../src/server/search/index.js");
		// Must resolve to a boolean, not reject — the core server relies on this
		// probe being total when wiring the /api/health and /api/sessions/search
		// handlers.
		const avail = await mod.isSearchAvailable();
		expect(typeof avail).toBe("boolean");
	});
});

describe("deleteIndexedSession (pluggability)", () => {
	// The delete path must not throw when search is off — chat.ts's
	// deleteSession handler always calls it, so it must be a safe no-op in
	// environments without better-sqlite3 / the optional packages. A throw
	// here would surface as an unhandled rejection in chat.ts's
	// fire-and-forget call.
	it("is a no-op (no throw) when search is disabled", async () => {
		delete process.env.AGENTCHATBOX_SEARCH_ENABLED;
		const mod = await import("../src/server/search/index.js");
		await expect(mod.deleteIndexedSession("any-id")).resolves.toBeUndefined();
	});

	it("does not throw when enabled but packages are missing", async () => {
		process.env.AGENTCHATBOX_SEARCH_ENABLED = "1";
		const mod = await import("../src/server/search/index.js");
		// Search unavailable (no optional packages in this test env) → the
		// delete must bail before touching SQLite and resolve cleanly.
		await expect(mod.deleteIndexedSession("any-id")).resolves.toBeUndefined();
	});
});
