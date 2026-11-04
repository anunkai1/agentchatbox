import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import voiceTest from "../extensions/voice-test/index.js";
import {
	MAX_TURNS,
	SpokenSentences,
	VOICE_MODEL,
	VoiceConversation,
	type VoiceGenerate,
	voicePayload,
} from "../extensions/voice-test/lib.js";
import { projectTranscript } from "../src/client/project.js";
import type { VoiceTestEvent } from "../src/shared/voice-test.js";

const generate: VoiceGenerate = async function* () {
	yield "Hello. ";
	yield "How can I help?";
};

describe("voice sentence buffering", () => {
	it("starts on complete sentences without waiting for the final response", () => {
		const splitter = new SpokenSentences();
		expect(splitter.push("Hello")).toEqual([]);
		expect(splitter.push(" there. How ")).toEqual(["Hello there."]);
		expect(splitter.push("are you?", true)).toEqual(["How are you?"]);
	});
	it("does not split decimals or common titles", () => {
		const splitter = new SpokenSentences();
		expect(splitter.push("Dr. Jones quoted $12.50. Okay?", true)).toEqual([
			"Dr. Jones quoted $12.50.",
			"Okay?",
		]);
	});
	it("bounds chunks when the model writes a long unpunctuated reply", () => {
		expect(new SpokenSentences().push("word ".repeat(70)).every((text) => text.length <= 220)).toBe(
			true,
		);
	});
	it("preserves other Venice options while disabling persona and thinking", () => {
		expect(voicePayload({ stream: true, venice_parameters: { a: 1 } })).toEqual({
			stream: true,
			venice_parameters: { a: 1, include_venice_system_prompt: false, disable_thinking: true },
		});
	});
});

describe("isolated voice conversation", () => {
	it("streams and saves only speech text in order", async () => {
		const events: VoiceTestEvent[] = [];
		const conversation = new VoiceConversation(generate, (event) => events.push(event));
		await conversation.say("turn-1", "Hi");
		expect(events.map((event) => event.kind)).toEqual(["user", "sentence", "sentence", "done"]);
		expect(conversation.history).toEqual([
			{ role: "user", text: "Hi" },
			{ role: "assistant", text: "Hello. How can I help?" },
		]);
	});
	it("aborts in-flight generation and never emits stale text", async () => {
		const events: VoiceTestEvent[] = [];
		let begun!: () => void;
		const entered = new Promise<void>((resolve) => {
			begun = resolve;
		});
		const slow: VoiceGenerate = async function* (_prompt, _history, signal) {
			yield "First sentence. ";
			begun();
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
			yield "Must never be emitted.";
		};
		const conversation = new VoiceConversation(slow, (event) => events.push(event));
		const turn = conversation.say("turn-1", "Hi");
		await entered;
		conversation.interrupt();
		await turn;
		expect(events.filter((event) => event.kind === "sentence")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ kind: "done", interrupted: true });
		expect(conversation.history.at(-1)?.text).toContain("interrupted");
	});
	it("enforces bounded turns and input; stop prevents further calls", async () => {
		const conversation = new VoiceConversation(generate, () => {});
		await expect(conversation.say("bad id", "Hi")).rejects.toThrow("ID");
		await expect(conversation.say("one", " ")).rejects.toThrow("1–4000");
		await expect(conversation.say("one", "x".repeat(4001))).rejects.toThrow("1–4000");
		for (let i = 0; i < MAX_TURNS; i++) await conversation.say(`turn-${i}`, "Hi");
		await expect(conversation.say("one-more", "Hi")).rejects.toThrow("40-turn");
		await conversation.stop();
		await expect(conversation.say("after-stop", "Hi")).rejects.toThrow("closed");
	});
	it("reports provider errors rather than fabricating an answer", async () => {
		const events: VoiceTestEvent[] = [];
		const broken: VoiceGenerate = async function* () {
			yield "";
			throw new Error("upstream unavailable");
		};
		await new VoiceConversation(broken, (event) => events.push(event)).say("one", "Hi");
		expect(events).toContainEqual({ kind: "error", text: "upstream unavailable" });
	});
});

function harness() {
	let handler!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const hooks = new Map<string, (...args: unknown[]) => unknown>();
	const messages: Array<{ content: string; details: VoiceTestEvent }> = [];
	const setActiveTools = vi.fn();
	const model = { provider: "venice", id: VOICE_MODEL };
	const streamSimple = vi.fn(() => {
		const stream = (async function* () {
			yield { type: "text_delta", delta: "Hello." };
		})();
		return Object.assign(stream, { result: async () => ({ stopReason: "stop", content: [] }) });
	});
	voiceTest({
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
		on: (name: string, fn: (...args: unknown[]) => unknown) => {
			hooks.set(name, fn);
		},
		sendMessage: (message: (typeof messages)[number]) => {
			messages.push(message);
		},
		setActiveTools,
		setSessionName: vi.fn(),
	} as never);
	const ctx = {
		modelRegistry: { find: vi.fn(() => model), hasConfiguredAuth: () => true, streamSimple },
		sessionManager: { getBranch: () => [] },
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	return { handler, hooks, messages, setActiveTools, streamSimple, ctx };
}

describe("voice-test Pi extension", () => {
	it("uses the exact Venice model without changing the parent model", async () => {
		const h = harness();
		await h.handler("start", h.ctx);
		expect(h.setActiveTools).toHaveBeenCalledWith([]);
		expect(h.messages[0].details).toEqual({ kind: "ready", model: `venice/${VOICE_MODEL}` });
		await h.handler("say turn-1 hello", h.ctx);
		await vi.waitFor(() => expect(h.messages.at(-1)?.details.kind).toBe("done"));
		expect(h.streamSimple.mock.calls[0]?.[0]).toEqual({ provider: "venice", id: VOICE_MODEL });
		await h.handler("stop", h.ctx);
		await vi.waitFor(() => expect(h.messages.at(-1)?.details.kind).toBe("stopped"));
		expect(h.messages.some((message) => message.details.kind === "summary")).toBe(true);
	});
	it("does not convert an existing working chat into a voice session", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch = () => [{ type: "message" }] as never;
		await h.handler("start", h.ctx);
		expect(h.messages[0].details).toMatchObject({
			kind: "error",
			text: expect.stringContaining("empty session"),
		});
		expect(h.setActiveTools).not.toHaveBeenCalled();
	});
	it("fails clearly when the model is absent rather than substituting another", async () => {
		const h = harness();
		h.ctx.modelRegistry.find = () => undefined;
		await h.handler("start", h.ctx);
		expect(h.messages[0].details).toMatchObject({
			kind: "error",
			text: expect.stringContaining("not configured"),
		});
	});
	it("replays persisted user, sentence and summary events without empty status rows", () => {
		const rows = projectTranscript([
			{ role: "custom", customType: "acb-voice-test", content: "" },
			{ role: "custom", customType: "acb-voice-test", content: "You: hello", timestamp: 1 },
			{ role: "custom", customType: "acb-voice-test", content: "Assistant: Hello.", timestamp: 2 },
		] as never);
		expect(rows).toEqual([
			{ kind: "note", text: "You: hello", ts: 1 },
			{ kind: "note", text: "Assistant: Hello.", ts: 2 },
		]);
	});
});
