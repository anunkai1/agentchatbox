import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_KEYS, SDK_PROVIDERS } from "../src/server/providers.js";

describe("providers and boot-probe fallback", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		delete process.env.AGENTCHATBOX_PI_AUTH_FILE;
		vi.resetModules();
	});

	it("tracks antigravity-acp and local in PROVIDER_KEYS without placing them in SDK_PROVIDERS", () => {
		expect(PROVIDER_KEYS).toContain("antigravity-acp");
		expect(PROVIDER_KEYS).toContain("local");
		expect(SDK_PROVIDERS).not.toContain("antigravity-acp");
		expect(SDK_PROVIDERS).not.toContain("local");
		expect(SDK_PROVIDERS).not.toContain("venice");
	});

	it("falls back to models.json and models-store.json when only non-SDK providers have auth", async () => {
		const dir = mkdtempSync(join(tmpdir(), "acb-boot-probe-"));
		dirs.push(dir);
		const authFile = join(dir, "auth.json");
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env.AGENTCHATBOX_PI_AUTH_FILE = authFile;

		writeFileSync(authFile, JSON.stringify({ local: { type: "api_key", key: "local-key" } }));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: { models: [{ id: "qwen3.8-27b-ud-q3" }] },
				},
			}),
		);

		vi.resetModules();
		let { pickBootProbe } = await import("../src/server/models-cache.js");
		expect(pickBootProbe(agentDir)).toEqual({
			provider: "local",
			modelId: "qwen3.8-27b-ud-q3",
		});

		writeFileSync(
			authFile,
			JSON.stringify({ "antigravity-acp": { type: "oauth", access: "tok" } }),
		);
		writeFileSync(
			join(agentDir, "models-store.json"),
			JSON.stringify({
				providers: {
					"antigravity-acp": { models: [{ id: "gemini-4-hydrogen" }] },
				},
			}),
		);

		expect(pickBootProbe(agentDir)).toEqual({
			provider: "antigravity-acp",
			modelId: "gemini-4-hydrogen",
		});
	});
});
