import { describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
const { sendTelegram } = await import("../extensions/delegate/index.js");

describe("delegate notification context", () => {
	it("passes the delegating chat identity and model to the reply-capable helper", () => {
		const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() };
		spawn.mockReturnValue(child);
		sendTelegram("Worker needs input", "parent-session", {
			provider: "openai",
			modelId: "gpt",
			thinkingLevel: "high",
		});
		expect(spawn).toHaveBeenCalledWith("ai-telegram-send", ["Worker needs input"], {
			stdio: "ignore",
			detached: true,
			env: expect.objectContaining({
				PI_SESSION_ID: "parent-session",
				PI_PROVIDER: "openai",
				PI_MODEL: "gpt",
				PI_REASONING_LEVEL: "high",
			}),
		});
		expect(child.unref).toHaveBeenCalled();
	});
});
