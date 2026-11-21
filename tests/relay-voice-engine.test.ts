import { expect, it, vi } from "vitest";
import {
	migrateRelayVoicePreference,
	readTrialVoicePreference,
} from "../src/client/relay-voice-engine.js";

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
	migrateRelayVoicePreference(storage);
	expect(storage.setItem.mock.calls).toEqual([[relay, "zonos3"]]);
	expect(readTrialVoicePreference(undefined, storage)).toBe("kokoro");
	expect(storage.getItem(relaySession)).toBe("relay-id");
	expect(storage.getItem(trialSession)).toBe("trial-id");
});

it("does not write an unset or already current Relay preference", () => {
	for (const storage of [preferences({}), preferences({ [relay]: "zonos3" })]) {
		migrateRelayVoicePreference(storage);
		expect(storage.setItem).not.toHaveBeenCalled();
	}
});

it("switches or migrates the trial independently of normal Relay", () => {
	const storage = preferences({ [relay]: "kokoro", [trial]: "server4" });
	expect(readTrialVoicePreference(undefined, storage)).toBe("zonos3");
	expect(readTrialVoicePreference("kokoro", storage)).toBe("kokoro");
	expect(readTrialVoicePreference(undefined, storage)).toBe("kokoro");
	expect(storage.setItem.mock.calls).toEqual([
		[trial, "zonos3"],
		[trial, "kokoro"],
	]);
	expect(storage.getItem(relay)).toBe("kokoro");
});

it("tolerates unavailable storage without selecting a different normal engine", () => {
	const storage = {
		getItem: () => "kokoro",
		setItem: () => {
			throw new Error("Read-only");
		},
	};
	expect(() => migrateRelayVoicePreference(storage)).not.toThrow();
	expect(readTrialVoicePreference(undefined, storage)).toBe("kokoro");
});
