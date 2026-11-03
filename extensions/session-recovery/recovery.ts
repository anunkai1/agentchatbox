/** Normal-session startup policy; shares the existing worker recovery transport. */
import { transportStoppedSince } from "../../src/shared/transport-state.js";
import type { RecoverySnapshot, RecoverySubmission } from "../delegate/recovery.js";
import {
	isDelegatedSession,
	listRecovery,
	readRecovery,
	recoveryDir,
	type SessionRecovery,
	sessionRecoveryRequestId,
	writeRecovery,
} from "./lib.js";

export interface SessionRecoveryClient {
	snapshot(): Promise<RecoverySnapshot>;
	resume(record: SessionRecovery, requestId: string): Promise<RecoverySubmission>;
	notice(record: SessionRecovery, requestId: string): Promise<void>;
}
function active(snapshot: RecoverySnapshot, id: string): boolean {
	return snapshot.sessions.some(
		(s) => s.sessionId === id && (s.busy || s.streaming || s.claude || Boolean(s.compaction)),
	);
}
export async function recoverSessions(
	client: SessionRecoveryClient,
	origin: string,
	notify: (record: SessionRecovery) => void,
	{ dir = recoveryDir(), final = false }: { dir?: string; final?: boolean } = {},
): Promise<number> {
	if (process.env.ACB_SESSION_RECOVERY === "0") return 0;
	const snapshot = await client.snapshot();
	let pending = 0;
	for (const record of listRecovery(dir)) {
		if (
			!record.enabled ||
			record.status !== "running" ||
			record.origin !== origin ||
			!record.requestId ||
			!record.anchorId ||
			!record.model ||
			record.bootId === snapshot.bootId ||
			isDelegatedSession(record.id) ||
			active(snapshot, record.id)
		)
			continue;
		const finish = async (status: "stopped" | "needs_input", notice: string) => {
			const state = await client.snapshot();
			const current = readRecovery(record.id, dir);
			if (
				!current?.enabled ||
				current.status !== "running" ||
				current.requestId !== record.requestId ||
				current.bootId !== record.bootId ||
				active(state, record.id)
			)
				return;
			current.status = status;
			current.notice = notice;
			writeRecovery(current, dir);
			if (status === "stopped") return;
			notify(current);
			try {
				await client.notice(current, sessionRecoveryRequestId(current, "notice"));
			} catch {
				/* Durable status plus the owner notification retain the decision. */
			}
		};
		try {
			if (transportStoppedSince(origin, record.id, record.startedAt)) {
				await finish("stopped", "Explicitly stopped; this request was not resumed after restart.");
				continue;
			}
			if (record.waitingForInput) {
				await finish(
					"needs_input",
					"Restart interrupted an approval/input wait. Reopen this chat and decide how to continue; no execution was automatically resumed.",
				);
				continue;
			}
			if (record.used) {
				await finish(
					"needs_input",
					"This owner request was interrupted again after its one automatic recovery attempt. Inspect the chat and continue manually.",
				);
				continue;
			}
			const result = await client.resume(record, sessionRecoveryRequestId(record));
			const state = await client.snapshot();
			if (result.delivery === "uncertain") {
				await finish(
					"needs_input",
					"The restart-recovery submission has an uncertain outcome. It was not submitted twice. Inspect the chat and continue manually.",
				);
			} else if (result.bootId !== state.bootId && !active(state, record.id)) {
				await finish(
					"needs_input",
					"This request already had its automatic continuation submitted before another restart. Inspect the chat and continue manually.",
				);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (reason.includes("session already live") || reason.includes("session already active"))
				continue;
			if (reason.includes("session explicitly stopped")) {
				await finish("stopped", "Explicitly stopped; not resumed after restart.");
			} else if (final || reason.includes("session not found") || reason.includes("uncertain")) {
				await finish(
					"needs_input",
					"Restart recovery could not safely resume this request. Inspect the chat and continue manually; no further automatic attempt will be made.",
				);
			} else pending++;
		}
	}
	return pending;
}
