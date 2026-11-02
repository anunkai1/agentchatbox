/** At-most-once submission to Pi. A reserved receipt after a crash is deliberately ambiguous. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { durableState, readState, transportStateDir } from "../shared/transport-state.js";

export interface PromptReceipt {
	sessionId: string;
	digest: string;
	bootId: string;
	delivery: "uncertain" | "submitted";
}

export class PromptReceipts {
	private readonly pending = new Map<string, Promise<PromptReceipt>>();
	constructor(
		private readonly origin: string,
		private readonly bootId: string,
	) {}

	/** `prepare` may await readiness. `send` must not yield between reservation and submission. */
	async submit(
		id: string,
		sessionId: string,
		message: string,
		prepare: () => Promise<() => void>,
	): Promise<PromptReceipt> {
		const digest = createHash("sha256").update(`${sessionId}\0${message}`).digest("hex");
		const file = join(transportStateDir(this.origin), "requests", `${id}.json`);
		const check = (receipt: PromptReceipt) => {
			if (!receipt.bootId || !["uncertain", "submitted"].includes(receipt.delivery))
				throw new Error("invalid prompt receipt; manual inspection required");
			if (receipt.sessionId !== sessionId || receipt.digest !== digest)
				throw new Error("requestId already used for another message");
			return receipt;
		};
		const active = this.pending.get(id);
		if (active) return active.then(check);
		const saved = readState<PromptReceipt>(file);
		if (saved) return Promise.resolve(check(saved));
		const work = (async () => {
			const send = await prepare();
			const receipt: PromptReceipt = {
				sessionId,
				digest,
				bootId: this.bootId,
				delivery: "uncertain",
			};
			durableState(file, receipt);
			send();
			receipt.delivery = "submitted";
			durableState(file, receipt);
			return receipt;
		})();
		this.pending.set(id, work);
		void work.finally(() => this.pending.delete(id)).catch(() => {});
		return work;
	}
}
