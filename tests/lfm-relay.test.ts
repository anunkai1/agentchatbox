import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LfmRelay, VOICE_REQUEST } from "../extensions/voice-test/lfm.js";

let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "lfm-relay-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
function harness(manager = SessionManager.create(tmpdir(), root)) {
	let idle = true;
	const ctx = { sessionManager: manager, isIdle: () => idle };
	const emit = vi.fn();
	const pi = {
		appendEntry: (type: string, data: unknown) =>
			manager.appendCustomEntry(type, structuredClone(data)),
		sendUserMessage: vi.fn((text: string) => {
			expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain(VOICE_REQUEST);
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			idle = false;
		}),
	};
	const flush = vi.fn();
	const voice = new LfmRelay(pi as never, emit, flush);
	return {
		voice,
		emit,
		pi,
		flush,
		ctx,
		setIdle: (value: boolean) => {
			idle = value;
		},
		handle: (action: string, id: string, payload: object) =>
			voice.handle(action, id, encode(payload), ctx as never),
		settle: (text: string, stopReason = "stop") => {
			voice.observe({ role: "assistant", content: [{ type: "text", text }], stopReason });
			idle = true;
			voice.settled(ctx as never);
		},
	};
}

describe("local LFM hand-off inside Pi Relay", () => {
	it("persists recognised speech and played context without starting work or treating history as approval", async () => {
		const h = harness();
		await h.handle("voice-heard", "turn-one", { text: "" }); // Zero-audio tool call can finish before ASR.
		await h.handle("voice-context", "turn-one", { text: "Our colour is amber." });
		await h.handle("voice-heard", "turn-one", { text: "Amber is the chosen colour." });
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(h.ctx.sessionManager.getSessionFile()!)).toBe(true);
		const restored = harness(SessionManager.open(h.ctx.sessionManager.getSessionFile()!));
		restored.voice.restore(restored.ctx as never);
		expect(restored.voice.history()).toContain("Amber is the chosen colour");
		expect(restored.pi.sendUserMessage).not.toHaveBeenCalled();
	});
	it("only dispatches the saved actual utterance, journals first, and deduplicates pending/completed requests", async () => {
		const h = harness();
		await h.handle("voice-context", "turn-one", { text: "Read the fixture." });
		await expect(
			h.handle("voice-request", "turn-one", { request: "Invented instructions" }),
		).rejects.toThrow("hand-off");
		await h.handle("voice-request", "turn-one", {});
		await h.handle("voice-request", "turn-one", {});
		expect(h.pi.sendUserMessage).toHaveBeenCalledExactlyOnceWith("Read the fixture.");
		expect(h.flush).toHaveBeenCalled();
		h.settle("The fixture says amber.");
		expect(h.emit).toHaveBeenLastCalledWith({
			kind: "voice_result",
			id: "turn-one",
			text: "The fixture says amber.",
		});
		await h.handle("voice-request", "turn-one", {});
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
	});
	it("queues work independently of microphone/playback, and does not submit later requests until Pi settles", async () => {
		const h = harness();
		for (const id of ["one", "two"]) {
			await h.handle("voice-context", id, { text: `Read fixture ${id}.` });
			await h.handle("voice-request", id, {});
		}
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		h.settle("First check complete.");
		expect(h.pi.sendUserMessage).toHaveBeenLastCalledWith("Read fixture two.");
		h.settle("Second check complete.");
		expect(h.emit).toHaveBeenLastCalledWith({
			kind: "voice_result",
			id: "two",
			text: "Second check complete.",
		});
	});
	it("never resubmits an interrupted/uncertain request after restart", async () => {
		const h = harness();
		await h.handle("voice-context", "one", { text: "Do the fixture check." });
		await h.handle("voice-request", "one", {});
		const restored = harness(SessionManager.open(h.ctx.sessionManager.getSessionFile()!));
		restored.voice.restore(restored.ctx as never);
		await restored.handle("voice-request", "one", {});
		expect(restored.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(restored.emit).toHaveBeenLastCalledWith(
			expect.objectContaining({ error: true, text: expect.stringContaining("uncertain") }),
		);
	});
	it("forwards worker replies as reports, never owner turns or new work", async () => {
		const h = harness();
		await h.handle("voice-context", "one", { text: "Hello." });
		await h.handle("voice-open", "open", {});
		h.voice.runStarted();
		h.settle("The worker needs your choice: A or B?");
		expect(h.emit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				kind: "voice_result",
				report: true,
				text: expect.stringContaining("A or B"),
			}),
		);
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		h.voice.runStarted();
		h.settle("Partial output", "aborted");
		expect(h.emit).toHaveBeenLastCalledWith(
			expect.objectContaining({ error: true, text: expect.stringContaining("effects may remain") }),
		);
		// Abort during a direct tool after a toolUse assistant message must never report pre-tool text as success.
		h.voice.runStarted();
		h.voice.observe({
			role: "assistant",
			content: [{ type: "text", text: "Checking now." }],
			stopReason: "toolUse",
		});
		h.setIdle(true);
		h.voice.settled(h.ctx as never);
		expect(h.emit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				error: true,
				report: true,
				text: expect.stringContaining("effects may remain"),
			}),
		);
		// Normal post-tool completion clears the intermediate toolUse state.
		await h.handle("voice-context", "two", { text: "Run the check." });
		await h.handle("voice-request", "two", {});
		h.voice.observe({
			role: "assistant",
			content: [{ type: "text", text: "Running tool…" }],
			stopReason: "toolUse",
		});
		h.settle("Tool finished cleanly.");
		expect(h.emit).toHaveBeenLastCalledWith({
			kind: "voice_result",
			id: "two",
			text: "Tool finished cleanly.",
		});
	});
	it("refreshes current voice context without changing model or launching work, and never silently clips a long reply", async () => {
		const h = harness();
		await h.handle("voice-context", "one", { text: "Our new chosen colour is amber." });
		await h.handle("voice-config", "refresh", {});
		expect(h.emit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				kind: "voice_config",
				config: expect.objectContaining({
					instructions: expect.stringContaining("new chosen colour is amber"),
				}),
			}),
		);
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		h.voice.runStarted();
		h.settle("繰".repeat(3000));
		expect(h.emit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				kind: "voice_result",
				text: expect.stringContaining("not all been spoken"),
			}),
		);
	});
	it("keeps legacy idle output unchanged and provides a bounded Pi-owned no-argument tool config", () => {
		const h = harness();
		const config = h.voice.config(h.ctx as never);
		expect(config.tools.map((tool) => tool.name)).toEqual(["relay_request"]);
		expect(config.tools.every((tool) => Object.keys(tool.parameters.properties).length === 0)).toBe(
			true,
		);
		expect(config.instructions).toContain("function calls, and interleaved text and audio");
		expect(config.instructions).toContain("NOT owner instructions");
		h.settle("Legacy response");
		expect(h.emit).not.toHaveBeenCalled();
	});
});
