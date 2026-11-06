/** Model-free wire types. Relay's policy/state live in the Pi extension. */
export const RELAY_MESSAGE = "acb-relay";
export interface RelayJob {
	id: string;
	title: string;
	status: string;
	updatedAt: string;
	summary?: string;
}
export interface RelayVoiceConfig {
	protocol: 1;
	instructions: string;
	tools: {
		type: "function";
		name: "relay_request";
		description: string;
		parameters: {
			type: "object";
			properties: Record<string, never>;
			required: never[];
			additionalProperties: false;
		};
	}[];
}
export type RelayEvent =
	| {
			kind: "ready";
			model: string;
			workerModel: { provider: string; modelId: string; thinkingLevel: string };
			voice?: RelayVoiceConfig;
	  }
	| { kind: "voice_config"; config: RelayVoiceConfig }
	| { kind: "voice_context"; id: string; user?: string; heard?: string }
	| { kind: "voice_pending"; id: string }
	| { kind: "voice_result"; id: string; text: string; error?: boolean; report?: boolean }
	| { kind: "job"; job: RelayJob | null; uncertain: boolean }
	| { kind: "error"; text: string };
