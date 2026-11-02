import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config. Tests run in Node; tests/ui-smoke.test.ts drives the client
 * bundle in headless Chromium through playwright-core.
 */
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		// Never let an accidental import-time store use production uploads.
		env: {
			UPLOADS_DIR: mkdtempSync(join(tmpdir(), "acb-test-uploads-")),
			// Chat tests send setThinking, which saves into pi's settings file.
			AGENTCHATBOX_PI_SETTINGS_FILE: join(
				mkdtempSync(join(tmpdir(), "acb-test-pi-")),
				"settings.json",
			),
		},
		globalSetup: ["./tests/upload-test-sandbox.ts"],
		// Server tests boot an express listener on an ephemeral port. Keep
		// the default 5s timeout — the smoke round-trip should be fast.
		hookTimeout: 10_000,
		// Vitest's 1s expect.poll default is too tight for Playwright UI
		// assertions when all suites contend on a 4-vCPU CI runner.
		expect: {
			poll: {
				timeout: 5_000,
			},
		},
	},
});
