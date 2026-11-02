import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BUNDLED_EXTENSIONS, runSetup } from "../scripts/setup.mjs";

const sandboxes: string[] = [];

function makeSandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "acb-setup-test-"));
	sandboxes.push(dir);
	writeFileSync(join(dir, ".env.example"), "PORT=3000\nHOST=127.0.0.1\n");
	for (const name of [...DEFAULT_BUNDLED_EXTENSIONS, "openai-models"]) {
		const extDir = join(dir, "extensions", name);
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "package.json"), JSON.stringify({ name }));
	}
	return dir;
}

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("npm run setup", () => {
	it("creates .env and registers portable bundled extensions without enabling opinionated filters", () => {
		const rootDir = makeSandbox();
		const settingsFile = join(rootDir, ".pi", "agent", "settings.json");
		const authFile = join(rootDir, ".pi", "agent", "auth.json");

		const first = runSetup({ rootDir, settingsFile, authFile, quiet: true });
		expect(first.createdEnv).toBe(true);
		expect(existsSync(join(rootDir, ".env"))).toBe(true);
		expect(first.addedExtensions).toEqual(DEFAULT_BUNDLED_EXTENSIONS);
		expect(first.authedProviders).toEqual([]);

		const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as { packages: string[] };
		expect(settings.packages).toHaveLength(DEFAULT_BUNDLED_EXTENSIONS.length);
		expect(settings.packages.some((p) => p.includes("openai-models"))).toBe(false);

		// Idempotent on second run and never overwrites custom .env edits.
		writeFileSync(join(rootDir, ".env"), "PORT=4100\n");
		const second = runSetup({ rootDir, settingsFile, authFile, quiet: true });
		expect(second.createdEnv).toBe(false);
		expect(second.addedExtensions).toEqual([]);
		expect(readFileSync(join(rootDir, ".env"), "utf8")).toBe("PORT=4100\n");
	});
});
