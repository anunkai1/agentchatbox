import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual auto-read gate without booting main.ts's browser application.
const main = readFileSync("src/client/main.ts", "utf8");
const body = main.match(
	/function autoVoiceReply\(stamp: number \| null\): void \{([\s\S]*?)\n\}/,
)?.[1];
if (!body) throw new Error("autoVoiceReply not found");

function harness() {
	let active = false;
	const state = { voiceMode: "reply", sessionId: "previous-relay", compaction: false };
	const speak = vi.fn();
	const run = new Function(
		"state",
		"isVoiceTestActive",
		"beginPendingVoice",
		"sendPromptHook",
		"document",
		`let sessionSwitch = false; let lastAutoVoicedStamp = null;
		return (stamp) => { ${body} };`,
	)(state, () => active, vi.fn(), speak, { visibilityState: "visible" });
	return {
		run,
		speak,
		setActive: (value: boolean) => {
			active = value;
		},
	};
}

describe("Relay and V+ playback ownership", () => {
	it("suppresses V+ while voice owns playback, preventing double speech", () => {
		const h = harness();
		h.setActive(true);
		h.run(1);
		expect(h.speak).not.toHaveBeenCalled();
	});
	it("restores V+ in the same session after voice ends, without consuming its stamp", () => {
		const h = harness();
		h.setActive(true);
		h.run(1);
		h.setActive(false);
		h.run(1);
		h.run(1);
		expect(h.speak).toHaveBeenCalledExactlyOnceWith("/voice-last long");
	});
	it("does not suppress a reopened historical Relay session", () => {
		const h = harness();
		h.run(2);
		expect(h.speak).toHaveBeenCalledExactlyOnceWith("/voice-last long");
	});
	it("ties playback ownership to ending/disposal, not the persistent display set", () => {
		const voice = readFileSync("src/client/voice-test.ts", "utf8");
		expect(voice).toMatch(/opened = true;\s*voiceActive = true;/);
		expect(voice).toMatch(
			/const end = \(\) => \{\s*if \(ending\) return;\s*ending = true;\s*voiceActive = false;/,
		);
		expect(voice).toMatch(/dismissed = true;\s*opened = false;/);
		expect(body).not.toContain("relaySessions");
		expect(main).toContain("relaySessions.has(state.sessionId)");
	});
});
