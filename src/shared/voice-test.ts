/** Extension-authored events carried unchanged over ACB's existing chat socket. */
export const VOICE_TEST_MESSAGE = "acb-voice-test";

export type VoiceTestEvent =
	| { kind: "ready"; model: string }
	| { kind: "user"; turn: string; text: string }
	| { kind: "sentence"; turn: string; text: string; firstTextMs: number }
	| { kind: "done"; turn: string; interrupted: boolean; elapsedMs: number }
	| { kind: "summary"; text: string }
	| { kind: "stopped" }
	| { kind: "error"; text: string };
