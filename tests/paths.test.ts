/**
 * paths.ts
 *
 * The whole point of this module is to be cwd-independent. These
 * tests verify that the resolved project root is the same no matter
 * which directory the process was started in.
 *
 * Regression for the bug fixed in
 *   fix/cwd-and-subscription-leak
 * which replaced `process.cwd()` calls with `projectRoot` derived from
 * `import.meta.url`.
 *
 * The "different cwd" test uses `tsx` (already a devDependency) to
 * execute the module's source under a fresh process. Plain `node`
 * can't load `.ts` files — only `tsx`/`ts-node`/vitest's own loader
 * can — and we want a real subprocess boundary so the module's
 * top-level `projectRoot` calculation runs fresh, not via Vitest's
 * module cache.
 */

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileP = promisify(execFile);

const here = resolvePath(fileURLToPath(import.meta.url), "..");
const projectRoot = resolvePath(here, "..");
const pathsModule = resolvePath(projectRoot, "src/server/paths.ts");
const tsxBin = resolvePath(projectRoot, "node_modules/.bin/tsx");

describe("projectRoot", () => {
	it("resolves to a directory that contains package.json", async () => {
		const s = await stat(`${projectRoot}/package.json`);
		expect(s.isFile()).toBe(true);
	});

	it("is the same regardless of the caller's cwd", async () => {
		// Run a small tsx script that imports paths.ts from two
		// different cwds and prints the resolved project root each
		// time. The two outputs should match.
		const tmp = await mkdtemp(join(tmpdir(), "paths-test-"));
		const probe = join(tmp, "probe.ts");
		try {
			await writeFile(
				probe,
				`import { projectRoot } from ${JSON.stringify(pathsModule)};
				 process.stdout.write(projectRoot + "\\n");`,
			);

			// From the real project root.
			const fromReal = (await execFileP(tsxBin, [probe], { cwd: projectRoot })).stdout.trim();

			// From /tmp.
			const fromTmp = (await execFileP(tsxBin, [probe], { cwd: "/tmp" })).stdout.trim();

			// Both should resolve to the same real path on disk. realpath
			// collapses symlinks so we don't get false negatives from
			// /var vs /var/tmp on systems with that quirk.
			expect(await realpath(fromTmp)).toBe(await realpath(fromReal));
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});
});
