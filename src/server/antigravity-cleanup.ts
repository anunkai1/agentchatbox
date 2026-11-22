/**
 * Periodic cleanup for duplicate Antigravity ACP session state and /tmp logs.
 *
 * Google's `agy_acp_server.par` duplicates session history inside
 * `~/.gemini/antigravity-acp/{brain,conversations}` (where Pi already holds the
 * authoritative transcript in `~/.pi/agent/sessions/`) and creates a fresh set
 * of `/tmp/agy_acp_server.par.*.log.{INFO,WARNING,ERROR}.*` files on every start.
 *
 * Rules:
 *  - Group `brain/<uuid>` and `conversations/<uuid>.*` by UUID, take the newest
 *    mtime across the entire group (including `.db-wal` and nested brain files),
 *    and only remove groups older than `historyMaxAgeMs` (default 14 days).
 *  - Keep `/tmp/agy_acp_server.par.*.log.WARNING.*` for `warnLogMaxAgeMs`
 *    (default 9 days, strictly longer than `plan-usage/gemini.ts`'s 8-day window
 *    for 429 reset timestamps) and remove older `.INFO.` / `.ERROR.` logs after
 *    `otherLogMaxAgeMs` (default 2 days). Never remove active symlink targets.
 */

import {
	existsSync,
	lstatSync,
	readdirSync,
	readlinkSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_ACP_HISTORY_MAX_AGE_MS = 14 * DAY_MS;
export const DEFAULT_ACP_WARN_LOG_MAX_AGE_MS = 9 * DAY_MS;
export const DEFAULT_ACP_OTHER_LOG_MAX_AGE_MS = 2 * DAY_MS;

const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_FILE_RE =
	/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\..+)$/i;
const TMP_LOG_RE = /^agy_acp_server\.par\..*\.log\.(INFO|WARNING|ERROR)\./;
const TMP_ACTIVE_SYMLINKS = [
	"agy_acp_server.par.INFO",
	"agy_acp_server.par.WARNING",
	"agy_acp_server.par.ERROR",
];

export interface AntigravityCleanupOptions {
	acpHomeDir?: string;
	accountsDir?: string;
	tmpDir?: string;
	nowMs?: number;
	historyMaxAgeMs?: number;
	warnLogMaxAgeMs?: number;
	otherLogMaxAgeMs?: number;
}

export interface AntigravityCleanupResult {
	removedSessions: number;
	removedTmpLogs: number;
	freedBytes: number;
}

function measureTree(targetPath: string): { sizeBytes: number; maxMtimeMs: number } {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(targetPath);
	} catch {
		return { sizeBytes: 0, maxMtimeMs: 0 };
	}
	let sizeBytes = st.isFile() ? st.size : 0;
	let maxMtimeMs = st.mtimeMs;
	if (!st.isDirectory()) return { sizeBytes, maxMtimeMs };

	let entries: string[] = [];
	try {
		entries = readdirSync(targetPath);
	} catch {
		return { sizeBytes, maxMtimeMs };
	}
	for (const name of entries) {
		const child = measureTree(join(targetPath, name));
		sizeBytes += child.sizeBytes;
		if (child.maxMtimeMs > maxMtimeMs) maxMtimeMs = child.maxMtimeMs;
	}
	return { sizeBytes, maxMtimeMs };
}

function activeSymlinkTargets(tmpDir: string): Set<string> {
	const protectedPaths = new Set<string>();
	for (const linkName of TMP_ACTIVE_SYMLINKS) {
		const linkPath = join(tmpDir, linkName);
		try {
			const st = lstatSync(linkPath);
			if (!st.isSymbolicLink()) continue;
			const target = readlinkSync(linkPath);
			const resolved = resolve(tmpDir, target);
			protectedPaths.add(resolved);
			protectedPaths.add(join(tmpDir, basename(resolved)));
		} catch {
			/* ignore missing or unreadable symlink */
		}
	}
	return protectedPaths;
}

function cleanAcpHistoryDir(
	acpHomeDir: string,
	nowMs: number,
	historyMaxAgeMs: number,
): { removedSessions: number; freedBytes: number } {
	let removedSessions = 0;
	let freedBytes = 0;
	if (!Number.isFinite(historyMaxAgeMs) || historyMaxAgeMs <= 0) {
		return { removedSessions, freedBytes };
	}
	const brainDir = join(acpHomeDir, "brain");
	const conversationsDir = join(acpHomeDir, "conversations");
	const groups = new Map<string, { paths: string[]; maxMtimeMs: number; totalBytes: number }>();

	const addGroupPath = (uuid: string, targetPath: string) => {
		const key = uuid.toLowerCase();
		const { sizeBytes, maxMtimeMs } = measureTree(targetPath);
		const entry = groups.get(key) ?? { paths: [], maxMtimeMs: 0, totalBytes: 0 };
		entry.paths.push(targetPath);
		entry.totalBytes += sizeBytes;
		if (maxMtimeMs > entry.maxMtimeMs) entry.maxMtimeMs = maxMtimeMs;
		groups.set(key, entry);
	};

	if (existsSync(brainDir)) {
		try {
			for (const name of readdirSync(brainDir)) {
				if (!UUID_DIR_RE.test(name)) continue;
				const full = join(brainDir, name);
				try {
					if (statSync(full).isDirectory()) addGroupPath(name, full);
				} catch {
					/* vanished */
				}
			}
		} catch {
			/* ignore */
		}
	}

	if (existsSync(conversationsDir)) {
		try {
			for (const name of readdirSync(conversationsDir)) {
				const match = CONVERSATION_FILE_RE.exec(name);
				if (!match?.[1]) continue;
				const full = join(conversationsDir, name);
				try {
					if (lstatSync(full).isFile()) addGroupPath(match[1], full);
				} catch {
					/* vanished */
				}
			}
		} catch {
			/* ignore */
		}
	}

	const historyCutoffMs = nowMs - historyMaxAgeMs;
	for (const group of groups.values()) {
		if (group.maxMtimeMs <= 0 || group.maxMtimeMs >= historyCutoffMs) continue;
		let deletedAny = false;
		for (const targetPath of group.paths) {
			try {
				rmSync(targetPath, { recursive: true, force: true });
				deletedAny = true;
			} catch {
				/* keep going on individual file errors */
			}
		}
		if (deletedAny) {
			removedSessions += 1;
			freedBytes += group.totalBytes;
		}
	}

	return { removedSessions, freedBytes };
}

export function cleanAntigravityArtifacts(
	options: AntigravityCleanupOptions = {},
): AntigravityCleanupResult {
	const acpHomeDir = options.acpHomeDir ?? join(homedir(), ".gemini", "antigravity-acp");
	const accountsDir =
		options.accountsDir ??
		(options.acpHomeDir === undefined
			? join(homedir(), ".gemini", "antigravity-accounts")
			: undefined);
	const tmpDir = options.tmpDir ?? "/tmp";
	const nowMs = options.nowMs ?? Date.now();
	const historyMaxAgeMs =
		options.historyMaxAgeMs ??
		Number(process.env.AGENTCHATBOX_ACP_HISTORY_MAX_AGE_MS ?? DEFAULT_ACP_HISTORY_MAX_AGE_MS);
	const warnLogMaxAgeMs = options.warnLogMaxAgeMs ?? DEFAULT_ACP_WARN_LOG_MAX_AGE_MS;
	const otherLogMaxAgeMs = options.otherLogMaxAgeMs ?? DEFAULT_ACP_OTHER_LOG_MAX_AGE_MS;

	let removedSessions = 0;
	let removedTmpLogs = 0;
	let freedBytes = 0;

	const dirsToClean = [acpHomeDir];
	if (accountsDir && existsSync(accountsDir)) {
		try {
			for (const name of readdirSync(accountsDir)) {
				if (name.startsWith(".")) continue;
				const acpSubdir = join(accountsDir, name, "antigravity-acp");
				try {
					if (statSync(acpSubdir).isDirectory()) dirsToClean.push(acpSubdir);
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
	}

	for (const dir of dirsToClean) {
		const cleaned = cleanAcpHistoryDir(dir, nowMs, historyMaxAgeMs);
		removedSessions += cleaned.removedSessions;
		freedBytes += cleaned.freedBytes;
	}

	if (existsSync(tmpDir)) {
		const protectedTargets = activeSymlinkTargets(tmpDir);
		try {
			for (const name of readdirSync(tmpDir)) {
				const match = TMP_LOG_RE.exec(name);
				if (!match?.[1]) continue;
				const full = join(tmpDir, name);
				if (protectedTargets.has(resolve(full)) || protectedTargets.has(full)) continue;
				let st: ReturnType<typeof lstatSync>;
				try {
					st = lstatSync(full);
				} catch {
					continue;
				}
				if (!st.isFile()) continue;
				const maxAge = match[1] === "WARNING" ? warnLogMaxAgeMs : otherLogMaxAgeMs;
				if (st.mtimeMs >= nowMs - maxAge) continue;
				try {
					unlinkSync(full);
					removedTmpLogs += 1;
					freedBytes += st.size;
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
	}

	return { removedSessions, removedTmpLogs, freedBytes };
}
