/**
 * ChatGPT (Codex OAuth) allowance reporting.
 *
 * `GET /backend-api/wham/usage` is the endpoint Codex's own status panel reads:
 * it reports the rolling five-hour window, the weekly window, credit balance and
 * remaining rate-limit reset credits for the signed-in ChatGPT plan. Tokens come
 * from the Codex CLI credential (refreshed by any Codex run) with pi's own
 * OpenAI OAuth copy as a fallback; they are only ever sent as an Authorization
 * header — never printed, never passed as argv.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_AUTH_FILE = join(homedir(), ".secrets", "llm", "codex-auth.json");
export const PI_AUTH_FILE = join(homedir(), ".secrets", "llm", "pi-auth.json");

const USER_AGENT = "codex-cli";

export interface RateLimitWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
}

export interface UsageReport {
	email?: string;
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: RateLimitWindow | null;
		secondary_window?: RateLimitWindow | null;
	} | null;
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		overage_limit_reached?: boolean;
		balance?: string;
	} | null;
	rate_limit_reset_credits?: {
		available_count?: number;
		applicable_available_count?: number;
	} | null;
	spend_control?: { reached?: boolean } | null;
}

interface Credential {
	label: string;
	token: string;
	accountId?: string;
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

/** Account id and expiry live in the access token's claims, not the file. */
function tokenClaims(token: string): {
	exp?: number;
	plan?: string;
	accountId?: string;
} {
	const payload = token.split(".")[1];
	if (!payload) return {};
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
			exp?: number;
			"https://api.openai.com/auth"?: { chatgpt_account_id?: string; chatgpt_plan_type?: string };
		};
		const auth = claims["https://api.openai.com/auth"] ?? {};
		return { exp: claims.exp, plan: auth.chatgpt_plan_type, accountId: auth.chatgpt_account_id };
	} catch {
		return {};
	}
}

/**
 * Every stored ChatGPT credential that has not expired. Codex's copy is tried
 * first: pi only refreshes its own OAuth token when it serves a request, so that
 * copy is usually stale.
 */
export function readCredentials(
	codexFile = CODEX_AUTH_FILE,
	piFile = PI_AUTH_FILE,
	now = Date.now() / 1000,
): Credential[] {
	const credentials: Credential[] = [];
	const codex = readJson<{ tokens?: { access_token?: string; account_id?: string } }>(codexFile);
	const codexToken = codex?.tokens?.access_token;
	if (typeof codexToken === "string" && codexToken.length > 0) {
		const claims = tokenClaims(codexToken);
		if (!claims.exp || claims.exp > now) {
			credentials.push({
				label: "codex",
				token: codexToken,
				accountId: codex?.tokens?.account_id ?? claims.accountId,
			});
		}
	}
	const pi = readJson<{ openai?: { access?: string } }>(piFile)?.openai?.access;
	if (typeof pi === "string" && pi.length > 0) {
		const claims = tokenClaims(pi);
		if (!claims.exp || claims.exp > now) {
			credentials.push({ label: "pi", token: pi, accountId: claims.accountId });
		}
	}
	return credentials;
}

export async function fetchUsage(
	credential: Credential,
	signal: AbortSignal = AbortSignal.timeout(15000),
): Promise<UsageReport> {
	const response = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${credential.token}`,
			"chatgpt-account-id": credential.accountId ?? "",
			"User-Agent": USER_AGENT,
			Accept: "application/json",
		},
		signal,
	});
	if (!response.ok) {
		throw new Error(`${credential.label} credential refused: HTTP ${response.status}`);
	}
	return (await response.json()) as UsageReport;
}

/** First credential that the endpoint accepts. */
export async function fetchFirstUsage(
	credentials: Credential[] = readCredentials(),
): Promise<UsageReport> {
	const errors: string[] = [];
	for (const credential of credentials) {
		try {
			return await fetchUsage(credential);
		} catch (error) {
			errors.push((error as Error).message);
		}
	}
	throw new Error(
		errors.length > 0
			? errors.join("; ")
			: "no ChatGPT credential found — run `codex login`, or send any openai request from pi to refresh its token",
	);
}

function brisbane(epochSeconds: number): string {
	const parts = new Intl.DateTimeFormat("en-AU", {
		timeZone: "Australia/Brisbane",
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(new Date(epochSeconds * 1000));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)?.value ?? "";
	return `${part("day")}/${part("month")} ${part("hour")}:${part("minute")}`;
}

function duration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		return `${days}d ${hours % 24}h`;
	}
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function windowLine(name: string, window: RateLimitWindow, now: number): string {
	const used = Math.round(window.used_percent ?? 0);
	const when = window.reset_at ? brisbane(window.reset_at) : "unknown";
	const wait = window.reset_at ? ` (in ${duration(Math.max(0, window.reset_at - now))})` : "";
	const flag = used >= 95 ? " 🚫" : used >= 80 ? " ⚠️" : "";
	return `${name}: ${used}% used${flag} · resets ${when} AEST${wait}`;
}

export function formatUsage(report: UsageReport, now = Date.now() / 1000): string[] {
	const plan = report.plan_type
		? report.plan_type.replace(/^./, (c) => c.toUpperCase())
		: "unknown plan";
	const lines = [`**📊 /gpt-usage** — ChatGPT ${plan}`];
	const limits = report.rate_limit;
	const primary = limits?.primary_window;
	const secondary = limits?.secondary_window;
	if (primary) lines.push(windowLine("5-hour window", primary, now));
	if (secondary) lines.push(windowLine("Weekly window", secondary, now));
	if (limits?.limit_reached)
		lines.push("**Limit reached** — requests are refused until the window resets.");
	const credits = report.credits;
	if (credits) {
		const balance = credits.unlimited ? "unlimited" : (credits.balance ?? "0");
		const overage = credits.overage_limit_reached ? ", overage limit reached" : "";
		lines.push(`Credits: ${balance}${credits.has_credits ? "" : " (no top-up)"}${overage}`);
	}
	const reset = report.rate_limit_reset_credits;
	if (reset) lines.push(`Reset credits available: ${reset.available_count ?? 0}`);
	return lines;
}
