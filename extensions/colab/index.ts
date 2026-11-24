import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import {
	DEFAULT_IDLE_MINUTES,
	DEFAULT_TASK_TIMEOUT_MS,
	downloadFileFromColab,
	execBashOnColab,
	execPythonOnColab,
	formatStatusSnapshot,
	GPU_TYPES,
	type GpuType,
	getColabStatus,
	IdleStopManager,
	MAX_TASK_TIMEOUT_MS,
	makeEphemeralSessionName,
	resolveLocalInputPath,
	startColabSession,
	stopAllColabSessions,
	stopColabSession,
	TPU_TYPES,
	type TpuType,
	type UploadedArtifact,
	uploadFileToColab,
	validateSessionName,
} from "./lib.js";

const DEFAULT_WARM_SESSION = "colab";

function clampTimeoutMs(timeoutSeconds?: number): number {
	if (!timeoutSeconds || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		return DEFAULT_TASK_TIMEOUT_MS;
	}
	return Math.min(Math.round(timeoutSeconds * 1000), MAX_TASK_TIMEOUT_MS);
}

function truncateOutput(text: string, maxChars = 16_000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]`;
}

function formatArtifactList(artifacts: UploadedArtifact[]): string {
	if (artifacts.length === 0) return "";
	const lines = ["Saved to ACB uploads:"];
	for (const item of artifacts) {
		const sizeKb = (item.bytes / 1024).toFixed(1);
		lines.push(`- ${item.url} (${sizeKb} KiB, from ${item.remotePath})`);
		if (item.isVideo) {
			lines.push(
				`  Inline video tag: <video controls playsinline preload="metadata" src="${item.url}"></video>`,
			);
		}
	}
	return lines.join("\n");
}

async function resolveActiveSessionName(explicit?: string): Promise<string> {
	if (explicit?.trim()) return validateSessionName(explicit);
	const snap = await getColabStatus();
	const named = snap.sessions.filter((s) => s.name !== "?");
	if (named.length === 1) return named[0].name;
	if (named.length === 0) {
		throw new Error("No active Colab session found. Use action='start' or action='run'.");
	}
	throw new Error(
		`Multiple active Colab sessions (${named.map((s) => s.name).join(", ")}); specify 'session'.`,
	);
}

const COLAB_PARAMS = Type.Object({
	action: Type.Union([
		Type.Literal("status"),
		Type.Literal("start"),
		Type.Literal("run"),
		Type.Literal("exec"),
		Type.Literal("upload"),
		Type.Literal("download"),
		Type.Literal("stop"),
	]),
	session: Type.Optional(
		Type.String({ description: "Colab session name (alphanumeric, '.', '-', '_')." }),
	),
	gpu: Type.Optional(
		Type.Union(
			GPU_TYPES.map((g) => Type.Literal(g)),
			{ description: "GPU accelerator for provisioning (T4, L4, G4, A100, H100)." },
		),
	),
	tpu: Type.Optional(
		Type.Union(
			TPU_TYPES.map((t) => Type.Literal(t)),
			{ description: "TPU accelerator for provisioning (v5e1, v6e1)." },
		),
	),
	high_mem: Type.Optional(
		Type.Boolean({ description: "Request a high-RAM machine shape when provisioning." }),
	),
	python: Type.Optional(
		Type.String({ description: "Python script body to run on the Colab kernel." }),
	),
	command: Type.Optional(
		Type.String({ description: "Bash command/script to run on the Colab VM via SSH." }),
	),
	uploads: Type.Optional(
		Type.Array(
			Type.Object({
				local: Type.String({ description: "Local path or /uploads/<file> URL." }),
				remote: Type.String({
					description: "Destination path on Colab (e.g. /content/in.png).",
				}),
			}),
			{ description: "Files to upload to Colab before running." },
		),
	),
	outputs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Remote file paths on Colab to download into ACB /uploads/.",
		}),
	),
	keep_alive: Type.Optional(
		Type.Boolean({
			description:
				"For action='run', keep the session alive after completion instead of auto-stopping.",
		}),
	),
	idle_minutes: Type.Optional(
		Type.Number({
			description: "Idle auto-stop timeout in minutes for warm sessions (default 30, 0 disables).",
		}),
	),
	timeout_seconds: Type.Optional(
		Type.Number({
			description: "Execution/transfer timeout in seconds (default 1200, max 3600).",
		}),
	),
	all: Type.Optional(
		Type.Boolean({ description: "For action='stop', stop all active named sessions." }),
	),
});

export default function registerColab(pi: ExtensionAPI): void {
	const idleStop = new IdleStopManager();

	const note = (content: string) =>
		pi.sendMessage({ customType: "note", content, display: true }, { triggerTurn: false });

	const scheduleIdleWatchdog = (session: string, idleMinutes?: number) => {
		const mins = idleMinutes ?? DEFAULT_IDLE_MINUTES;
		idleStop.schedule(session, mins, async (name) => {
			await stopColabSession(name).catch(() => {});
		});
	};

	pi.registerTool<typeof COLAB_PARAMS, Record<string, unknown>>({
		name: "colab",
		label: "Google Colab GPU",
		exposure: "deferred",
		description:
			"Manage and run tasks on Google Colab GPU/TPU runtimes (account compute-unit balance, " +
			"start/stop sessions, execute Python or bash, transfer files to/from ACB /uploads/). " +
			"Prefer action='run' for one-shot jobs because it auto-stops the VM when finished or aborted. " +
			"Use action='start' (or keep_alive=true) only when keeping a warm VM for back-to-back runs, " +
			"and always stop it with action='stop' when done. Eligible GPUs: T4, L4, G4, A100 (if A100 " +
			"returns 503 capacity busy, retry or fall back to L4/T4). Downloaded files are saved under " +
			"unique names in /uploads/ so browsers never serve stale cached copies.",
		parameters: COLAB_PARAMS,
		async execute(_toolCallId, params, signal) {
			const timeoutMs = clampTimeoutMs(params.timeout_seconds);

			try {
				if (params.action === "status") {
					const snap = await getColabStatus(undefined, signal);
					return {
						content: [{ type: "text", text: formatStatusSnapshot(snap) }],
						details: { ...snap },
					};
				}

				if (params.action === "stop") {
					if (params.all) {
						const messages = await stopAllColabSessions();
						idleStop.clearAll();
						return {
							content: [
								{
									type: "text",
									text:
										messages.length > 0 ? messages.join("\n") : "No active Colab sessions to stop.",
								},
							],
							details: { stopped: messages },
						};
					}
					const target = await resolveActiveSessionName(params.session);
					idleStop.clear(target);
					const msg = await stopColabSession(target);
					return { content: [{ type: "text", text: msg }], details: { session: target } };
				}

				if (params.action === "start") {
					const name = validateSessionName(params.session || DEFAULT_WARM_SESSION);
					const msg = await startColabSession({
						session: name,
						gpu: params.gpu as GpuType | undefined,
						tpu: params.tpu as TpuType | undefined,
						highMem: params.high_mem,
						signal,
					});
					scheduleIdleWatchdog(name, params.idle_minutes);
					return {
						content: [
							{
								type: "text",
								text: `${msg}\nSession '${name}' is ready (idle auto-stop: ${params.idle_minutes ?? DEFAULT_IDLE_MINUTES} min).`,
							},
						],
						details: { session: name, gpu: params.gpu, tpu: params.tpu },
					};
				}

				if (params.action === "upload") {
					const name = await resolveActiveSessionName(params.session);
					const files = params.uploads ?? [];
					if (files.length === 0) throw new Error("action='upload' requires non-empty 'uploads'.");
					const uploaded = [];
					for (const item of files) {
						uploaded.push(
							await uploadFileToColab({
								session: name,
								localPath: item.local,
								remotePath: item.remote,
								timeoutMs,
								signal,
							}),
						);
					}
					scheduleIdleWatchdog(name, params.idle_minutes);
					return {
						content: [
							{
								type: "text",
								text: uploaded
									.map((u) => `Uploaded ${u.localPath} -> ${u.remotePath} (${u.bytes} bytes)`)
									.join("\n"),
							},
						],
						details: { session: name, uploaded },
					};
				}

				if (params.action === "download") {
					const name = await resolveActiveSessionName(params.session);
					const remotePaths = params.outputs ?? [];
					if (remotePaths.length === 0) {
						throw new Error("action='download' requires non-empty 'outputs'.");
					}
					const artifacts: UploadedArtifact[] = [];
					for (const remotePath of remotePaths) {
						artifacts.push(
							await downloadFileFromColab({ session: name, remotePath, timeoutMs, signal }),
						);
					}
					scheduleIdleWatchdog(name, params.idle_minutes);
					return {
						content: [{ type: "text", text: formatArtifactList(artifacts) }],
						details: { session: name, artifacts },
					};
				}

				if (params.action === "exec") {
					if (!params.python && !params.command) {
						throw new Error("action='exec' requires 'python' and/or 'command'.");
					}
					const name = await resolveActiveSessionName(params.session);
					const chunks: string[] = [];
					if (params.command) {
						const res = await execBashOnColab({
							session: name,
							command: params.command,
							timeoutMs,
							signal,
						});
						chunks.push(
							`[bash exit=${res.exitCode}]\n${truncateOutput([res.stdout, res.stderr].filter(Boolean).join("\n"))}`,
						);
						if (res.exitCode !== 0) {
							scheduleIdleWatchdog(name, params.idle_minutes);
							return {
								isError: true,
								content: [{ type: "text", text: chunks.join("\n\n") }],
								details: { session: name, exitCode: res.exitCode },
							};
						}
					}
					if (params.python) {
						const res = await execPythonOnColab({
							session: name,
							code: params.python,
							timeoutMs,
							signal,
						});
						chunks.push(
							`[python exit=${res.exitCode}]\n${truncateOutput([res.stdout, res.stderr].filter(Boolean).join("\n"))}`,
						);
						if (res.exitCode !== 0) {
							scheduleIdleWatchdog(name, params.idle_minutes);
							return {
								isError: true,
								content: [{ type: "text", text: chunks.join("\n\n") }],
								details: { session: name, exitCode: res.exitCode },
							};
						}
					}
					scheduleIdleWatchdog(name, params.idle_minutes);
					return {
						content: [{ type: "text", text: chunks.join("\n\n") || "(no output)" }],
						details: { session: name },
					};
				}

				// action === "run": provision if needed, upload -> exec -> download -> auto-stop
				if (!params.python && !params.command) {
					throw new Error("action='run' requires 'python' and/or 'command'.");
				}
				for (const item of params.uploads ?? []) {
					resolveLocalInputPath(item.local);
				}

				const keepAlive = Boolean(params.keep_alive);
				const name = params.session
					? validateSessionName(params.session)
					: keepAlive
						? DEFAULT_WARM_SESSION
						: makeEphemeralSessionName();

				const existing = await getColabStatus(undefined, signal);
				const alreadyRunning = existing.sessions.some((s) => s.name === name);
				let createdHere = false;
				const shouldAutoStop = !keepAlive;

				const logs: string[] = [];
				const artifacts: UploadedArtifact[] = [];
				let failed = false;

				try {
					if (!alreadyRunning) {
						const startMsg = await startColabSession({
							session: name,
							gpu: params.gpu as GpuType | undefined,
							tpu: params.tpu as TpuType | undefined,
							highMem: params.high_mem,
							signal,
						});
						createdHere = true;
						logs.push(startMsg);
					} else {
						logs.push(`[colab] Reusing existing session '${name}'.`);
					}

					for (const item of params.uploads ?? []) {
						const up = await uploadFileToColab({
							session: name,
							localPath: item.local,
							remotePath: item.remote,
							timeoutMs,
							signal,
						});
						logs.push(`Uploaded ${up.localPath} -> ${up.remotePath} (${up.bytes} bytes)`);
					}

					if (params.command) {
						const res = await execBashOnColab({
							session: name,
							command: params.command,
							timeoutMs,
							signal,
						});
						const body = truncateOutput(
							[res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n"),
						);
						logs.push(`[bash exit=${res.exitCode}]${body ? `\n${body}` : ""}`);
						if (res.exitCode !== 0) failed = true;
					}

					if (!failed && params.python) {
						const res = await execPythonOnColab({
							session: name,
							code: params.python,
							timeoutMs,
							signal,
						});
						const body = truncateOutput(
							[res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n"),
						);
						logs.push(`[python exit=${res.exitCode}]${body ? `\n${body}` : ""}`);
						if (res.exitCode !== 0) failed = true;
					}

					if (!failed) {
						for (const remotePath of params.outputs ?? []) {
							const dl = await downloadFileFromColab({
								session: name,
								remotePath,
								timeoutMs,
								signal,
							});
							artifacts.push(dl);
						}
					}
				} finally {
					if (shouldAutoStop && (createdHere || alreadyRunning)) {
						idleStop.clear(name);
						try {
							const stopMsg = await stopColabSession(name);
							logs.push(stopMsg);
						} catch (stopErr) {
							logs.push(
								`Warning: failed to auto-stop '${name}': ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
							);
						}
					} else if (keepAlive && (createdHere || alreadyRunning)) {
						scheduleIdleWatchdog(name, params.idle_minutes);
						logs.push(
							`Session '${name}' kept warm (idle auto-stop: ${params.idle_minutes ?? DEFAULT_IDLE_MINUTES} min).`,
						);
					}
				}

				const summary = [logs.join("\n\n"), formatArtifactList(artifacts)]
					.filter(Boolean)
					.join("\n\n");
				return {
					isError: failed,
					content: [{ type: "text", text: summary }],
					details: { session: name, autoStopped: shouldAutoStop, artifacts },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: `Colab error: ${msg}` }],
					details: { error: msg },
				};
			}
		},
	});

	pi.registerCommand("colab", {
		description:
			"Check Colab compute-unit balance & active sessions, or stop runtimes (/colab stop [name|--all])",
		handler: async (args) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "status";

			try {
				if (sub === "help") {
					note(
						"**⚡ /colab**\n\n" +
							"- `/colab` or `/colab status` — show compute-unit balance, rate, and active runtimes\n" +
							"- `/colab stop <name>` — stop a specific session\n" +
							"- `/colab stop --all` — stop all active named sessions",
					);
					return;
				}

				if (sub === "stop") {
					const target = parts[1];
					if (!target) {
						note("**⚡ /colab stop** — specify a session name or `--all`");
						return;
					}
					if (target === "--all" || target === "all") {
						const msgs = await stopAllColabSessions();
						idleStop.clearAll();
						note(
							`**⚡ /colab stop --all**\n\n${msgs.length > 0 ? msgs.join("\n") : "No active sessions found."}`,
						);
						return;
					}
					const name = validateSessionName(target);
					idleStop.clear(name);
					const msg = await stopColabSession(name);
					note(`**⚡ /colab stop ${name}**\n\n${msg}`);
					return;
				}

				if (sub === "status") {
					const snap = await getColabStatus();
					note(`**⚡ /colab**\n\n${formatStatusSnapshot(snap)}`);
					return;
				}

				note(`**⚡ /colab** — unknown subcommand \`${parts[0]}\`. Try \`/colab help\`.`);
			} catch (err) {
				note(`**⚡ /colab** — error: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
