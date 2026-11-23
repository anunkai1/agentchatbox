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

	it("stamps an optimistic image message when Pi echoes upload: and image dimensions", () => {
		const messages: PersistedMessage[] = [
			{
				kind: "user",
				text: "![image: Screenshot.jpg](/uploads/db86c2ea-9e5f-4d21-957a-f1a41338b34d.jpg)\nWhat does this button do?",
				ts: 1,
			},
		];
		const change = userMessageDisplay(
			messages,
			"![image: Screenshot.jpg](upload:db86c2ea-9e5f-4d21-957a-f1a41338b34d.jpg)\nWhat does this button do?\n\n[Image: original 1220x2712, displayed at 900x2000. Multiply coordinates by 1.36 to map to original image.]",
			12,
			2,
		);
		expect(change).toMatchObject({ added: false });
		expect(messages).toEqual([
			{
				kind: "user",
				text: "![image: Screenshot.jpg](/uploads/db86c2ea-9e5f-4d21-957a-f1a41338b34d.jpg)\nWhat does this button do?",
				ts: 2,
				seq: 12,
			},
		]);
	});

	it("stamps an optimistic file attachment when the server rewrites /uploads/ to a disk path", () => {
		const messages: PersistedMessage[] = [
			{ kind: "user", text: "[file: notes.txt](/uploads/abc123.txt)\nCheck this", ts: 1 },
		];
		const change = userMessageDisplay(
			messages,
			"[file: notes.txt](/home/lepton/agentchatbox/uploads/abc123.txt)\nCheck this",
			14,
			3,
		);
		expect(change).toMatchObject({ added: false });
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ seq: 14, ts: 3 });
	});

	it("does not duplicate a steered image attachment into a normal user bubble", () => {
		const messages: PersistedMessage[] = [
			{
				kind: "steer",
				text: "![image: clip.png](/uploads/clip-1.png)\nLook here instead",
				delivered: true,
			},
		];
		expect(
			userMessageDisplay(
				messages,
				"![image: clip.png](upload:clip-1.png)\nLook here instead\n\n[Image: original 800x600, displayed at 800x600.]",
				15,
			),
		).toBeNull();
		expect(messages).toHaveLength(1);
	});

	it("strips Pi's [Image: original ...] metadata when replaying saved user messages", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "![image: Shot.jpg](upload:ea689204-3015-45b6-bc68-ef303bb83c0c.jpg)\nWhat does this button do?\n\n[Image: original 1220x2712, displayed at 900x2000. Multiply coordinates by 1.36 to map to original image.]",
					},
				],
				timestamp: 10,
			},
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "![image: Two.jpg](upload:a.jpg)\n![image: Three.jpg](upload:b.jpg)\n\n[Image: original 800x600, displayed at 800x600.]\n[Image: original 1000x1000, displayed at 1000x1000. Multiply coordinates by 1.00 to map to original image.]",
					},
				],
				timestamp: 11,
			},
		] as unknown as Message[];
		const projected = projectTranscript(messages);
		expect(projected).toEqual([
			{
				kind: "user",
				text: "![image: Shot.jpg](upload:ea689204-3015-45b6-bc68-ef303bb83c0c.jpg)\nWhat does this button do?",
				seq: 1,
				ts: 10,
			},
			{
				kind: "user",
				text: "![image: Two.jpg](upload:a.jpg)\n![image: Three.jpg](upload:b.jpg)",
				seq: 2,
				ts: 11,
			},
		]);
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
