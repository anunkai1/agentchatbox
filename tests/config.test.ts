/**
 * config.ts — provider key resolution.
 *
 * `getServerApiKey` is the single source of truth for a provider's API
 * key: it reads `pi`'s auth.json (the file `pi auth login`/`logout`
 * writes), NOT process.env. This keeps ACB in lockstep with `pi`'s own
 * auth state — a `logout` removes the provider from the picker and from
 * the spawned-children env on the next request, with no ACB restart and
 * no second key store to drift out of sync.
 *
 * These tests point AGENTCHATBOX_PI_AUTH_FILE at a temp auth.json so the
 * suite is hermetic: it does NOT read (or depend on) the operator's real
 * ~/.pi/agent/auth.json. (Previously the suite set *_API_KEY env vars,
 * which stopped affecting getServerApiKey once it moved to auth.json —
 * the tests passed only on machines whose real auth.json happened to
 * lack those providers, and failed here.)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let authFile: string;
let authDir: string;

beforeEach(() => {
	authDir = mkdtempSync(join(tmpdir(), "acb-config-auth-"));
	authFile = join(authDir, "auth.json");
	process.env.AGENTCHATBOX_PI_AUTH_FILE = authFile;
});

afterEach(() => {
	delete process.env.AGENTCHATBOX_PI_AUTH_FILE;
	try {
		rmSync(authDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

/** Write a fresh auth.json and re-import config so it re-reads PI_AUTH_PATH. */
async function withAuth(auth: Record<string, unknown>) {
	writeFileSync(authFile, JSON.stringify(auth));
	vi.resetModules();
	return (await import("../src/server/config.js")) as {
		getServerApiKey: (provider: string) => string | undefined;
		readPiAuth: () => Map<string, string>;
	};
}

describe("getServerApiKey — auth.json is the single source of truth", () => {
	it("returns the key recorded in pi's auth.json", async () => {
		const { getServerApiKey } = await withAuth({
			deepseek: { key: "ds-secret" },
		});
		expect(getServerApiKey("deepseek")).toBe("ds-secret");
	});

	it("is case-insensitive on the provider id (auth.json stores lowercase)", async () => {
		const { getServerApiKey } = await withAuth({
			zai: { key: "zai-secret" },
		});
		expect(getServerApiKey("ZAI")).toBe("zai-secret");
		expect(getServerApiKey("zai")).toBe("zai-secret");
	});

	it("resolves to undefined for a provider not in auth.json", async () => {
		const { getServerApiKey } = await withAuth({
			deepseek: { key: "ds-secret" },
		});
		// Not "" — undefined, so the key-presence gate in session-registry /
		// models-cache treats it as genuinely unset.
		expect(getServerApiKey("anthropic")).toBeUndefined();
	});

	it("ignores entries whose key is blank, null, or non-string", async () => {
		const { getServerApiKey, readPiAuth } = await withAuth({
			deepseek: { key: "ds-secret" },
			empty: { key: "" },
			whitespace: { key: "   " },
			nullkey: { key: null },
			notstring: { key: 12345 },
		});
		expect(readPiAuth().get("deepseek")).toBe("ds-secret");
		expect(getServerApiKey("empty")).toBeUndefined();
		expect(getServerApiKey("whitespace")).toBeUndefined();
		expect(getServerApiKey("nullkey")).toBeUndefined();
		expect(getServerApiKey("notstring")).toBeUndefined();
	});

	it("returns undefined for everything when auth.json is missing/unreadable", async () => {
		// Point at a path that doesn't exist on disk.
		process.env.AGENTCHATBOX_PI_AUTH_FILE = join(authDir, "nope.json");
		vi.resetModules();
		const { getServerApiKey } = await import("../src/server/config.js");
		expect(getServerApiKey("deepseek")).toBeUndefined();
		expect(getServerApiKey("anthropic")).toBeUndefined();
	});

	it("returns undefined for everything when auth.json is malformed", async () => {
		writeFileSync(authFile, "{ this is not valid json");
		vi.resetModules();
		const { getServerApiKey } = await import("../src/server/config.js");
		expect(getServerApiKey("deepseek")).toBeUndefined();
	});
});
