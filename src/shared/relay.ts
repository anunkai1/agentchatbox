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
	| {
			kind: "ready";
			model: string;
			workerModel: { provider: string; modelId: string; thinkingLevel: string };
	  }
	| { kind: "job"; job: RelayJob | null; uncertain: boolean }
	| { kind: "error"; text: string };
