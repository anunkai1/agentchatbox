/**
 * Antigravity (Gemini 4 Argon) allowance reporting.
 *
 * The Antigravity ACP agent is Google's consumer Cloud Code client, so its
 * remaining allowance is readable from the private API the agent itself calls:
 * `POST /v1internal:retrieveUserQuotaSummary` returns one group of buckets — a
 * five-hour and a weekly window for "Claude and GPT models" — as a
 * `remainingFraction` plus the reset time.
 *
 * Two backend requirements, both learned from the agent's own source:
 *  - the `User-Agent` must start with `antigravity/`, because the backend
 *    attributes the caller to ClientType_ANTIGRAVITY from that token and answers
 *    403 "no valid license" otherwise;
 *  - the stored credential holds only a refresh token (the agent mints an access
 *    token per run), so one is minted in memory here. Nothing is written back and
 *    no secret is printed or copied into a second store.
 */
import { readFileSync } from "node:fs";
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
export const CLOUDCODE_BASE = "https://cloudcode-pa.googleapis.com";

export interface QuotaBucket {
	bucketId?: string;
	displayName?: string;
	window?: string;
	resetTime?: string;
	remainingFraction?: number;
}

export interface QuotaGroup {
	displayName?: string;
	buckets?: QuotaBucket[];
}

export interface QuotaSummary {
	groups?: QuotaGroup[];
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

async function call<T>(method: string, token: string, body: unknown): Promise<T> {
	const response = await fetch(`${CLOUDCODE_BASE}/v1internal:${method}`, {
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

export async function fetchQuota(file = TOKEN_FILE): Promise<QuotaSummary> {
	const token = await accessToken(file);
	const project = readTokenFile(file).project_id;
	if (project) {
		try {
			return await call<QuotaSummary>("retrieveUserQuotaSummary", token, { project });
		} catch {
			// Fall through: resolve the project the way the agent does on onboarding.
		}
	}
	const assist = await call<{ cloudaicompanionProject?: string }>("loadCodeAssist", token, {
		metadata: { pluginType: "GEMINI" },
	});
	const resolved = assist.cloudaicompanionProject;
	if (!resolved) throw new Error("Antigravity reported no Cloud Code project for this account.");
	return call<QuotaSummary>("retrieveUserQuotaSummary", token, { project: resolved });
}

export function formatQuota(summary: QuotaSummary, now = Date.now() / 1000): string[] {
	const lines = ["**📊 /argon-usage** — Antigravity (Gemini 4 Argon)"];
	for (const group of summary.groups ?? []) {
		if (group.displayName) lines.push(`_${group.displayName}_`);
		for (const bucket of group.buckets ?? []) {
			const left = Math.round((bucket.remainingFraction ?? 0) * 100);
			const reset = resetAt(
				bucket.resetTime ? Date.parse(bucket.resetTime) / 1000 : undefined,
				now,
			);
			const name = bucket.displayName ?? bucket.window ?? "allowance";
			lines.push(`${name}: ${left}% left${remainingFlag(left)} · resets ${reset}`);
		}
	}
	if (lines.length === 1) lines.push("No allowance reported for this account.");
	return lines;
}
