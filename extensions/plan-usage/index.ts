/**
 * plan-usage — pi extension
 *
 * Allowance commands for the subscription-backed providers, so the remaining
 * quota is visible from chat instead of in each vendor's own UI:
 *
 *  - `/gpt-usage`     ChatGPT plan windows and credits (see gpt.ts).
 *  - `/gemini-usage`  Antigravity's five-hour and weekly Gemini/Claude allowance
 *                     (see gemini.ts).
 *
 * `/venice-balance` reports Venice's key balances and lives with the key pool;
 * this extension is the same idea for the two plan-limited providers. Each
 * command is one note, so nothing extra reaches the model.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountPool } from "../antigravity-account-pool/pool.js";
import { fetchQuota, formatQuota } from "./gemini.js";
import { fetchFirstUsage, formatUsage } from "./gpt.js";

export default function registerPlanUsage(pi: ExtensionAPI): void {
	const note = (content: string) =>
		pi.sendMessage({ customType: "note", content, display: true }, { triggerTurn: false });

	const report = (header: string, load: () => Promise<string[]>) => async () => {
		try {
			note((await load()).join("\n\n"));
		} catch (error) {
			note(`${header} — ${(error as Error).message}`);
		}
	};

	pi.registerCommand("gpt-usage", {
		description: "Show ChatGPT (GPT/Codex) plan usage: 5-hour and weekly allowance, credits",
		handler: report("**📊 /gpt-usage**", async () => formatUsage(await fetchFirstUsage())),
	});

	pi.registerCommand("gemini-usage", {
		description: "Show Antigravity (Gemini) usage: 5-hour and weekly allowance",
		handler: report("**📊 /gemini-usage**", async () => {
			const pool = new AccountPool();
			const accounts = pool.orderedAccounts();
			if (accounts.length <= 1) {
				const tokenFile = accounts[0]?.tokenFile;
				return formatQuota(await fetchQuota(tokenFile));
			}
			const active = pool.activeAccount();
			const sections = await Promise.all(
				accounts.map(async (account) => {
					const tag = account.label === active?.label ? " (in use)" : "";
					try {
						const lines = formatQuota(await fetchQuota(account.tokenFile));
						lines[0] = `**${account.label}${tag}** — ${lines[0]!.replace(/^\*\*📊 \/gemini-usage\*\*\s*—\s*/, "")}`;
						return lines.join("\n\n");
					} catch (error) {
						return `**${account.label}${tag}** — ${(error as Error).message}`;
					}
				}),
			);
			return ["**📊 /gemini-usage**", ...sections];
		}),
	});
}
