/** Startup recovery policy lives with the Pi delegation workflow, not in ACB. */
import { createHash } from "node:crypto";
import { transportStoppedSince } from "../../src/shared/transport-state.js";
import {
	type Delegation,
	delegationsDir,
	listDelegations,
	readDelegation,
	writeDelegation,
} from "./lib.js";

export interface RecoverySnapshot {
	bootId: string;
	sessions: { sessionId: string }[];
}
export interface RecoverySubmission {
	bootId: string;
	delivery: "submitted" | "uncertain";
}
export interface RecoveryClient {
	snapshot(): Promise<RecoverySnapshot>;
	resume(record: Delegation, requestId: string): Promise<RecoverySubmission>;
	report(record: Delegation): Promise<void>;
}
export function recoveryRequestId(id: string): string {
	return `recovery-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

/** Returns the number waiting on a transient transport/capacity failure. */
export async function recoverWorkers(
	client: RecoveryClient,
	origin: string,
	notify: (record: Delegation) => void,
	{ dir = delegationsDir(), final = false }: { dir?: string; final?: boolean } = {},
): Promise<number> {
	const snapshot = await client.snapshot(); // If unavailable, do not infer that workers are dead.
	let pending = 0;
	for (const record of listDelegations(Infinity, dir)) {
		const recovery = record.recovery;
		if (
			recovery?.version !== 1 ||
			recovery.origin !== origin ||
			!recovery.startedAt ||
			recovery.bootId === snapshot.bootId ||
			record.status !== "working" ||
			snapshot.sessions.some((s) => s.sessionId === record.id)
		)
			continue;

		const finish = async (status: "stopped" | "needs_input", summary: string) => {
			// A human may have reopened or completed it while we waited on transport.
			const state = await client.snapshot();
			const current = readDelegation(record.id, dir);
			if (
				current?.status !== "working" ||
				current.updatedAt !== record.updatedAt ||
				state.sessions.some((s) => s.sessionId === record.id)
			)
				return;
			current.status = status;
			current.summary = summary;
			current.updatedAt = new Date().toISOString();
			if (status !== "stopped") current.reportSeq++;
			writeDelegation(current, dir);
			if (status === "stopped") return;
			notify(current);
			try {
				await client.report(current);
			} catch {
				/* Telegram and the durable record retain the question. */
			}
		};
		try {
			if (transportStoppedSince(origin, record.id, recovery.startedAt)) {
				await finish("stopped", "Explicitly stopped; not resumed after restart.");
				continue;
			}
			if (recovery.waitingForInput) {
				await finish(
					"needs_input",
					"Restart interrupted a pending approval or input dialog. Reopen this worker and decide how to continue; it was not automatically resumed.",
				);
				continue;
			}
			// The stable ID and transport receipt are the claim; no second task
			// ledger or expiring lock can accidentally authorise a duplicate.
			const result = await client.resume(record, recoveryRequestId(record.id));
			const state = await client.snapshot();
			if (result.delivery === "uncertain") {
				await finish(
					"needs_input",
					"Recovery submission has an uncertain outcome. Inspect this worker and continue manually; it was not submitted twice.",
				);
			} else if (
				result.bootId !== state.bootId &&
				!state.sessions.some((s) => s.sessionId === record.id)
			) {
				await finish(
					"needs_input",
					"The worker was interrupted again after its one automatic recovery attempt. Inspect its progress and continue manually.",
				);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (reason.includes("session already live")) continue;
			if (reason.includes("session explicitly stopped")) {
				await finish("stopped", "Explicitly stopped; not resumed after restart.");
			} else if (final || reason.includes("session not found") || reason.includes("uncertain")) {
				await finish(
					"needs_input",
					"Restart recovery could not safely resume this worker. Check its session and continue manually. No further automatic attempt will be made.",
				);
			} else {
				pending++;
			}
		}
	}
	return pending;
}
