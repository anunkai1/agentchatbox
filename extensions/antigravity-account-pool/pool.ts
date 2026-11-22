/**
 * Shared Antigravity account pool state and cooldown tracking.
 *
 * State lives in `~/.gemini/antigravity-accounts/state.json` (mode 0600) under
 * a brief lockfile so concurrent Pi processes (ACB chats, delegates, CLI)
 * share the same active preference, custom order, and per-account/per-group
 * quota cooldowns.
 */
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	type AntigravityAccount,
	defaultAccountsDir,
	defaultPrimaryHome,
	defaultStateFile,
	readAntigravityAccounts,
} from "./accounts.js";

export type QuotaGroupKind = "gemini" | "third-party" | "argon";
export type CooldownScope = QuotaGroupKind | "all";
export type FailureKind = "quota" | "rate_limit" | "auth";

export interface AccountCooldown {
	until: string;
	reason: FailureKind;
	model?: string;
	message?: string;
}

export interface AccountPoolState {
	preferred?: string;
	order?: string[];
	cooldowns: Record<string, AccountCooldown>;
	lastSuccess?: { label: string; at: string };
}

export interface AccountPoolOptions {
	primaryHome?: string;
	accountsDir?: string;
	stateFile?: string;
}

const DEFAULT_QUOTA_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_AUTH_COOLDOWN_MS = 60 * 60_000;

export function classifyModelGroup(modelId: string | undefined): QuotaGroupKind {
	if (!modelId) return "gemini";
	if (/argon/i.test(modelId)) return "argon";
	if (/^(claude|gpt)\b/i.test(modelId)) return "third-party";
	return "gemini";
}

export function cooldownKey(label: string, scope: CooldownScope): string {
	return `${label}:${scope}`;
}

export function parseResetFromError(message: string): Date | undefined {
	const match = /Resets at ([^\s]+?)(?:\.(?:\s|$)|$)/i.exec(message);
	if (!match?.[1]) return undefined;
	const ms = Date.parse(match[1]);
	if (Number.isNaN(ms)) return undefined;
	return new Date(ms);
}

export function classifyAntigravityError(
	message: string,
): { kind: FailureKind; resetAt?: Date } | undefined {
	if (!message) return undefined;
	if (
		/Antigravity authentication required|Credentials missing or invalid|token refresh failed|Antigravity OAuth/i.test(
			message,
		)
	) {
		return { kind: "auth" };
	}
	if (
		/Antigravity quota exceeded|Usage Limit Reached|RESOURCE_EXHAUSTED|quota exceeded/i.test(
			message,
		)
	) {
		const resetAt = parseResetFromError(message);
		if (resetAt) return { kind: "quota", resetAt };
		if (/429|RESOURCE_EXHAUSTED|rate limit/i.test(message)) {
			return { kind: "rate_limit" };
		}
		return { kind: "quota" };
	}
	return undefined;
}

export function cooldownUntil(kind: FailureKind, resetAt: Date | undefined, now: Date): Date {
	if (resetAt && resetAt.getTime() > now.getTime()) {
		return resetAt;
	}
	const fallbackMs =
		kind === "auth"
			? DEFAULT_AUTH_COOLDOWN_MS
			: kind === "rate_limit"
				? DEFAULT_RATE_LIMIT_COOLDOWN_MS
				: DEFAULT_QUOTA_COOLDOWN_MS;
	return new Date(now.getTime() + fallbackMs);
}

function activeEntry(
	cooldowns: Record<string, AccountCooldown>,
	key: string,
	now: Date,
): AccountCooldown | undefined {
	const entry = cooldowns[key];
	if (!entry) return undefined;
	const ms = Date.parse(entry.until);
	if (Number.isNaN(ms) || ms <= now.getTime()) return undefined;
	return entry;
}

export function activeAccountCooldown(
	state: AccountPoolState,
	label: string,
	group: QuotaGroupKind = "gemini",
	now: Date = new Date(),
): AccountCooldown | undefined {
	const allBlock = activeEntry(state.cooldowns, cooldownKey(label, "all"), now);
	const groupBlock = activeEntry(state.cooldowns, cooldownKey(label, group), now);
	if (allBlock && groupBlock) {
		return Date.parse(allBlock.until) >= Date.parse(groupBlock.until) ? allBlock : groupBlock;
	}
	return allBlock ?? groupBlock;
}

export function orderPoolAccounts(
	accounts: readonly AntigravityAccount[],
	state: AccountPoolState,
): AntigravityAccount[] {
	const byLabel = new Map(accounts.map((account) => [account.label, account]));
	const ordered: AntigravityAccount[] = [];
	const seen = new Set<string>();

	const push = (label: string | undefined) => {
		if (!label || seen.has(label)) return;
		const account = byLabel.get(label);
		if (!account) return;
		seen.add(label);
		ordered.push(account);
	};

	push(state.preferred);
	for (const label of state.order ?? []) push(label);
	for (const account of accounts) push(account.label);
	return ordered;
}

export class AccountPool {
	private readonly primaryHome: string;
	private readonly accountsDir: string;
	private readonly stateFile: string;

	constructor(options: AccountPoolOptions = {}) {
		this.primaryHome = options.primaryHome ?? defaultPrimaryHome();
		this.accountsDir = options.accountsDir ?? defaultAccountsDir();
		this.stateFile = options.stateFile ?? defaultStateFile(this.accountsDir);
	}

	accounts(): AntigravityAccount[] {
		return readAntigravityAccounts(this.primaryHome, this.accountsDir);
	}

	state(): AccountPoolState {
		try {
			const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<AccountPoolState>;
			return {
				...(typeof parsed.preferred === "string" && parsed.preferred.trim()
					? { preferred: parsed.preferred.trim() }
					: {}),
				...(Array.isArray(parsed.order)
					? {
							order: parsed.order.filter((x): x is string => typeof x === "string" && x.length > 0),
						}
					: {}),
				cooldowns:
					parsed.cooldowns && typeof parsed.cooldowns === "object" ? { ...parsed.cooldowns } : {},
				...(parsed.lastSuccess ? { lastSuccess: parsed.lastSuccess } : {}),
			};
		} catch {
			return { cooldowns: {} };
		}
	}

	orderedAccounts(): AntigravityAccount[] {
		return orderPoolAccounts(this.accounts(), this.state());
	}

	candidates(modelId?: string, now: Date = new Date()): AntigravityAccount[] {
		const ordered = this.orderedAccounts();
		if (ordered.length === 0) return [];
		const state = this.state();
		const group = classifyModelGroup(modelId);
		const usable = ordered.filter((a) => !activeAccountCooldown(state, a.label, group, now));
		if (usable.length > 0) return usable;
		return [...ordered].sort((a, b) => {
			const ca = activeAccountCooldown(state, a.label, group, now);
			const cb = activeAccountCooldown(state, b.label, group, now);
			const ta = ca ? Date.parse(ca.until) : 0;
			const tb = cb ? Date.parse(cb.until) : 0;
			return ta - tb;
		});
	}

	activeAccount(modelId?: string, now: Date = new Date()): AntigravityAccount | undefined {
		return this.candidates(modelId, now)[0];
	}

	activeCooldown(
		label: string,
		group: QuotaGroupKind = "gemini",
		now: Date = new Date(),
	): AccountCooldown | undefined {
		return activeAccountCooldown(this.state(), label, group, now);
	}

	markFailure(
		label: string,
		modelId: string | undefined,
		message: string,
		now: Date = new Date(),
	): AccountCooldown | undefined {
		const classified = classifyAntigravityError(message);
		if (!classified) return undefined;
		const scope: CooldownScope = classified.kind === "auth" ? "all" : classifyModelGroup(modelId);
		const entry: AccountCooldown = {
			until: cooldownUntil(classified.kind, classified.resetAt, now).toISOString(),
			reason: classified.kind,
			...(modelId ? { model: modelId } : {}),
			message: message.slice(0, 240),
		};
		this.update((state) => {
			state.cooldowns[cooldownKey(label, scope)] = entry;
		}, now);
		return entry;
	}

	markBucketExhausted(
		label: string,
		group: QuotaGroupKind,
		resetTimeIso: string | undefined,
		now: Date = new Date(),
	): void {
		const parsed = resetTimeIso ? new Date(resetTimeIso) : undefined;
		const validReset =
			parsed && !Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()
				? parsed
				: undefined;
		this.update((state) => {
			state.cooldowns[cooldownKey(label, group)] = {
				until: cooldownUntil("quota", validReset, now).toISOString(),
				reason: "quota",
				message: "Quota bucket at 0% remaining",
			};
		}, now);
	}

	markSuccess(label: string, modelId?: string): void {
		const group = classifyModelGroup(modelId);
		this.update((state, now) => {
			delete state.cooldowns[cooldownKey(label, "all")];
			delete state.cooldowns[cooldownKey(label, group)];
			state.lastSuccess = { label, at: now.toISOString() };
		});
	}

	clearCooldowns(label?: string): void {
		this.update((state) => {
			if (!label) {
				state.cooldowns = {};
				return;
			}
			const prefix = `${label}:`;
			for (const key of Object.keys(state.cooldowns)) {
				if (key.startsWith(prefix)) delete state.cooldowns[key];
			}
		});
	}

	setPreferred(label: string | undefined): void {
		this.update((state) => {
			if (!label) {
				delete state.preferred;
			} else {
				state.preferred = label;
			}
		});
	}

	setOrder(labels: string[]): void {
		const deduped: string[] = [];
		const seen = new Set<string>();
		for (const label of labels) {
			const trimmed = label.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			deduped.push(trimmed);
		}
		this.update((state) => {
			if (deduped.length === 0) delete state.order;
			else state.order = deduped;
		});
	}

	forgetAccount(label: string): void {
		this.update((state) => {
			if (state.preferred === label) delete state.preferred;
			if (state.order) {
				state.order = state.order.filter((item) => item !== label);
				if (state.order.length === 0) delete state.order;
			}
			if (state.lastSuccess?.label === label) delete state.lastSuccess;
			const prefix = `${label}:`;
			for (const key of Object.keys(state.cooldowns)) {
				if (key.startsWith(prefix)) delete state.cooldowns[key];
			}
		});
	}

	/** Read-modify-write under a lockfile so concurrent Pi processes never drop updates. */
	private update(
		mutate: (state: AccountPoolState, now: Date) => void,
		now: Date = new Date(),
	): void {
		const release = this.lock();
		try {
			const state = this.state();
			for (const [key, entry] of Object.entries(state.cooldowns)) {
				const ms = Date.parse(entry.until);
				if (Number.isNaN(ms) || ms <= now.getTime()) {
					delete state.cooldowns[key];
				}
			}
			mutate(state, now);
			mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
			const temp = `${this.stateFile}.${process.pid}.tmp`;
			writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			renameSync(temp, this.stateFile);
		} finally {
			release();
		}
	}

	private lock(): () => void {
		const path = `${this.stateFile}.lock`;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + 2_000;
		for (;;) {
			try {
				closeSync(openSync(path, "wx", 0o600));
				return () => rmSync(path, { force: true });
			} catch {
				try {
					if (Date.now() - statSync(path).mtimeMs > 2_000) rmSync(path, { force: true });
				} catch {
					// Another writer released it first.
				}
				if (Date.now() > deadline) return () => {};
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
			}
		}
	}
}
