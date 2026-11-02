import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Delegation, readDelegation, writeDelegation } from "../extensions/delegate/lib.js";
import { type RecoveryClient, type RecoverySnapshot, recoverWorkers } from "../extensions/delegate/recovery.js";
import { PromptReceipts } from "../src/server/prompt-receipts.js";
import { recordTransportStop } from "../src/shared/transport-state.js";

const origin = "http://127.0.0.1:3500";
const model = { provider: "openai", modelId: "test", thinkingLevel: "high" };
let dir: string;
let state: RecoverySnapshot;
let notify: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let client: RecoveryClient;

function worker(id: string, overrides: Partial<Delegation> = {}): Delegation {
	const record: Delegation = { id, title: id, task: "Approved task", cwd: tmpdir(), parentSessionId: "parent-1",
		parentModel: model, workerModel: model, status: "working", reportSeq: 0,
		createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z",
		recovery: { version: 1, origin, bootId: "boot-1", startedAt: Date.now() - 1000 }, ...overrides };
	writeDelegation(record, dir);
	return record;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "acb-recovery-"));
	vi.stubEnv("ACB_TRANSPORT_STATE_DIR", join(dir, "transport"));
	state = { bootId: "boot-2", sessions: [] };
	notify = vi.fn();
	send = vi.fn();
	const stores = new Map<string, PromptReceipts>();
	client = {
		snapshot: vi.fn(async () => state),
		resume: vi.fn(async (record, requestId) => {
			if (!stores.has(state.bootId)) stores.set(state.bootId, new PromptReceipts(origin, state.bootId));
			return stores.get(state.bootId)!.submit(requestId, record.id, `/delegate recover ${record.id}`, async () => send);
		}),
		report: vi.fn(async () => {}),
	};
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const recover = (final = false) => recoverWorkers(client, origin, notify, { dir, final });

describe("delegated worker startup recovery", () => {
	it("resumes the same worker after restart and deduplicates repeated/concurrent startup passes", async () => {
		worker("worker-1");
		await Promise.all([recover(), recover()]);
		await recover();
		expect(client.resume).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1", cwd: tmpdir() }), expect.stringMatching(/^recovery-/));
		expect(send).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
	});

	it("asks instead of executing again after a second restart", async () => {
		worker("worker-1");
		await recover();
		state = { bootId: "boot-3", sessions: [] };
		await recover();
		expect(send).toHaveBeenCalledTimes(1);
		expect(readDelegation("worker-1", dir)).toMatchObject({ status: "needs_input", reportSeq: 1 });
		expect(notify).toHaveBeenCalledTimes(1);
		expect(client.report).toHaveBeenCalledTimes(1);
		await recover();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("ignores legacy, never-started, same-boot, foreign-origin, live and terminal workers", async () => {
		worker("legacy", { recovery: undefined });
		const queued = worker("queued"); queued.recovery!.startedAt = 0; writeDelegation(queued, dir);
		const same = worker("same"); same.recovery!.bootId = "boot-2"; writeDelegation(same, dir);
		const foreign = worker("foreign"); foreign.recovery!.origin = "http://127.0.0.1:3501"; writeDelegation(foreign, dir);
		worker("live"); state.sessions.push({ sessionId: "live" });
		for (const status of ["done", "failed", "stopped", "needs_input"] as const) worker(status, { status });
		await recover();
		expect(client.resume).not.toHaveBeenCalled();
	});

	it("honours a stop even if the worker died before saving its aborted status", async () => {
		worker("worker-1"); recordTransportStop(origin, "worker-1");
		await recover();
		expect(client.resume).not.toHaveBeenCalled();
		expect(readDelegation("worker-1", dir)?.status).toBe("stopped");
	});

	it("asks for input rather than bypassing a pending approval dialog", async () => {
		const record = worker("worker-1"); record.recovery!.waitingForInput = true; writeDelegation(record, dir);
		await recover();
		expect(client.resume).not.toHaveBeenCalled();
		expect(readDelegation("worker-1", dir)?.status).toBe("needs_input");
	});

	it("does not assume workers are dead when transport is unavailable", async () => {
		worker("worker-1"); vi.mocked(client.snapshot).mockRejectedValue(new Error("offline"));
		await expect(recover()).rejects.toThrow("offline");
		expect(client.resume).not.toHaveBeenCalled();
		expect(readDelegation("worker-1", dir)?.status).toBe("working");
	});

	it("retries capacity errors without using the automatic submission, then escalates at its bound", async () => {
		worker("worker-1"); vi.mocked(client.resume).mockRejectedValue(new Error("capacity"));
		expect(await recover()).toBe(1);
		expect(readDelegation("worker-1", dir)?.status).toBe("working");
		await recover(true);
		expect(readDelegation("worker-1", dir)?.status).toBe("needs_input");
		expect(send).not.toHaveBeenCalled();
	});

	it("surfaces an ambiguous submission instead of retrying it", async () => {
		worker("worker-1");
		vi.mocked(client.resume).mockResolvedValue({ bootId: "boot-1", delivery: "uncertain" });
		await recover();
		expect(readDelegation("worker-1", dir)).toMatchObject({ status: "needs_input", summary: expect.stringContaining("uncertain") });
		expect(send).not.toHaveBeenCalled();
	});

	it("does not overwrite an owner's intervening completion or resume", async () => {
		const record = worker("worker-1");
		vi.mocked(client.resume).mockImplementation(async () => {
			writeDelegation({ ...record, status: "done" }, dir);
			return { bootId: "boot-1", delivery: "uncertain" };
		});
		await recover();
		expect(readDelegation("worker-1", dir)?.status).toBe("done");
		expect(notify).not.toHaveBeenCalled();
	});
});
