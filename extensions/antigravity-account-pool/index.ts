/**
 * antigravity-account-pool — Pi extension
 *
 * Pools multiple Google Antigravity accounts (e.g., multiple discounted AI Pro
 * subscriptions) so you can switch with one command or fail over automatically
 * when an account hits its Hydrogen / Gemini / 3P quota limit.
 *
 * Commands:
 *  - `/gemini-accounts`                Show all accounts, active selection, cooldowns, and live quota
 *  - `/gemini-accounts login [name]`   Sign in a new (or existing) Google account into an isolated slot
 *  - `/gemini-accounts use [name|auto]` Switch active account immediately (or pick via dialog)
 *  - `/gemini-accounts order <names…>` Set failover priority order
 *  - `/gemini-accounts remove <name>`  Remove an extra account slot
 *  - `/gemini-accounts reset`          Clear all local cooldowns
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { remainingFlag, resetAt } from "../plan-usage/format.js";
import { fetchQuota, type QuotaGroup, type QuotaSummary } from "../plan-usage/gemini.js";
import {
	AUTO_LABEL,
	findDuplicateLabel,
	PRIMARY_LABEL,
	prepareAccountDirectory,
	removeAccountSlot,
	suggestNextLabel,
	validateAccountLabel,
} from "./accounts.js";
import {
	AccountPool,
	activeAccountCooldown,
	classifyModelGroup,
	type QuotaGroupKind,
} from "./pool.js";
import {
	ANTIGRAVITY_SHARED_RUNTIME_SYMBOL,
	type AntigravityPoolHookHandle,
	type AntigravitySharedSlot,
	patchAntigravityRuntimeForPool,
} from "./runtime-hook.js";

function groupShortName(group: QuotaGroup): string {
	const ids = (group.buckets ?? []).map((b) => b.bucketId ?? "");
	if (ids.some((id) => /argon/i.test(id)) || /argon/i.test(group.displayName ?? "")) return "Argon";
	if (ids.some((id) => /^3p-/i.test(id)) || /claude|gpt/i.test(group.displayName ?? ""))
		return "3P";
	if (ids.some((id) => /^gemini-/i.test(id)) || /\bgemini\b/i.test(group.displayName ?? "")) {
		return "Gemini";
	}
	return group.displayName ?? "Quota";
}

export function formatSummaryCompact(summary: QuotaSummary, nowSec = Date.now() / 1000): string {
	const parts: string[] = [];
	for (const group of summary.groups ?? []) {
		const label = groupShortName(group);
		const buckets: string[] = [];
		for (const bucket of group.buckets ?? []) {
			if (bucket.disabled) continue;
			if (typeof bucket.remainingFraction !== "number") continue;
			const pct = Math.round(bucket.remainingFraction * 100);
			const win = bucket.window ?? "limit";
			const resetMs = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
			const resetText =
				pct < 100 && !Number.isNaN(resetMs) && resetMs / 1000 > nowSec
					? ` (resets ${resetAt(resetMs / 1000, nowSec)})`
					: "";
			buckets.push(`${win} ${pct}%${remainingFlag(pct)}${resetText}`);
		}
		if (buckets.length > 0) parts.push(`${label}: ${buckets.join(", ")}`);
	}
	const tier = summary.tierName ? `${summary.tierName} · ` : "";
	return `${tier}${parts.join(" · ") || "no quota buckets reported"}`;
}

export function registerAntigravityAccountPool(
	pi: ExtensionAPI,
	pool = new AccountPool(),
): {
	pool: AccountPool;
	ensureHook: () => AntigravityPoolHookHandle | undefined;
} {
	let latestCtx: ExtensionContext | undefined;

	const getSlot = (): AntigravitySharedSlot | undefined =>
		(globalThis as Record<symbol, AntigravitySharedSlot | undefined>)[
			ANTIGRAVITY_SHARED_RUNTIME_SYMBOL
		];

	const syncStatus = (ctx: ExtensionContext | undefined = latestCtx) => {
		if (!ctx?.ui) return;
		const accounts = pool.accounts();
		if (ctx.model?.provider === "antigravity-acp" && accounts.length > 1) {
			const active = pool.activeAccount(ctx.model.id);
			ctx.ui.setStatus("gemini-account", active ? `Gemini: ${active.label}` : undefined);
		} else {
			ctx.ui.setStatus("gemini-account", undefined);
		}
	};

	const ensureHook = (): AntigravityPoolHookHandle | undefined =>
		patchAntigravityRuntimeForPool(getSlot()?.runtime, pool, {
			onFailover: ({ from, to, reason }) => {
				syncStatus();
				try {
					latestCtx?.ui?.notify(
						`Gemini account "${from.label}" hit ${reason} — switched to "${to.label}".`,
						"info",
					);
				} catch {
					// UI context may be absent during headless/shutdown runs.
				}
			},
			onAccountSuccess: () => {
				syncStatus();
			},
		});

	ensureHook();

	const note = (content: string) =>
		pi.sendMessage({ customType: "note", content, display: true }, { triggerTurn: false });

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		ensureHook();
		syncStatus(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		latestCtx = ctx;
		ensureHook();
		syncStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		latestCtx = ctx;
		ensureHook();
		syncStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		latestCtx = undefined;
	});

	const showStatus = async (ctx: ExtensionContext) => {
		const accounts = pool.orderedAccounts();
		if (accounts.length === 0) {
			note(
				"**🔀 /gemini-accounts** — No Antigravity Google accounts found. Run `/gemini-accounts login primary` to sign in.",
			);
			return;
		}
		const state = pool.state();
		const modelId = ctx.model?.provider === "antigravity-acp" ? ctx.model.id : undefined;
		const group: QuotaGroupKind = classifyModelGroup(modelId);
		const active = pool.activeAccount(modelId);
		const now = new Date();
		const nowSec = now.getTime() / 1000;

		const rows = await Promise.all(
			accounts.map(async (account) => {
				const tags: string[] = [];
				if (account.label === active?.label) tags.push("in use");
				if (state.preferred === account.label) tags.push("preferred");
				const cooldown = activeAccountCooldown(state, account.label, group, now);
				if (cooldown) {
					const untilSec = Date.parse(cooldown.until) / 1000;
					tags.push(`⛔ ${cooldown.reason} cooldown until ${resetAt(untilSec, nowSec)}`);
				}

				let quotaLine: string;
				try {
					const summary = await fetchQuota(account.tokenFile);
					quotaLine = formatSummaryCompact(summary, nowSec);
				} catch (error) {
					quotaLine = `quota unavailable (${(error as Error).message})`;
				}
				const suffix = tags.length > 0 ? ` (${tags.join(" · ")})` : "";
				return `- **${account.label}**${suffix} — ${quotaLine}`;
			}),
		);

		const footer: string[] = [];
		if (accounts.length === 1) {
			footer.push(
				"_Only one account configured. Run `/gemini-accounts login pro2` to add another._",
			);
		} else {
			footer.push(
				`_Order: ${accounts.map((a) => a.label).join(" → ")}${state.preferred ? ` (pinned: ${state.preferred}, use \`/gemini-accounts use auto\` to clear)` : ""}_`,
			);
		}
		note(`**🔀 /gemini-accounts**\n\n${rows.join("\n")}\n\n${footer.join("\n")}`);
	};

	const handleUse = async (rawTarget: string, ctx: ExtensionContext) => {
		const hook = ensureHook();
		const accounts = pool.orderedAccounts();
		if (accounts.length === 0) {
			note("**🔀 /gemini-accounts** — No accounts configured yet.");
			return;
		}

		let target = rawTarget.trim();
		if (!target) {
			const state = pool.state();
			const active = pool.activeAccount(ctx.model?.id);
			const options = [
				...accounts.map((account) => {
					const tags: string[] = [];
					if (account.label === active?.label) tags.push("in use");
					if (state.preferred === account.label) tags.push("preferred");
					return tags.length > 0 ? `${account.label} (${tags.join(", ")})` : account.label;
				}),
				`${AUTO_LABEL} — use priority order`,
			];
			const chosen = await ctx.ui.select("Switch active Antigravity account", options);
			if (!chosen) return;
			target = chosen.split(" ", 1)[0]!;
		}

		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (target.toLowerCase() === AUTO_LABEL) {
			pool.setPreferred(undefined);
			await hook?.invalidateSession(sessionId);
			syncStatus(ctx);
			const next = pool.activeAccount(ctx.model?.id);
			note(
				`**🔀 /gemini-accounts** — Switched to automatic priority mode${next ? ` (active: **${next.label}**)` : ""}.`,
			);
			return;
		}

		const match = accounts.find((a) => a.label === target);
		if (!match) {
			ctx.ui.notify(
				`Unknown account "${target}". Available: ${accounts.map((a) => a.label).join(", ")}`,
				"warning",
			);
			return;
		}

		pool.setPreferred(match.label);
		pool.clearCooldowns(match.label);
		await hook?.invalidateSession(sessionId);
		syncStatus(ctx);
		note(`**🔀 /gemini-accounts** — Now using **${match.label}**.`);
	};

	const handleLogin = async (rawLabel: string, ctx: ExtensionContext) => {
		const hook = ensureHook();
		const runtime = getSlot()?.runtime;
		if (!hook || !runtime || typeof runtime.loginGoogle !== "function") {
			note(
				"**🔐 /gemini-accounts login** — Antigravity ACP provider runtime is not loaded in this session.",
			);
			return;
		}

		let labelInput = rawLabel.trim();
		if (!labelInput) {
			const suggestion = suggestNextLabel(pool.accounts());
			const entered = await ctx.ui.input(
				`Account label (e.g. "${suggestion}", or "${PRIMARY_LABEL}")`,
				suggestion,
			);
			if (!entered?.trim()) return;
			labelInput = entered.trim();
		}

		let label: string;
		try {
			label = validateAccountLabel(labelInput);
		} catch (error) {
			ctx.ui.notify((error as Error).message, "warning");
			return;
		}

		const hadAccountBefore = pool.accounts().some((a) => a.label === label);
		const paths = prepareAccountDirectory(label);

		try {
			await hook.runWithGeminiHome(paths.geminiHome, () =>
				runtime.loginGoogle!(undefined, (message) => ctx.ui.notify(message, "info"), {
					showAuthorizationUrl(url) {
						note(
							[
								`**🔐 Google Sign-In for \`${label}\`**`,
								"",
								`1. [Open Google Sign-In](${url}) and sign in with the Google account for **${label}**.`,
								"2. After Google redirects to `127.0.0.1` (the page may fail to connect — that's expected), copy the **complete URL** from the browser address bar and paste it into the popup box.",
							].join("\n"),
						);
					},
					async promptForCallback(signal) {
						const callback = await ctx.ui.input(
							`Paste localhost callback URL for "${label}"`,
							"http://127.0.0.1:PORT/?state=...&code=...",
							{ signal, timeout: 300_000 },
						);
						if (!callback?.trim()) {
							throw new Error("Antigravity OAuth login cancelled.");
						}
						return callback.trim();
					},
				}),
			);
		} catch (error) {
			if (!hadAccountBefore && label !== PRIMARY_LABEL) {
				try {
					removeAccountSlot(label);
				} catch {
					// Ignore cleanup errors.
				}
			}
			note(`**🔐 /gemini-accounts login** — Failed for \`${label}\`: ${(error as Error).message}`);
			return;
		}

		const duplicateOf = findDuplicateLabel(paths.tokenFile, label);
		if (duplicateOf) {
			if (!hadAccountBefore && label !== PRIMARY_LABEL) {
				try {
					removeAccountSlot(label);
				} catch {
					// Ignore cleanup errors.
				}
			}
			note(
				`**⚠️ /gemini-accounts login** — \`${label}\` signed into the same Google account as **${duplicateOf}**. Sign in with a different Google account to add separate quota.`,
			);
			return;
		}

		pool.clearCooldowns(label);
		syncStatus(ctx);

		let quotaText = "";
		try {
			const summary = await fetchQuota(paths.tokenFile);
			quotaText = ` (${formatSummaryCompact(summary)})`;
		} catch {
			// Quota probe is optional right after login.
		}
		note(
			`**✅ /gemini-accounts login** — Signed in **${label}**${quotaText}. Automatic failover will use it whenever the active account runs out.`,
		);
	};

	const handleOrder = async (rawArgs: string, ctx: ExtensionContext) => {
		const requested = rawArgs.split(/\s+/).filter(Boolean);
		const accounts = pool.accounts();
		if (requested.length === 0) {
			ctx.ui.notify(
				`Usage: /gemini-accounts order <label1> <label2> ... (available: ${accounts.map((a) => a.label).join(", ")})`,
				"warning",
			);
			return;
		}
		const known = new Set(accounts.map((a) => a.label));
		const unknown = requested.filter((label) => !known.has(label));
		if (unknown.length > 0) {
			ctx.ui.notify(`Unknown account(s): ${unknown.join(", ")}`, "warning");
			return;
		}
		pool.setOrder(requested);
		await ensureHook()?.invalidateSession(ctx.sessionManager?.getSessionId?.());
		syncStatus(ctx);
		note(
			`**🔀 /gemini-accounts** — Priority order updated: ${pool
				.orderedAccounts()
				.map((a) => a.label)
				.join(" → ")}.`,
		);
	};

	const handleRemove = async (rawTarget: string, ctx: ExtensionContext) => {
		const target = rawTarget.trim();
		if (!target) {
			ctx.ui.notify("Usage: /gemini-accounts remove <label>", "warning");
			return;
		}
		try {
			const removed = removeAccountSlot(target);
			pool.forgetAccount(target);
			const hook = ensureHook();
			if (hook?.activeAccountLabelForSession(ctx.sessionManager?.getSessionId?.()) === target) {
				await hook.invalidateSession(ctx.sessionManager?.getSessionId?.());
			}
			syncStatus(ctx);
			note(
				removed
					? `**🗑️ /gemini-accounts** — Removed account **${target}**.`
					: `**🔀 /gemini-accounts** — Account **${target}** was not present.`,
			);
		} catch (error) {
			ctx.ui.notify((error as Error).message, "warning");
		}
	};

	pi.registerCommand("gemini-accounts", {
		description:
			"Manage pooled Google Antigravity accounts (/gemini-accounts [status|login|use|order|remove|reset])",
		handler: async (rawArgs, ctx) => {
			latestCtx = ctx;
			const trimmed = rawArgs.trim();
			const [sub = "", ...rest] = trimmed.split(/\s+/);
			const arg = rest.join(" ");
			switch (sub.toLowerCase()) {
				case "":
				case "status":
				case "list":
					await showStatus(ctx);
					break;
				case "use":
				case "switch":
					await handleUse(arg, ctx);
					break;
				case "login":
				case "add":
					await handleLogin(arg, ctx);
					break;
				case "order":
					await handleOrder(arg, ctx);
					break;
				case "remove":
				case "rm":
				case "delete":
					await handleRemove(arg, ctx);
					break;
				case "reset":
					pool.clearCooldowns();
					syncStatus(ctx);
					note("**🔀 /gemini-accounts** — Cleared all account cooldowns.");
					break;
				default:
					ctx.ui.notify(
						"Usage: /gemini-accounts [status | login [name] | use [name|auto] | order <names...> | remove <name> | reset]",
						"warning",
					);
			}
		},
	});

	return { pool, ensureHook };
}

export default function antigravityAccountPoolExtension(pi: ExtensionAPI): void {
	registerAntigravityAccountPool(pi);
}
