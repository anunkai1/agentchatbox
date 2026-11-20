import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_COLAB_BIN =
	process.env.COLAB_BIN?.trim() || join(homedir(), ".local", "bin", "colab");
export const DEFAULT_IDLE_MINUTES = 30;
export const MAX_IDLE_MINUTES = 240;
export const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_TASK_TIMEOUT_MS = 60 * 60 * 1000;
export const PROVISION_TIMEOUT_MS = 3 * 60 * 1000;
export const CONTROL_TIMEOUT_MS = 30 * 1000;

export const GPU_TYPES = ["T4", "L4", "G4", "A100", "H100"] as const;
export const TPU_TYPES = ["v5e1", "v6e1"] as const;
export type GpuType = (typeof GPU_TYPES)[number];
export type TpuType = (typeof TPU_TYPES)[number];

const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UPLOAD_PATH_RE = /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/;
const VIDEO_EXT_RE = /\.(?:mp4|webm|mov)$/i;

export interface CommandOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface RunCommandOptions {
	stdin?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type ExecColabFn = (args: string[], options?: RunCommandOptions) => Promise<CommandOutput>;

export interface ColabSessionInfo {
	name: string;
	endpoint: string;
	hardware: string;
	shape: string;
	variant: string;
}

export interface ColabUsageInfo {
	balanceUnits: number | null;
	usageRateHourly: number | null;
	activeAssignments: number | null;
	raw: string;
}

export interface ColabStatusSnapshot {
	usage: ColabUsageInfo;
	sessions: ColabSessionInfo[];
	rawSessions: string;
}

export interface UploadedArtifact {
	remotePath: string;
	localPath: string;
	filename: string;
	url: string;
	bytes: number;
	isVideo: boolean;
}

export function resolveUploadsDir(): string {
	return (
		process.env.ACB_UPLOADS_DIR?.trim() ||
		process.env.UPLOADS_DIR?.trim() ||
		resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "uploads")
	);
}

export function validateSessionName(name: string): string {
	const trimmed = name.trim();
	if (!SESSION_NAME_RE.test(trimmed)) {
		throw new Error(
			`Invalid session name "${name}". Use 1-64 alphanumeric characters, dots, dashes, or underscores.`,
		);
	}
	return trimmed;
}

export function makeEphemeralSessionName(): string {
	return `colab-${randomBytes(3).toString("hex")}`;
}

export function buildUniqueUploadName(remotePath: string, now = new Date()): string {
	const rawBase = basename(remotePath.trim() || "output.bin");
	const ext = extname(rawBase)
		.replace(/[^A-Za-z0-9.]/g, "")
		.slice(0, 16);
	const stemRaw = ext ? rawBase.slice(0, rawBase.length - ext.length) : rawBase;
	const stem = stemRaw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "") || "output";
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
		`${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
	const tag = randomBytes(3).toString("hex");
	const maxStemLen = Math.max(8, 180 - stamp.length - tag.length - ext.length - 8);
	return `colab-${stamp}-${tag}-${stem.slice(0, maxStemLen)}${ext}`;
}

export function resolveLocalInputPath(
	localOrUploadUrl: string,
	uploadsDir = resolveUploadsDir(),
): string {
	const trimmed = localOrUploadUrl.trim();
	let resolved: string;
	if (trimmed.startsWith("/uploads/")) {
		const uploadMatch = UPLOAD_PATH_RE.exec(trimmed);
		if (!uploadMatch) {
			throw new Error(`Invalid /uploads/ path: ${localOrUploadUrl}`);
		}
		resolved = join(uploadsDir, uploadMatch[1]);
	} else {
		resolved = resolve(trimmed);
	}
	if (!existsSync(resolved)) {
		throw new Error(`Input file not found: ${localOrUploadUrl}`);
	}
	const st = statSync(resolved);
	if (!st.isFile()) {
		throw new Error(`Input path is not a regular file: ${localOrUploadUrl}`);
	}
	return resolved;
}

export function isVideoFilename(name: string): boolean {
	return VIDEO_EXT_RE.test(name.trim());
}

export function parseColabUsage(text: string): ColabUsageInfo {
	const balanceMatch = /Current balance:\s*([0-9]+(?:\.[0-9]+)?)\s+compute units/i.exec(text);
	const rateMatch = /Usage rate:\s*([0-9]+(?:\.[0-9]+)?)\s*\/hr/i.exec(text);
	const countMatch = /Active assignments:\s*([0-9]+)/i.exec(text);
	return {
		balanceUnits: balanceMatch ? Number(balanceMatch[1]) : null,
		usageRateHourly: rateMatch ? Number(rateMatch[1]) : null,
		activeAssignments: countMatch ? Number(countMatch[1]) : null,
		raw: text.trim(),
	};
}

export function parseColabSessions(text: string): ColabSessionInfo[] {
	const sessions: ColabSessionInfo[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("[colab] No active sessions")) continue;
		const match =
			/^\[([^\]]+)\]\s+(\S+)\s+\|\s+Hardware:\s+([^|]+?)\s+\|\s+Shape:\s+([^|]+?)\s+\|\s+Variant:\s+(.+?)(?:\s+\|\s+Status:\s+.+)?$/.exec(
				line,
			);
		if (!match) continue;
		sessions.push({
			name: match[1].trim(),
			endpoint: match[2].trim(),
			hardware: match[3].trim(),
			shape: match[4].trim(),
			variant: match[5].trim(),
		});
	}
	return sessions;
}

export function formatStatusSnapshot(snap: ColabStatusSnapshot): string {
	const lines: string[] = [];
	if (snap.usage.balanceUnits !== null) {
		const rate =
			snap.usage.usageRateHourly !== null ? `${snap.usage.usageRateHourly.toFixed(2)}/hr` : "?";
		lines.push(
			`Balance: **${snap.usage.balanceUnits.toFixed(2)}** compute units · Usage rate: **${rate}** · Active: **${snap.sessions.length}**`,
		);
	} else if (snap.usage.raw) {
		lines.push(snap.usage.raw);
	}

	if (snap.sessions.length === 0) {
		lines.push("No active Colab runtimes.");
	} else {
		lines.push("");
		for (const s of snap.sessions) {
			lines.push(`- \`${s.name}\` — ${s.hardware} (${s.shape}, ${s.variant}) · \`${s.endpoint}\``);
		}
	}
	return lines.join("\n");
}

export function runColabCli(
	args: string[],
	options: RunCommandOptions = {},
	bin = DEFAULT_COLAB_BIN,
): Promise<CommandOutput> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = execFile(
			bin,
			args,
			{
				timeout: options.timeoutMs ?? CONTROL_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				signal: options.signal,
				env: process.env,
			},
			(error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
					rejectPromise(new Error(`colab CLI not found at ${bin}`));
					return;
				}
				if (error && (error as { name?: string }).name === "AbortError") {
					rejectPromise(new Error("Colab command aborted"));
					return;
				}
				const exitCode =
					error && typeof (error as { code?: unknown }).code === "number"
						? ((error as { code: number }).code ?? 1)
						: error
							? 1
							: 0;
				resolvePromise({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					exitCode,
				});
			},
		);
		if (options.stdin !== undefined && child.stdin) {
			child.stdin.end(options.stdin);
		}
	});
}

function combinedMessage(out: CommandOutput): string {
	return [out.stdout.trim(), out.stderr.trim()].filter(Boolean).join("\n");
}

export async function getColabStatus(
	exec: ExecColabFn = runColabCli,
	signal?: AbortSignal,
): Promise<ColabStatusSnapshot> {
	const [usageRes, sessionsRes] = await Promise.all([
		exec(["usage"], { timeoutMs: CONTROL_TIMEOUT_MS, signal }),
		exec(["sessions"], { timeoutMs: CONTROL_TIMEOUT_MS, signal }),
	]);
	if (usageRes.exitCode !== 0) {
		throw new Error(combinedMessage(usageRes) || `colab usage failed (exit ${usageRes.exitCode})`);
	}
	if (sessionsRes.exitCode !== 0) {
		throw new Error(
			combinedMessage(sessionsRes) || `colab sessions failed (exit ${sessionsRes.exitCode})`,
		);
	}
	const usage = parseColabUsage(usageRes.stdout);
	const sessions = parseColabSessions(sessionsRes.stdout);
	return {
		usage,
		sessions,
		rawSessions: sessionsRes.stdout.trim(),
	};
}

export async function startColabSession(
	opts: {
		session: string;
		gpu?: GpuType;
		tpu?: TpuType;
		highMem?: boolean;
		signal?: AbortSignal;
	},
	exec: ExecColabFn = runColabCli,
): Promise<string> {
	const name = validateSessionName(opts.session);
	const args = ["new", "-s", name];
	if (opts.gpu) args.push("--gpu", opts.gpu);
	if (opts.tpu) args.push("--tpu", opts.tpu);
	if (opts.highMem) args.push("--high-mem");

	const res = await exec(args, { timeoutMs: PROVISION_TIMEOUT_MS, signal: opts.signal });
	const msg = combinedMessage(res);
	if (res.exitCode !== 0) {
		throw new Error(msg || `colab new failed (exit ${res.exitCode})`);
	}
	return msg;
}

export async function stopColabSession(
	session: string,
	exec: ExecColabFn = runColabCli,
): Promise<string> {
	const name = validateSessionName(session);
	const res = await exec(["stop", "-s", name], { timeoutMs: CONTROL_TIMEOUT_MS });
	const msg = combinedMessage(res);
	if (res.exitCode !== 0) {
		throw new Error(msg || `colab stop failed (exit ${res.exitCode})`);
	}
	return msg;
}

export async function stopAllColabSessions(exec: ExecColabFn = runColabCli): Promise<string[]> {
	const snap = await getColabStatus(exec);
	const results: string[] = [];
	for (const s of snap.sessions) {
		if (s.name === "?") {
			results.push(
				`Orphan session ${s.endpoint} (${s.hardware}) has no local name; stop it from Colab web UI or inspect ~/.config/colab-cli/sessions.json.`,
			);
			continue;
		}
		results.push(await stopColabSession(s.name, exec));
	}
	return results;
}

export async function execPythonOnColab(
	opts: { session: string; code: string; timeoutMs?: number; signal?: AbortSignal },
	exec: ExecColabFn = runColabCli,
): Promise<CommandOutput> {
	const name = validateSessionName(opts.session);
	const scriptPath = join(
		tmpdir(),
		`colab-job-${process.pid}-${randomBytes(4).toString("hex")}.py`,
	);
	await writeFile(scriptPath, opts.code, { encoding: "utf8", mode: 0o600 });
	try {
		return await exec(["exec", "-s", name, "-f", scriptPath], {
			timeoutMs: opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
			signal: opts.signal,
		});
	} finally {
		await rm(scriptPath, { force: true }).catch(() => {});
	}
}

export async function execBashOnColab(
	opts: { session: string; command: string; timeoutMs?: number; signal?: AbortSignal },
	exec: ExecColabFn = runColabCli,
): Promise<CommandOutput> {
	const name = validateSessionName(opts.session);
	return exec(["ssh", "-s", name, "--", "bash", "-s"], {
		stdin: `set -e\n${opts.command}\n`,
		timeoutMs: opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
		signal: opts.signal,
	});
}

export async function uploadFileToColab(opts: {
	session: string;
	localPath: string;
	remotePath: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	uploadsDir?: string;
	bin?: string;
}): Promise<{ localPath: string; remotePath: string; bytes: number }> {
	const name = validateSessionName(opts.session);
	const localPath = resolveLocalInputPath(opts.localPath, opts.uploadsDir);
	const bytes = statSync(localPath).size;
	const bin = opts.bin ?? DEFAULT_COLAB_BIN;

	await new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn(
			bin,
			[
				"ssh",
				"-s",
				name,
				"--",
				"sh",
				"-c",
				'mkdir -p "$(dirname "$1")" && exec cat > "$1"',
				"_",
				opts.remotePath,
			],
			{ stdio: ["pipe", "pipe", "pipe"], signal: opts.signal },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			rejectPromise(new Error(`Upload timed out for ${localPath}`));
		}, opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);

		const finish = (err?: Error) => {
			clearTimeout(timer);
			if (err) rejectPromise(err);
			else resolvePromise();
		};

		child.on("error", (err) => finish(err));
		child.on("close", (code) => {
			if (code === 0) finish();
			else finish(new Error(stderr.trim() || `Upload failed with exit code ${code}`));
		});

		const stream = createReadStream(localPath);
		stream.on("error", (err) => {
			child.kill("SIGTERM");
			finish(err);
		});
		stream.pipe(child.stdin);
	});

	return { localPath, remotePath: opts.remotePath, bytes };
}

export async function downloadFileFromColab(opts: {
	session: string;
	remotePath: string;
	uploadsDir?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	bin?: string;
}): Promise<UploadedArtifact> {
	const name = validateSessionName(opts.session);
	const uploadsDir = opts.uploadsDir ?? resolveUploadsDir();
	await mkdir(uploadsDir, { recursive: true, mode: 0o700 });
	const filename = buildUniqueUploadName(opts.remotePath);
	const localPath = join(uploadsDir, filename);
	const tempPath = join(
		uploadsDir,
		`.tmp-${process.pid}-${randomBytes(4).toString("hex")}-${filename}`,
	);
	const bin = opts.bin ?? DEFAULT_COLAB_BIN;

	try {
		await new Promise<void>((resolvePromise, rejectPromise) => {
			const child = spawn(
				bin,
				[
					"ssh",
					"-s",
					name,
					"--",
					"sh",
					"-c",
					'test -f "$1" && exec cat "$1"',
					"_",
					opts.remotePath,
				],
				{ stdio: ["ignore", "pipe", "pipe"], signal: opts.signal },
			);
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				rejectPromise(new Error(`Download timed out for ${opts.remotePath}`));
			}, opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);

			const out = createWriteStream(tempPath, { mode: 0o600 });
			let settled = false;
			const finish = (err?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (err) {
					out.destroy();
					rejectPromise(err);
				} else {
					resolvePromise();
				}
			};

			let exitCode: number | null = null;
			let streamClosed = false;
			const maybeDone = () => {
				if (exitCode === null || !streamClosed) return;
				if (exitCode === 0) finish();
				else
					finish(
						new Error(stderr.trim() || `Download failed for ${opts.remotePath} (exit ${exitCode})`),
					);
			};

			child.on("error", (err) => finish(err));
			child.on("close", (code) => {
				exitCode = code ?? 1;
				maybeDone();
			});
			out.on("error", (err) => {
				child.kill("SIGTERM");
				finish(err);
			});
			out.on("finish", () => {
				streamClosed = true;
				maybeDone();
			});

			child.stdout.pipe(out);
		});

		await rename(tempPath, localPath);
		const st = await stat(localPath);
		return {
			remotePath: opts.remotePath,
			localPath,
			filename,
			url: `/uploads/${filename}`,
			bytes: st.size,
			isVideo: isVideoFilename(filename),
		};
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw err;
	}
}

export class IdleStopManager {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	schedule(
		session: string,
		minutes: number,
		onExpire: (session: string) => Promise<void> | void,
	): void {
		this.clear(session);
		if (!Number.isFinite(minutes) || minutes <= 0) return;
		const clamped = Math.min(minutes, MAX_IDLE_MINUTES);
		const timer = setTimeout(
			() => {
				this.timers.delete(session);
				void Promise.resolve(onExpire(session)).catch(() => {});
			},
			clamped * 60 * 1000,
		);
		timer.unref();
		this.timers.set(session, timer);
	}

	clear(session: string): void {
		const timer = this.timers.get(session);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(session);
		}
	}

	clearAll(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	has(session: string): boolean {
		return this.timers.has(session);
	}
}
