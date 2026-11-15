/**
 * Antigravity (Gemini) allowance reporting.
 *
 * The Antigravity ACP agent is Google's consumer Cloud Code client, so its
 * remaining allowance is readable from the private API the agent itself calls:
 * `POST /v1internal:retrieveUserQuotaSummary` returns groups of buckets —
 * five-hour and weekly windows per model group — as a `remainingFraction` plus
 * the reset time.
 *
 * Three backend requirements, all learned from the agent's own source:
 *  - `loadCodeAssist` on `cloudcode-pa.googleapis.com` selects the metered host:
 *    consumer tiers (Free, Google AI Pro/Ultra) route to
 *    `daily-cloudcode-pa.googleapis.com`, while GCP-ToS enterprise tiers use
 *    `cloudcode-pa.googleapis.com`; querying the wrong host returns stale/empty
 *    counters that miss real usage and Argon exhaustion;
 *  - the `User-Agent` must start with `antigravity/`, because the backend
 *    attributes the caller to ClientType_ANTIGRAVITY from that token and answers
 *    403 "no valid license" otherwise;
 *  - the stored credential holds only a refresh token (the agent mints an access
 *    token per run), so one is minted in memory here. Nothing is written back and
 *    no secret is printed or copied into a second store.
 */
import {
	closeSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { remainingFlag, resetAt } from "./format.js";

export const TOKEN_FILE = join(homedir(), ".gemini", "antigravity-acp", "acp_token.json");
export const INSTALL_FILE = join(
	homedir(),
	".local",
	"opt",
	"agy-acp",
	"current",
	"install-integrity.json",
);
export const CLOUDCODE_PROD_BASE = "https://cloudcode-pa.googleapis.com";
export const CLOUDCODE_DAILY_BASE = "https://daily-cloudcode-pa.googleapis.com";

export const ACP_LOG_DIR = "/tmp";
export const ACP_LOG_PATTERN = /^agy_acp_server\.par\..*\.log\.WARNING\./;
export const ACP_LOG = join(ACP_LOG_DIR, "agy_acp_server.par.INFO");
const LOG_TAIL_BYTES = 512 * 1024;
const MAX_LOG_FILES = 50;
const LOG_MAX_AGE_SECONDS = 8 * 86400;

const WINDOW_SECONDS: Record<string, number> = {
	"5h": 5 * 3600,
	weekly: 7 * 86400,
};
const PLACEHOLDER_TOLERANCE_SECONDS = 120;

export interface QuotaBucket {
	bucketId?: string;
	displayName?: string;
	window?: string;
	resetTime?: string;
	remainingFraction?: number;
	remainingAmount?: string | number;
	disabled?: boolean;
}

export interface QuotaGroup {
	displayName?: string;
	buckets?: QuotaBucket[];
}

export interface QuotaSummary {
	groups?: QuotaGroup[];
	tierName?: string;
}

interface LoadCodeAssistResponse {
	cloudaicompanionProject?: string;
	currentTier?: { name?: string };
	paidTier?: { name?: string; usesGcpTos?: boolean };
}

interface TokenFile {
	client_id?: string;
	client_secret?: string;
	refresh_token?: string;
	token_uri?: string;
	project_id?: string;
}

function readTokenFile(file: string): TokenFile {
	return JSON.parse(readFileSync(file, "utf8")) as TokenFile;
}

/** Version of the installed agent, so the UA stays current across its updates. */
function acpVersion(): string {
	try {
		const installed = JSON.parse(readFileSync(INSTALL_FILE, "utf8")) as { version?: string };
		return installed.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** The agent's structured aidev User-Agent, with this client named as the surface. */
function userAgent(): string {
	const arch = process.arch === "x64" ? "x86_64" : process.arch;
	return (
		`antigravity/acp/${acpVersion()} (aidev_client; os_type=${process.platform}; ` +
		`arch=${arch}; host_path=pi/cli; proxy_client=antigravity/sdk)`
	);
}

async function accessToken(file: string): Promise<string> {
	const stored = readTokenFile(file);
	if (!stored.client_id || !stored.client_secret || !stored.refresh_token) {
		throw new Error(
			"Antigravity credential is incomplete — sign in again from an interactive `pi` session.",
		);
	}
	const response = await fetch(stored.token_uri ?? "https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: stored.client_id,
			client_secret: stored.client_secret,
			refresh_token: stored.refresh_token,
		}),
		signal: AbortSignal.timeout(20000),
	});
	if (!response.ok) {
		throw new Error(
			`Antigravity token refresh failed (HTTP ${response.status}) — sign in again from an interactive \`pi\` session.`,
		);
	}
	const body = (await response.json()) as { access_token?: string };
	if (!body.access_token) throw new Error("Antigravity token refresh returned no access token.");
	return body.access_token;
}

async function call<T>(base: string, method: string, token: string, body: unknown): Promise<T> {
	const response = await fetch(`${base.replace(/\/+$/, "")}/v1internal:${method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": userAgent(),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20000),
	});
	if (!response.ok) throw new Error(`${method} failed: HTTP ${response.status}`);
	return (await response.json()) as T;
}

/**
 * Matches ACP's onboarding routing (`onboard.py`): consumer tiers (Free,
 * Google AI Pro/Ultra) are metered on `daily-cloudcode-pa.googleapis.com`,
 * while GCP-ToS enterprise tiers use `cloudcode-pa.googleapis.com`.
 */
export function resolveEndpoint(assist: LoadCodeAssistResponse): string {
	return assist.paidTier?.usesGcpTos ? CLOUDCODE_PROD_BASE : CLOUDCODE_DAILY_BASE;
}

export async function fetchQuota(file = TOKEN_FILE): Promise<QuotaSummary> {
	const token = await accessToken(file);
	const cachedProject = readTokenFile(file).project_id;

	let assist: LoadCodeAssistResponse | undefined;
	try {
		assist = await call<LoadCodeAssistResponse>(CLOUDCODE_PROD_BASE, "loadCodeAssist", token, {
			metadata: { ideType: "ANTIGRAVITY" },
		});
	} catch (error) {
		if (!cachedProject) throw error;
	}

	const endpoint = assist ? resolveEndpoint(assist) : CLOUDCODE_DAILY_BASE;
	const tierName = assist?.paidTier?.name || assist?.currentTier?.name;

	let summary: QuotaSummary | undefined;
	if (cachedProject) {
		try {
			summary = await call<QuotaSummary>(endpoint, "retrieveUserQuotaSummary", token, {
				project: cachedProject,
			});
		} catch {
			// Fall through to the project resolved by loadCodeAssist.
		}
	}
	if (!summary) {
		const resolved = assist?.cloudaicompanionProject;
		if (!resolved) throw new Error("Antigravity reported no Cloud Code project for this account.");
		summary = await call<QuotaSummary>(endpoint, "retrieveUserQuotaSummary", token, {
			project: resolved,
		});
	}
	return tierName ? { ...summary, tierName } : summary;
}

export interface QuotaBlock {
	model: string;
	/** Epoch seconds when the refused model's allowance comes back. */
	resetsAt: number;
}

function readTail(file: string): string {
	let handle: number | undefined;
	try {
		handle = openSync(file, "r");
		const size = fstatSync(handle).size;
		const length = Math.min(size, LOG_TAIL_BYTES);
		if (length === 0) return "";
		const buffer = Buffer.alloc(length);
		readSync(handle, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} catch {
		return "";
	} finally {
		if (handle !== undefined) closeSync(handle);
	}
}

function recentLogFiles(dir: string, now: number): string[] {
	try {
		const cutoffMs = (now - LOG_MAX_AGE_SECONDS) * 1000;
		const entries: { path: string; mtimeMs: number }[] = [];
		for (const name of readdirSync(dir)) {
			if (!ACP_LOG_PATTERN.test(name)) continue;
			const path = join(dir, name);
			try {
				const st = statSync(path);
				if (st.isFile() && st.mtimeMs >= cutoffMs) entries.push({ path, mtimeMs: st.mtimeMs });
			} catch {
				// File vanished between readdir and stat.
			}
		}
		entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return entries.slice(0, MAX_LOG_FILES).map((entry) => entry.path);
	} catch {
		return [];
	}
}

/**
 * Active 429 refusals read across recent ACP logs (not just the current
 * `ACP_LOG` symlink, which rotates on every server restart). Tracks the latest
 * unexpired `quotaResetTimeStamp` per model.
 */
export function activeBlocks(
	now = Date.now() / 1000,
	options?: { dir?: string; files?: string[] },
): QuotaBlock[] {
	const files =
		options?.files ??
		(() => {
			const recent = recentLogFiles(options?.dir ?? ACP_LOG_DIR, now);
			return recent.length > 0 ? recent : [ACP_LOG];
		})();
	const byModel = new Map<string, QuotaBlock>();
	for (const file of files) {
		const log = readTail(file);
		if (!log) continue;
		const matches = [...log.matchAll(/model:([\w.-]+)[^\n]*?quotaResetTimeStamp:([^\s\]]+)/g)];
		for (let i = matches.length - 1; i >= 0; i--) {
			const match = matches[i];
			const model = match[1];
			if (byModel.has(model)) continue;
			const resetsAtMs = Date.parse(match[2]);
			if (Number.isNaN(resetsAtMs)) continue;
			const resetsAt = resetsAtMs / 1000;
			if (resetsAt > now) byModel.set(model, { model, resetsAt });
		}
	}
	return [...byModel.values()];
}

type GroupKind = "gemini" | "third-party" | "argon";

function classifyGroup(group: QuotaGroup): GroupKind | undefined {
	const ids = (group.buckets ?? []).map((b) => b.bucketId ?? "");
	if (ids.some((id) => /argon/i.test(id)) || /argon/i.test(group.displayName ?? "")) {
		return "argon";
	}
	if (ids.some((id) => /^3p-/i.test(id)) || /claude|gpt/i.test(group.displayName ?? "")) {
		return "third-party";
	}
	if (ids.some((id) => /^gemini-/i.test(id)) || /\bgemini\b/i.test(group.displayName ?? "")) {
		return "gemini";
	}
	return undefined;
}

function classifyModel(model: string): GroupKind | undefined {
	if (/argon/i.test(model)) return "argon";
	if (/^(claude|gpt)\b/i.test(model)) return "third-party";
	if (/^gemini\b/i.test(model)) return "gemini";
	return undefined;
}

function parseEpoch(iso: string | undefined): number | undefined {
	if (!iso) return undefined;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? undefined : ms / 1000;
}

function isRollingPlaceholder(
	bucket: QuotaBucket,
	left: number,
	resetSec: number | undefined,
	now: number,
): boolean {
	if (left < 100 || resetSec === undefined || !bucket.window) return false;
	const windowSecs = WINDOW_SECONDS[bucket.window];
	if (!windowSecs) return false;
	return Math.abs(resetSec - now - windowSecs) <= PLACEHOLDER_TOLERANCE_SECONDS;
}

export function formatQuota(
	summary: QuotaSummary,
	now = Date.now() / 1000,
	blocks = activeBlocks(now),
): string[] {
	const header = summary.tierName
		? `**📊 /gemini-usage** — Antigravity (${summary.tierName})`
		: "**📊 /gemini-usage** — Antigravity (Gemini)";
	const lines = [header];
	const active = blocks.filter((b) => b.resetsAt > now);
	const matched = new Set<QuotaBlock>();

	for (const group of summary.groups ?? []) {
		const kind = classifyGroup(group);
		const groupBlocks = kind
			? active.filter((b) => {
					if (classifyModel(b.model) !== kind) return false;
					matched.add(b);
					return true;
				})
			: [];
		const hasExhaustedBucket = (group.buckets ?? []).some(
			(b) => typeof b.remainingFraction === "number" && Math.round(b.remainingFraction * 100) <= 0,
		);
		if (group.displayName) lines.push(`_${group.displayName}_`);

		for (const bucket of group.buckets ?? []) {
			const name = bucket.displayName ?? bucket.window ?? "allowance";
			if (bucket.disabled) {
				lines.push(`${name}: disabled`);
				continue;
			}
			const resetSec = parseEpoch(bucket.resetTime);
			if (typeof bucket.remainingFraction === "number") {
				const left = Math.round(bucket.remainingFraction * 100);
				const placeholder = isRollingPlaceholder(bucket, left, resetSec, now);
				// Suppress a 100% bucket when a live 429 proves this group is blocked.
				if (groupBlocks.length > 0 && left >= 100 && (placeholder || kind === "argon")) {
					continue;
				}
				const resetText = placeholder ? "window starts on use" : `resets ${resetAt(resetSec, now)}`;
				lines.push(`${name}: ${left}% left${remainingFlag(left)} · ${resetText}`);
			} else if (bucket.remainingAmount !== undefined) {
				lines.push(
					`${name}: ${bucket.remainingAmount} remaining · resets ${resetAt(resetSec, now)}`,
				);
			}
		}

		// Only show a separate 429 block line if the group's API bucket didn't already report 0%.
		if (!hasExhaustedBucket) {
			for (const block of groupBlocks) {
				lines.push(`⛔ ${block.model}: refused by Google — resets ${resetAt(block.resetsAt, now)}`);
			}
		}
	}

	for (const block of active) {
		if (matched.has(block)) continue;
		lines.push(`⛔ ${block.model}: refused by Google — resets ${resetAt(block.resetsAt, now)}`);
	}

	if (lines.length === 1) {
		lines.push("No allowance reported for this account.");
	}
	return lines;
}
