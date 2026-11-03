/** A bounded startup pass, launched by the host service after ACB starts. No model runs here. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionRecovery } from "../session-recovery/lib.js";
import { recoverSessions, type SessionRecoveryClient } from "../session-recovery/recovery.js";
import { type Delegation, type ModelChoice, telegramText } from "./lib.js";
import {
	type RecoveryClient,
	type RecoverySnapshot,
	type RecoverySubmission,
	recoverWorkers,
} from "./recovery.js";

const port = Number(process.env.PORT ?? process.env.AGENTCHATBOX_PORT ?? 3500);
const origin = `http://127.0.0.1:${port}`;
const endpointFile = join(homedir(), ".config", "acb", "internal", `${port}.json`);

async function request(path: string, body?: unknown): Promise<unknown> {
	// Read the rotating bearer afresh. Never persist it in recovery records or logs.
	const endpoint = JSON.parse(readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	if (endpoint.url !== origin || !endpoint.token) throw new Error("internal endpoint unavailable");
	const response = await fetch(`${origin}/api/internal${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(45_000),
	});
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
	return data;
}

const client: RecoveryClient = {
	snapshot: async () => (await request("/sessions")) as RecoverySnapshot,
	resume: async (record, requestId) =>
		(await request(`/sessions/${encodeURIComponent(record.id)}/prompt`, {
			message: `/delegate recover ${record.id}`,
			...record.workerModel,
			requestId,
			onlyIfNotLive: true,
			notStoppedSince: record.recovery!.startedAt,
		})) as RecoverySubmission,
	report: async (record) => {
		await request(`/sessions/${encodeURIComponent(record.parentSessionId)}/prompt`, {
			message: `/delegate report ${record.id}`,
			...record.parentModel,
		});
	},
};

const sessions: SessionRecoveryClient = {
	snapshot: client.snapshot,
	resume: async (record, requestId) =>
		(await request(`/sessions/${encodeURIComponent(record.id)}/prompt`, {
			message: `/recovery resume ${record.requestId}`,
			...record.model,
			requestId,
			onlyIfIdle: true,
			notStoppedSince: record.startedAt,
		})) as RecoverySubmission,
	notice: async (record, requestId) => {
		await request(`/sessions/${encodeURIComponent(record.id)}/prompt`, {
			message: `/recovery notice ${record.requestId}`,
			...record.model,
			requestId,
			onlyIfIdle: true,
		});
	},
};

function telegram(text: string, sessionId: string, model: ModelChoice): void {
	const child = spawn("ai-telegram-send", [text], {
		stdio: "ignore",
		env: {
			...process.env,
			PI_SESSION_ID: sessionId,
			PI_PROVIDER: model.provider,
			PI_MODEL: model.modelId,
			PI_REASONING_LEVEL: model.thinkingLevel,
		},
	});
	child.on("error", () => console.error("session recovery: owner notification failed"));
}
function notify(record: Delegation): void {
	telegram(
		telegramText(record, process.env.ACB_PUBLIC_URL ?? origin),
		record.parentSessionId,
		record.parentModel,
	);
}
function notifySession(record: SessionRecovery): void {
	if (record.model)
		telegram(
			`Chat needs input after restart\n${record.notice}\n${process.env.ACB_PUBLIC_URL ?? origin}/s/${record.id}`,
			record.id,
			record.model,
		);
}

// A missing endpoint during cold startup isn't evidence of lost work. Retry it.
// Six bounded passes also allow detached idle sessions to free existing capacity.
for (let attempt = 0; attempt < 6; attempt++) {
	try {
		const options = { final: attempt === 5 };
		const workersPending = await recoverWorkers(client, origin, notify, options);
		const sessionsPending = await recoverSessions(sessions, origin, notifySession, options);
		if (workersPending + sessionsPending === 0) break;
	} catch {
		if (attempt === 5) {
			console.error(
				"session recovery: transport unavailable; no sessions were assumed dead or restarted",
			);
			process.exitCode = 1;
		}
	}
	if (attempt < 5) await delay(10_000);
}
