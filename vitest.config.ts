import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config. We only run server-side tests today; the client bundle
 * is exercised by the manual smoke suite in `scripts/*-smoke.mjs` and
 * the headless check-page script.
 *
 * If client-side tests are added later, they will need a DOM environment
 * (jsdom or happy-dom) and a separate config file — keeping that out of
 * scope for the initial CI setup.
 */
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		// Never let an accidental import-time store use production uploads.
		env: { UPLOADS_DIR: mkdtempSync(join(tmpdir(), "acb-test-uploads-")) },
		globalSetup: ["./tests/upload-test-sandbox.ts"],
		// Server tests boot an express listener on an ephemeral port. Keep
		// the default 5s timeout — the smoke round-trip should be fast.
		hookTimeout: 10_000,
	},
});
