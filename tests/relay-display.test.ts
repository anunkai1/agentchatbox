import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { projectTranscript } from "../src/client/project.js";
import { relayVoiceDisplay, userMessageDisplay } from "../src/client/relay-display.js";
import type { PersistedMessage } from "../src/client/state.js";

describe("Relay normal-chat display", () => {
	it("joins a recognised input to its authoritative Pi echo once", () => {
		const messages: PersistedMessage[] = [];
		relayVoiceDisplay(messages, { id: "voice-1", user: "Inspect the fixture" }, 10);
		userMessageDisplay(messages, "Inspect the fixture", 3, 20);
		relayVoiceDisplay(messages, { id: "voice-1", user: "Inspect the fixture" }, 10);
		expect(messages).toEqual([
			{
				kind: "user",
				text: "Inspect the fixture",
				via: "Voice",
				relayVoiceId: "voice-1",
				seq: 3,
				ts: 20,
			},
		]);
	});

	it("does not collapse distinct repeated utterances or re-run anything", () => {
		const messages: PersistedMessage[] = [];
		for (let i = 1; i <= 2; i++) {
			relayVoiceDisplay(messages, { id: `voice-${i}`, user: "Yes" });
			userMessageDisplay(messages, "Yes", i, i);
		}
		expect(messages).toHaveLength(2);
		expect(messages.map((m) => "seq" in m && m.seq)).toEqual([1, 2]);
	});

	it("updates playback evidence separately without replacing the full answer", () => {
		const messages: PersistedMessage[] = [
			{ kind: "assistant", text: "**Complete** answer.", thinking: "", seq: 4 },
		];
		relayVoiceDisplay(messages, { id: "reply-1", heard: "Complete" });
		relayVoiceDisplay(messages, { id: "reply-1", heard: "Complete answer — approximate." });
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ text: "**Complete** answer.", seq: 4 });
		expect(messages[1]).toMatchObject({
			kind: "note",
			voicePlayback: true,
			text: "Complete answer — approximate.",
		});
	});

	it("stamps the normal composer's optimistic echo without duplicating it", () => {
		const messages: PersistedMessage[] = [{ kind: "user", text: "Typed request", ts: 1 }];
		userMessageDisplay(messages, "Typed request", 8, 2);
		expect(messages).toEqual([{ kind: "user", text: "Typed request", ts: 2, seq: 8 }]);
	});

	it("does not create an extra normal user bubble for delivered steering", () => {
		const messages: PersistedMessage[] = [
			{ kind: "steer", text: "Use the other file", delivered: true },
		];
		expect(userMessageDisplay(messages, "Use the other file", 9)).toBeNull();
		expect(messages).toHaveLength(1);
	});

	it("replays voice, full model replies and approximate playback with stable fork ordinals", () => {
		const messages = [
			{
				role: "custom",
				customType: "acb-relay",
				details: { kind: "voice_context", id: "v1", user: "Check the fixture" },
				timestamp: 1,
			},
			{ role: "user", content: [{ type: "text", text: "Check the fixture" }], timestamp: 2 },
			{
				role: "assistant",
				content: [{ type: "text", text: "## Full saved answer" }],
				timestamp: 3,
			},
			{
				role: "custom",
				customType: "acb-relay",
				details: {
					kind: "voice_context",
					id: "v1",
					user: "Check the fixture",
					heard: "Full saved — approximate",
				},
				timestamp: 4,
			},
		] as unknown as Message[];
		const projected = projectTranscript(messages);
		expect(projected).toHaveLength(3);
		expect(projected[0]).toMatchObject({ kind: "user", text: "Check the fixture", seq: 1 });
		expect(projected[1]).toMatchObject({ kind: "assistant", text: "## Full saved answer", seq: 2 });
		expect(projected[2]).toMatchObject({ kind: "note", voicePlayback: true });
	});
});
