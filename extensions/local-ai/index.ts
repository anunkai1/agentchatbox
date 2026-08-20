import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	LOCAL_AI_STATUS_KEY,
	LOCAL_MODEL_ID,
	LOCAL_PROVIDER,
	localAiLabel,
	parseLocalAiState,
	type LocalAiState,
} from "./lib.js";

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
const STATUS_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 150_000;
const STOP_TIMEOUT_MS = 30_000;

interface ExecResult {
	stdout?: string;
	stderr?: string;
	code?: number;
}

function outputOf(result: ExecResult): string {
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

async function ssh(pi: ExtensionAPI, args: string[], timeout: number): Promise<ExecResult> {
	return pi.exec("ssh", [...SSH_OPTIONS, "server4", ...args], { timeout });
}

function publishStatus(ctx: ExtensionContext, state: LocalAiState): void {
	ctx.ui.setStatus(LOCAL_AI_STATUS_KEY, localAiLabel(state));
}

async function readState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<LocalAiState> {
	try {
		const result = await ssh(pi, ["local-ai", "status"], STATUS_TIMEOUT_MS);
		const state = parseLocalAiState(outputOf(result), result.code ?? 1);
		publishStatus(ctx, state);
		return state;
	} catch {
		publishStatus(ctx, "offline");
		return "offline";
	}
}

async function selectQwen(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const model = ctx.modelRegistry.find(LOCAL_PROVIDER, LOCAL_MODEL_ID);
	if (!model) throw new Error(`Model ${LOCAL_PROVIDER}/${LOCAL_MODEL_ID} is not registered`);
	const selected = await pi.setModel(model);
	if (!selected) throw new Error(`Pi could not select ${LOCAL_PROVIDER}/${LOCAL_MODEL_ID}`);
	publishStatus(ctx, "qwen");
	ctx.ui.notify("Qwen local is ready and selected.", "info");
}

async function startQwen(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	publishStatus(ctx, "stopped");
	ctx.ui.setStatus(LOCAL_AI_STATUS_KEY, "Starting Qwen…");
	ctx.ui.notify("Starting Qwen on server4…", "info");

	const result = await ssh(pi, ["local-ai", "text"], START_TIMEOUT_MS);
	if ((result.code ?? 1) !== 0) {
		await readState(pi, ctx);
		throw new Error(outputOf(result).slice(-500) || "server4 did not start Qwen");
	}

	await selectQwen(pi, ctx);
}

async function startVideo(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	publishStatus(ctx, "stopped");
	ctx.ui.setStatus(LOCAL_AI_STATUS_KEY, "Starting LTX video…");
	ctx.ui.notify("Starting LTX-2.5 video on server4…", "info");

	const result = await ssh(pi, ["local-ai", "video"], 180_000);
	if ((result.code ?? 1) !== 0) {
		await readState(pi, ctx);
		throw new Error(outputOf(result).slice(-500) || "server4 did not start LTX video");
	}
	publishStatus(ctx, "video");
	ctx.ui.notify("LTX-2.5 video is ready on :8188.", "info");
}

async function stopLocalAi(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	ctx.ui.setStatus(LOCAL_AI_STATUS_KEY, "Stopping local AI…");
	ctx.ui.notify("Stopping local AI on server4…", "info");
	const result = await ssh(pi, ["local-ai", "stop"], STOP_TIMEOUT_MS);
	if ((result.code ?? 1) !== 0) {
		await readState(pi, ctx);
		throw new Error(outputOf(result).slice(-500) || "server4 did not stop local AI");
	}
	publishStatus(ctx, "stopped");
	ctx.ui.notify("Local AI stopped.", "info");
}

async function openMenu(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const state = await readState(pi, ctx);
	const useQwen = state === "qwen" ? "✓ Qwen active — use locally" : "Use Qwen locally";
	const useVideo = state === "video" ? "✓ LTX video active" : "Use LTX video locally";
	const stop = state === "stopped" ? "✓ Local AI stopped" : "Stop local AI";
	const refresh = "Refresh status";
	const selected = await ctx.ui.select("Server4 local AI", [useQwen, useVideo, stop, refresh]);
	if (!selected) return;

	try {
		if (selected === useQwen) {
			if (state === "qwen") await selectQwen(pi, ctx);
			else await startQwen(pi, ctx);
		} else if (selected === useVideo) {
			if (state !== "video") await startVideo(pi, ctx);
		} else if (selected === stop && state !== "stopped") {
			await stopLocalAi(pi, ctx);
		} else if (selected === refresh) {
			const refreshed = await readState(pi, ctx);
			ctx.ui.notify(`Server4 local AI: ${localAiLabel(refreshed)}.`, "info");
		}
	} catch (error) {
		await readState(pi, ctx);
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Local AI failed: ${message}`, "error");
	}
}

/**
 * Own server4 local-model lifecycle in pi. ACB only exposes the command and
 * relays this extension's UI/status events to the browser.
 */
export default function registerLocalAi(pi: ExtensionAPI): void {
	pi.registerCommand("localai", {
		description: "start, stop, or select the server4 local AI model",
		handler: async (rawArgs, ctx) => {
			const command = rawArgs.trim().toLowerCase();
			if (!command || command === "menu") {
				await openMenu(pi, ctx);
				return;
			}
			if (command === "report" || command === "status") {
				const state = await readState(pi, ctx);
				if (command === "status") ctx.ui.notify(`Server4 local AI: ${localAiLabel(state)}.`, "info");
				return;
			}
			if (command === "text" || command === "qwen") {
				try {
					const state = await readState(pi, ctx);
					if (state === "qwen") await selectQwen(pi, ctx);
					else await startQwen(pi, ctx);
				} catch (error) {
					await readState(pi, ctx);
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Local AI failed: ${message}`, "error");
				}
				return;
			}
			if (command === "video" || command === "ltx") {
				try {
					const state = await readState(pi, ctx);
					if (state !== "video") await startVideo(pi, ctx);
				} catch (error) {
					await readState(pi, ctx);
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Local AI failed: ${message}`, "error");
				}
				return;
			}
			if (command === "stop") {
				try {
					await stopLocalAi(pi, ctx);
				} catch (error) {
					await readState(pi, ctx);
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Local AI failed: ${message}`, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /localai [menu|qwen|video|status|stop]", "warning");
		},
	});
}
