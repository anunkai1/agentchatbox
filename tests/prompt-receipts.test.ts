import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptReceipts } from "../src/server/prompt-receipts.js";
import { recordTransportStop, transportStoppedSince } from "../src/shared/transport-state.js";

let dir: string;
const origin = "http://127.0.0.1:3500";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "acb-receipts-")); vi.stubEnv("ACB_TRANSPORT_STATE_DIR", dir); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("durable prompt receipts", () => {
	it("deduplicates concurrent requests and replay after a process incarnation changes", async () => {
		const send = vi.fn();
		const prepare = vi.fn(async () => send);
		const receipts = new PromptReceipts(origin, "boot-1");
		const [a, b] = await Promise.all([
			receipts.submit("request-1", "worker-1", "continue", prepare),
			receipts.submit("request-1", "worker-1", "continue", prepare),
		]);
		expect(a).toEqual(b);
		expect(send).toHaveBeenCalledTimes(1);
		expect(prepare).toHaveBeenCalledTimes(1);
		const replay = await new PromptReceipts(origin, "boot-2").submit("request-1", "worker-1", "continue", prepare);
		expect(replay).toMatchObject({ bootId: "boot-1", delivery: "submitted" });
		expect(send).toHaveBeenCalledTimes(1);
		await expect(receipts.submit("request-1", "worker-1", "different", prepare)).rejects.toThrow("another message");
	});

	it("a capacity/readiness failure before reservation can be retried safely", async () => {
		const receipts = new PromptReceipts(origin, "boot-1");
		await expect(receipts.submit("request-1", "worker-1", "continue", async () => { throw new Error("capacity"); })).rejects.toThrow("capacity");
		const send = vi.fn();
		await receipts.submit("request-1", "worker-1", "continue", async () => send);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("SIGKILL in the submission window never repeats an uncertain command (effect=%s)", async (effect) => {
		const effectFile = join(dir, "external-effect");
		const script = `import { PromptReceipts } from ${JSON.stringify(resolve("src/server/prompt-receipts.ts"))};
			import { writeFileSync } from 'node:fs';
			await new PromptReceipts(${JSON.stringify(origin)}, 'boot-1').submit('request-1', 'worker-1', 'continue', async () => () => {
				${effect ? `writeFileSync(${JSON.stringify(effectFile)}, 'committed');` : ""}
				process.kill(process.pid, 'SIGKILL');
			});`;
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: process.env, encoding: "utf8", timeout: 20_000 });
		expect(child.signal, child.stderr).toBe("SIGKILL");
		const send = vi.fn();
		const replay = await new PromptReceipts(origin, "boot-2").submit("request-1", "worker-1", "continue", async () => send);
		expect(replay.delivery).toBe("uncertain");
		expect(send).not.toHaveBeenCalled();
	});

	it("corrupt receipts fail closed rather than permitting another execution", async () => {
		const receipts = new PromptReceipts(origin, "boot-1");
		await receipts.submit("request-1", "worker-1", "continue", async () => () => {});
		writeFileSync(join(dir, "3500", "requests", "request-1.json"), "broken");
		await expect(receipts.submit("request-1", "worker-1", "continue", async () => () => {})).rejects.toThrow();
	});

	it("stop markers survive process replacement and are scoped to the server and run", () => {
		const before = Date.now() - 1000;
		recordTransportStop(origin, "worker-1");
		expect(transportStoppedSince(origin, "worker-1", before)).toBe(true);
		expect(transportStoppedSince(origin, "worker-1", Date.now() + 1000)).toBe(false);
		expect(transportStoppedSince("http://127.0.0.1:3501", "worker-1", before)).toBe(false);
	});
});
