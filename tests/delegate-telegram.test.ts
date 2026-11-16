import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDelegation } from "../extensions/delegate/lib.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
const { default: registerDelegate, sendTelegram } = await import("../extensions/delegate/index.js");

let dir: string | undefined;
afterEach(() => {
	vi.unstubAllEnvs();
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
});

describe("delegate notification context", () => {
	it("passes the given session identity and model to the reply-capable helper", () => {
		const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() };
		spawn.mockReturnValue(child);
		sendTelegram("Worker needs input", "worker-session", {
			provider: "openai",
			modelId: "gpt",
			thinkingLevel: "high",
		});
		expect(spawn).toHaveBeenCalledWith("ai-telegram-send", ["Worker needs input"], {
			stdio: "ignore",
			detached: true,
			env: expect.objectContaining({
				PI_SESSION_ID: "worker-session",
				PI_PROVIDER: "openai",
				PI_MODEL: "gpt",
				PI_REASONING_LEVEL: "high",
			}),
		});
		expect(child.unref).toHaveBeenCalled();
	});

	it("routes Telegram replies for settled workers to the delegated worker session", async () => {
		dir = mkdtempSync(join(tmpdir(), "acb-tg-"));
		vi.stubEnv("ACB_DELEGATIONS_DIR", dir);
		const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() };
		spawn.mockReset().mockReturnValue(child);
		const events = new Map<string, (...args: unknown[]) => Promise<unknown>>();
		const bus = new EventEmitter();
		const pi = {
			events: {
				emit: (c: string, d: unknown) => bus.emit(c, d),
				on: (c: string, h: (d: unknown) => void) => {
					bus.on(c, h);
					return () => bus.off(c, h);
				},
			},
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) =>
				events.set(event, handler),
			getThinkingLevel: () => "high",
			getActiveTools: () => ["read"],
			setActiveTools: vi.fn(),
			getSessionName: () => "Fix page",
			setSessionName: vi.fn(),
			appendEntry: vi.fn(),
			sendMessage: vi.fn(),
			sendUserMessage: vi.fn(),
		};
		const acb = { create: vi.fn(), prompt: vi.fn(async () => {}) };
		registerDelegate(pi as never, acb as never);
		writeDelegation({
			id: "worker-1",
			title: "Fix page",
			task: "t",
			cwd: tmpdir(),
			parentSessionId: "parent-1",
			parentModel: { provider: "openai", modelId: "parent-model", thinkingLevel: "high" },
			workerModel: { provider: "anthropic", modelId: "worker-model", thinkingLevel: "low" },
			status: "working",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			reportSeq: 0,
		});
		await events.get("agent_settled")!(
			{},
			{
				sessionManager: {
					getSessionId: () => "worker-1",
					getBranch: () => [
						{
							type: "message",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "Done.\nStatus: done" }],
							},
						},
					],
				},
				ui: { notify: vi.fn(), setStatus: vi.fn() },
			},
		);
		expect(spawn).toHaveBeenCalledWith(
			"ai-telegram-send",
			[expect.stringContaining("✅ Worker done: Fix page")],
			{
				stdio: "ignore",
				detached: true,
				env: expect.objectContaining({
					PI_SESSION_ID: "worker-1",
					PI_PROVIDER: "anthropic",
					PI_MODEL: "worker-model",
					PI_REASONING_LEVEL: "low",
				}),
			},
		);
	});
});
