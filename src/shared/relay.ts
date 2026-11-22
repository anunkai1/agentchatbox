/** Model-free wire types. Relay's policy/state live in the Pi extension. */
export const RELAY_MESSAGE = "acb-relay";
export interface RelayJob {
	id: string;
	title: string;
	status: string;
	updatedAt: string;
	summary?: string;
}
export type RelayEvent =
	/** The /relay command itself failed before the ready event (busy turn, bad model). */
	| { kind: "voice-failed"; text: string }
	| {
			kind: "ready";
			model: string;
			thinkingLevel?: string;
			workerModel: { provider: string; modelId: string; thinkingLevel: string };
	  }
	| { kind: "voice_context"; id: string; user?: string; heard?: string }
	| { kind: "voice_pending"; id: string }
	| { kind: "voice_result"; id: string; text: string; error?: boolean; report?: boolean }
	| { kind: "job"; job: RelayJob | null; uncertain: boolean }
	| { kind: "error"; text: string };
