import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVoiceStatus, showToast, showVoiceStatus } from "../src/client/render.js";

vi.mock("../src/client/linkify.js", () => ({ setRichText: vi.fn(), setUserRichText: vi.fn() }));

function entry() {
	return { textContent: "", title: "", hidden: true };
}

let notice: ReturnType<typeof entry>;
let voice: ReturnType<typeof entry>;
let activity: { hidden: boolean; children: ReturnType<typeof entry>[] };

beforeEach(() => {
	vi.useFakeTimers();
	notice = entry();
	voice = entry();
	activity = { hidden: true, children: [voice, notice] };
	const elements = {
		"status-notice": notice,
		"status-voice-detail": voice,
		"status-activity": activity,
	};
	vi.stubGlobal("document", {
		getElementById: (id: keyof typeof elements) => elements[id] ?? null,
	});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("bottom status notices", () => {
	it("updates routine info in place and expires from the latest update", () => {
		showToast("imggen: generation started…");
		expect(notice.textContent).toBe("imggen: generation started…");
		expect(activity.hidden).toBe(false);
		vi.advanceTimersByTime(7000);
		showToast("imggen: still working (20s elapsed)…");
		vi.advanceTimersByTime(7000);
		expect(notice.textContent).toBe("imggen: still working (20s elapsed)…");
		vi.advanceTimersByTime(1000);
		expect(notice.hidden).toBe(true);
		expect(activity.hidden).toBe(true);
	});

	it("keeps voice preparation and its full preview independent of transient info", () => {
		showVoiceStatus("Long TTS · synthesizing…", "Text with <b>literal markup</b>");
		showToast("Image model changed.");
		vi.advanceTimersByTime(8000);
		expect(notice.hidden).toBe(true);
		expect(voice.hidden).toBe(false);
		expect(activity.hidden).toBe(false);
		expect(voice.title).toBe("Long TTS · synthesizing…\n\nText with <b>literal markup</b>");
		clearVoiceStatus();
		expect(activity.hidden).toBe(true);
	});

	it("stopping voice does not dismiss unrelated info", () => {
		showVoiceStatus("Preparing voice…");
		showToast("Message copied.");
		clearVoiceStatus();
		expect(voice.hidden).toBe(true);
		expect(notice.textContent).toBe("Message copied.");
		expect(notice.hidden).toBe(false);
		expect(activity.hidden).toBe(false);
	});

	it("retains multiline text as plain text for the full-details dialog", () => {
		const text = "Available models:\n<b>not HTML</b>\nAnother model";
		showToast(text);
		expect(notice.textContent).toBe(text);
		expect(notice.title).toBe(text);
	});
});
