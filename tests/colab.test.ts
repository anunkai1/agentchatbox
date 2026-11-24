import { chmodSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerColab from "../extensions/colab/index.js";
import {
	buildUniqueUploadName,
	type CommandOutput,
	downloadFileFromColab,
	execBashOnColab,
	execPythonOnColab,
	formatStatusSnapshot,
	getColabStatus,
	IdleStopManager,
	isVideoFilename,
	parseColabSessions,
	parseColabUsage,
	resolveLocalInputPath,
	startColabSession,
	stopAllColabSessions,
	stopColabSession,
	uploadFileToColab,
	validateSessionName,
} from "../extensions/colab/lib.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("colab parsing and naming helpers", () => {
	it("parses colab usage output", () => {
		const parsed = parseColabUsage(
			"Current balance: 199.45 compute units\nUsage rate: 10.20/hr\nActive assignments: 1\n",
		);
		expect(parsed.balanceUnits).toBe(199.45);
		expect(parsed.usageRateHourly).toBe(10.2);
		expect(parsed.activeAssignments).toBe(1);
	});

	it("parses colab sessions lines and ignores empty notice", () => {
		expect(parseColabSessions("[colab] No active sessions found on server.\n")).toEqual([]);
		const parsed = parseColabSessions(
			"[colab] gpu-t4-s-abc | Hardware: T4 | Shape: Standard | Variant: GPU | Status: IDLE\n" +
				"[?] gpu-a100-s-xyz | Hardware: A100 | Shape: High-RAM | Variant: GPU\n",
		);
		expect(parsed).toEqual([
			{
				name: "colab",
				endpoint: "gpu-t4-s-abc",
				hardware: "T4",
				shape: "Standard",
				variant: "GPU",
			},
			{
				name: "?",
				endpoint: "gpu-a100-s-xyz",
				hardware: "A100",
				shape: "High-RAM",
				variant: "GPU",
			},
		]);
	});

	it("formats status snapshots clearly", () => {
		const text = formatStatusSnapshot({
			usage: {
				balanceUnits: 200,
				usageRateHourly: 0,
				activeAssignments: 1,
				raw: "",
			},
			sessions: [
				{
					name: "h3",
					endpoint: "gpu-l4-1",
					hardware: "L4",
					shape: "Standard",
					variant: "GPU",
				},
			],
			rawSessions: "",
		});
		expect(text).toContain("Balance: **200.00** compute units");
		expect(text).toContain("`h3` — L4 (Standard, GPU)");
	});

	it("validates session names and rejects traversal or spaces", () => {
		expect(validateSessionName("colab-1.test_a")).toBe("colab-1.test_a");
		expect(() => validateSessionName("")).toThrow();
		expect(() => validateSessionName("bad name")).toThrow();
		expect(() => validateSessionName("../escape")).toThrow();
	});

	it("creates unique upload filenames preserving extension and video detection", () => {
		const now = new Date("2026-11-20T12:34:56Z");
		const a = buildUniqueUploadName("/content/out/clip final.mp4", now);
		const b = buildUniqueUploadName("/content/out/clip final.mp4", now);
		expect(a).toMatch(/^colab-20261120-123456-[0-9a-f]{6}-clip_final\.mp4$/);
		expect(b).not.toBe(a);
		expect(isVideoFilename(a)).toBe(true);
		expect(isVideoFilename("result.png")).toBe(false);
	});

	it("resolves /uploads/<name> paths safely inside uploadsDir", () => {
		const dir = mkdtempSync(join(tmpdir(), "colab-uploads-"));
		tempDirs.push(dir);
		const sample = join(dir, "ref.png");
		writeFileSync(sample, "png");
		expect(resolveLocalInputPath("/uploads/ref.png", dir)).toBe(sample);
		expect(() => resolveLocalInputPath("/uploads/missing.png", dir)).toThrow();
		expect(() => resolveLocalInputPath("/uploads/../etc/passwd", dir)).toThrow();
	});
});

describe("colab CLI wrappers", () => {
	it("fetches status, starts with flags, executes python/bash, and stops all named sessions", async () => {
		const calls: Array<{ args: string[]; stdin?: string }> = [];
		const mockExec = async (args: string[], opts?: { stdin?: string }): Promise<CommandOutput> => {
			calls.push({ args, stdin: opts?.stdin });
			if (args[0] === "usage") {
				return {
					stdout:
						"Current balance: 198.50 compute units\nUsage rate: 2.00/hr\nActive assignments: 2\n",
					stderr: "",
					exitCode: 0,
				};
			}
			if (args[0] === "sessions") {
				return {
					stdout:
						"[s1] ep-1 | Hardware: L4 | Shape: Standard | Variant: GPU\n" +
						"[?] ep-2 | Hardware: T4 | Shape: Standard | Variant: GPU\n",
					stderr: "",
					exitCode: 0,
				};
			}
			return { stdout: "[colab] ok", stderr: "", exitCode: 0 };
		};

		const snap = await getColabStatus(mockExec);
		expect(snap.sessions).toHaveLength(2);

		await startColabSession({ session: "s1", gpu: "A100", highMem: true }, mockExec);
		expect(calls.some((c) => c.args.join(" ") === "new -s s1 --gpu A100 --high-mem")).toBe(true);

		const bashRes = await execBashOnColab({ session: "s1", command: "nvidia-smi" }, mockExec);
		expect(bashRes.exitCode).toBe(0);
		expect(calls.at(-1)?.args).toEqual(["ssh", "-s", "s1", "--", "bash", "-s"]);
		expect(calls.at(-1)?.stdin).toContain("set -e\nnvidia-smi");

		const pyRes = await execPythonOnColab({ session: "s1", code: "print(42)" }, mockExec);
		expect(pyRes.exitCode).toBe(0);
		expect(calls.at(-1)?.args.slice(0, 4)).toEqual(["exec", "-s", "s1", "-f"]);

		const stopped = await stopAllColabSessions(mockExec);
		expect(stopped).toHaveLength(2);
		expect(calls.some((c) => c.args.join(" ") === "stop -s s1")).toBe(true);
		expect(stopped[1]).toContain("Orphan session ep-2");

		await stopColabSession("s1", mockExec);
		expect(calls.at(-1)?.args).toEqual(["stop", "-s", "s1"]);
	});

	it("fires idle-stop watchdog after timeout unless cleared", async () => {
		vi.useFakeTimers();
		const manager = new IdleStopManager();
		const expired: string[] = [];

		manager.schedule("warm-1", 10, (name) => {
			expired.push(name);
		});
		expect(manager.has("warm-1")).toBe(true);
		await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
		expect(expired).toEqual([]);

		// Rescheduling resets the countdown
		manager.schedule("warm-1", 10, (name) => {
			expired.push(name);
		});
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(expired).toEqual(["warm-1"]);
		expect(manager.has("warm-1")).toBe(false);

		manager.schedule("warm-2", 5, (name) => {
			expired.push(name);
		});
		manager.clear("warm-2");
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(expired).toEqual(["warm-1"]);
	});
});

describe("colab extension registration", () => {
	it("registers the colab tool and /colab command cleanly", async () => {
		const tools = new Map<
			string,
			{ name: string; exposure?: string; execute: (...args: never[]) => unknown }
		>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const notes: string[] = [];

		registerColab({
			registerTool: (def: {
				name: string;
				exposure?: string;
				execute: (...args: never[]) => unknown;
			}) => {
				tools.set(def.name, def);
			},
			registerCommand: (
				name: string,
				def: { handler: (args: string, ctx: unknown) => Promise<void> },
			) => {
				commands.set(name, def);
			},
			sendMessage: (msg: { content: string }) => {
				notes.push(msg.content);
			},
		} as never);

		expect(tools.has("colab")).toBe(true);
		expect(tools.get("colab")?.exposure).toBe("deferred");
		expect(commands.has("colab")).toBe(true);

		await commands.get("colab")!.handler("help", {});
		expect(notes[0]).toContain("/colab stop --all");
	});
});

function openFdsMatching(substring: string): string[] {
	const matches: string[] = [];
	for (const entry of readdirSync("/proc/self/fd")) {
		try {
			const target = readlinkSync(`/proc/self/fd/${entry}`);
			if (target.includes(substring)) matches.push(target);
		} catch {
			// fd closed while iterating
		}
	}
	return matches;
}

describe("colab file transfer timeout cleanup", () => {
	it("destroys the temp WriteStream and removes the temp file on download timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "colab-dl-timeout-"));
		tempDirs.push(dir);
		const uploadsDir = join(dir, "uploads");
		const fakeBin = join(dir, "fake-colab.sh");
		// Stay alive briefly after SIGTERM so we can verify out.destroy() closed the fd
		// before the child exits.
		writeFileSync(
			fakeBin,
			"#!/bin/sh\ntrap 'sleep 0.35; exit 0' TERM\nprintf partial\nsleep 5\n",
		);
		chmodSync(fakeBin, 0o755);

		await expect(
			downloadFileFromColab({
				session: "s1",
				remotePath: "/content/out.bin",
				uploadsDir,
				timeoutMs: 80,
				bin: fakeBin,
			}),
		).rejects.toThrow("Download timed out for /content/out.bin");

		expect(readdirSync(uploadsDir)).toEqual([]);
		// Allow stream close callback on the next turn, well before the child's 350 ms exit.
		await new Promise((r) => setTimeout(r, 40));
		expect(openFdsMatching(uploadsDir)).toEqual([]);
	});

	it("destroys the ReadStream on upload timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "colab-ul-timeout-"));
		tempDirs.push(dir);
		const localFile = join(dir, "payload.bin");
		// Larger than pipe buffer so ReadStream stays open until destroyed.
		writeFileSync(localFile, Buffer.alloc(512 * 1024, 0x61));
		const fakeBin = join(dir, "fake-colab.sh");
		writeFileSync(
			fakeBin,
			"#!/bin/sh\ntrap 'sleep 0.35; exit 0' TERM\nsleep 5\n",
		);
		chmodSync(fakeBin, 0o755);

		await expect(
			uploadFileToColab({
				session: "s1",
				localPath: localFile,
				remotePath: "/content/payload.bin",
				timeoutMs: 80,
				bin: fakeBin,
			}),
		).rejects.toThrow(`Upload timed out for ${localFile}`);

		// Allow stream close callback on the next turn, well before the child's 350 ms exit.
		await new Promise((r) => setTimeout(r, 40));
		expect(openFdsMatching(localFile)).toEqual([]);
	});
});

