import { expect, it, vi } from "vitest";
import { migrateVoicePreference } from "../src/client/relay-voice-engine.js";

const relay = "acb-relay-voice-engine";
const trial = "acb-relay-trial-engine";
const relaySession = "acb-relay-session";
const trialSession = "acb-relay-trial-stream-session";

function preferences(initial: Record<string, string>) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: vi.fn((key: string, value: string) => values.set(key, value)),
	};
}

it.each([
	"kokoro",
	"legacy",
	"server4",
	"lfm-tts",
	"unexpected",
])("migrates saved normal Relay %s to ZONOS without touching trial or session preferences", (saved) => {
	const storage = preferences({
		[relay]: saved,
		[trial]: "kokoro",
		[relaySession]: "relay-id",
		[trialSession]: "trial-id",
	});
	migrateVoicePreference("relay", storage);
	expect(storage.setItem.mock.calls).toEqual([[relay, "zonos3"]]);
	expect(storage.getItem(trial)).toBe("kokoro");
	expect(storage.getItem(relaySession)).toBe("relay-id");
	expect(storage.getItem(trialSession)).toBe("trial-id");
});

it.each([
	"kokoro",
	"legacy",
	"server4",
	"lfm-tts",
	"unexpected",
])("migrates saved Trial A %s to ZONOS without touching Relay or session preferences", (saved) => {
	const storage = preferences({
		[relay]: "kokoro",
		[trial]: saved,
		[relaySession]: "relay-id",
		[trialSession]: "trial-id",
	});
	migrateVoicePreference("trial", storage);
	expect(storage.setItem.mock.calls).toEqual([[trial, "zonos3"]]);
	expect(storage.getItem(relay)).toBe("kokoro");
	expect(storage.getItem(relaySession)).toBe("relay-id");
	expect(storage.getItem(trialSession)).toBe("trial-id");
});

it("does not write an unset or already current preference", () => {
	for (const mode of ["relay", "trial"] as const) {
		const key = mode === "relay" ? relay : trial;
		for (const storage of [preferences({}), preferences({ [key]: "zonos3" })]) {
			migrateVoicePreference(mode, storage);
			expect(storage.setItem).not.toHaveBeenCalled();
		}
	}
});

it("tolerates unavailable storage without throwing", () => {
	const storage = {
		getItem: () => "kokoro",
		setItem: () => {
			throw new Error("Read-only");
		},
	};
	expect(() => migrateVoicePreference("relay", storage)).not.toThrow();
	expect(() => migrateVoicePreference("trial", storage)).not.toThrow();
});
