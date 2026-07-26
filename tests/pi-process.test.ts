import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PiProcess, spawnPi } from "../src/server/pi-process.js";

const tempDirs: string[] = [];
const children: PiProcess[] = [];

async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENTCHATBOX_FAKE_PI_ARGS;
});

describe("PiProcess", () => {
	it("starts RPC children offline so startup probes cannot block a chat", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agentchatbox-pi-process-"));
		tempDirs.push(dir);
		const bin = join(dir, "fake-pi");
		const argsFile = join(dir, "args.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$AGENTCHATBOX_FAKE_PI_ARGS"\nwhile IFS= read -r _line; do :; done\n`,
			{ mode: 0o755 },
		);
		process.env.AGENTCHATBOX_FAKE_PI_ARGS = argsFile;

		const child = spawnPi({
			bin,
			provider: "zai",
			modelId: "glm-5.2",
			thinkingLevel: "high",
			apiKey: "test-dummy",
			cwd: dir,
		});
		children.push(child);

		await waitForFile(argsFile);
		expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
			"--mode",
			"rpc",
			"--offline",
			"--provider",
			"zai",
			"--model",
			"glm-5.2",
			"--thinking",
			"high",
		]);
	});
});
