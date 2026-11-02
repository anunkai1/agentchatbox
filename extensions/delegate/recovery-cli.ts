/** A bounded startup pass, launched by the host service after ACB starts. No model runs here. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Delegation, telegramText } from "./lib.js";
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

function notify(record: Delegation): void {
	const child = spawn(
		"ai-telegram-send",
		[telegramText(record, process.env.ACB_PUBLIC_URL ?? origin)],
		{
			stdio: "ignore",
			env: {
				...process.env,
				PI_SESSION_ID: record.parentSessionId,
				PI_PROVIDER: record.parentModel.provider,
				PI_MODEL: record.parentModel.modelId,
				PI_REASONING_LEVEL: record.parentModel.thinkingLevel,
			},
		},
	);
	child.on("error", () => console.error("delegation recovery: owner notification failed"));
}

// A missing endpoint during cold startup isn't evidence of lost work. Retry it.
// Six bounded passes also allow detached idle sessions to free existing capacity.
for (let attempt = 0; attempt < 6; attempt++) {
	try {
		if ((await recoverWorkers(client, origin, notify, { final: attempt === 5 })) === 0) break;
	} catch {
		if (attempt === 5) {
			console.error(
				"delegation recovery: transport unavailable; no workers were assumed dead or restarted",
			);
			process.exitCode = 1;
		}
	}
	if (attempt < 5) await delay(10_000);
}
