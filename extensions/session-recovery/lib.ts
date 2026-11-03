/** Durable state for an owner request, not a chat-history/task database. */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { durableState, readState } from "../../src/shared/transport-state.js";
import { delegationsDir, type ModelChoice } from "../delegate/lib.js";

export interface SessionRecovery {
	version: 1;
	id: string;
	origin: string;
	cwd: string;
	enabled: boolean;
	status: "idle" | "running" | "stopped" | "needs_input";
	requestId: string | null;
	/** An entry on the active branch proves the request/context was saved. */
	anchorId: string | null;
	bootId: string;
	startedAt: number;
	model: ModelChoice | null;
	claude?: string;
	used: boolean;
	waitingForInput?: boolean;
	notice?: string;
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isDelegatedSession(id: string): boolean {
	if (!ID_RE.test(id)) return true;
	try {
		statSync(join(delegationsDir(), `${id}.json`));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
export function recoveryDir(): string {
	return (
		process.env.ACB_SESSION_RECOVERY_DIR ?? join(homedir(), ".config", "acb", "session-recovery")
	);
}
export function readRecovery(id: string, dir = recoveryDir()): SessionRecovery | null {
	if (!ID_RE.test(id)) return null;
	const record = readState<SessionRecovery>(join(dir, `${id}.json`));
	if (!record) return null;
	if (
		record.version !== 1 ||
		record.id !== id ||
		typeof record.origin !== "string" ||
		typeof record.cwd !== "string" ||
		typeof record.enabled !== "boolean" ||
		typeof record.used !== "boolean" ||
		typeof record.bootId !== "string" ||
		!["idle", "running", "stopped", "needs_input"].includes(record.status) ||
		!Number.isFinite(record.startedAt) ||
		record.startedAt < 0 ||
		(record.requestId !== null &&
			(typeof record.requestId !== "string" || !ID_RE.test(record.requestId))) ||
		(record.anchorId !== null &&
			(typeof record.anchorId !== "string" || !ID_RE.test(record.anchorId))) ||
		(record.waitingForInput !== undefined && typeof record.waitingForInput !== "boolean") ||
		(record.claude !== undefined && !["sonnet", "opus", "haiku"].includes(record.claude)) ||
		(record.notice !== undefined && typeof record.notice !== "string") ||
		(record.model !== null &&
			(!record.model ||
				typeof record.model.provider !== "string" ||
				typeof record.model.modelId !== "string" ||
				typeof record.model.thinkingLevel !== "string"))
	)
		throw new Error("invalid session recovery record");
	return record;
}
export function writeRecovery(record: SessionRecovery, dir = recoveryDir()): void {
	if (!ID_RE.test(record.id)) throw new Error("invalid session id");
	durableState(join(dir, `${record.id}.json`), record);
}
export function listRecovery(dir = recoveryDir()): SessionRecovery[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.flatMap((name) => {
			try {
				const record = readRecovery(name.slice(0, -5), dir);
				return record ? [record] : [];
			} catch {
				// Isolate corrupt records without treating missing state as permission to run.
				console.error("session recovery: unreadable record; manual inspection required");
				return [];
			}
		});
}
export function sessionRecoveryRequestId(record: SessionRecovery, kind = "resume"): string {
	const digest = createHash("sha256").update(`${record.id}\0${record.requestId}`).digest("hex");
	return `session-${kind}-${digest.slice(0, 40)}`;
}
export const RECOVERY_INSTRUCTION = [
	"This execution was interrupted by an ACB service restart. This is the single automatic recovery attempt for the existing owner request, not a new request or permission.",
	"Continue only the latest approved instructions in this session. First inspect the transcript, working tree, running processes and external state to determine what actually happened.",
	"The last command may have completed without its result being saved. Verify commits, pushes, deployments, messages, purchases and other external actions before repeating them; do not blindly replay commands.",
	"Do not bypass an approval or assume an irreversible action failed. If the outcome is uncertain, ask the owner and stop. If the task is already complete, verify and report the result without doing it again.",
].join("\n\n");
