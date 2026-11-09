/**
 * plan-usage — pi extension
 *
 * Allowance commands for the subscription-backed providers, so the remaining
 * quota is visible from chat instead of in each vendor's own UI:
 *
 *  - `/gpt-usage`    ChatGPT plan windows and credits (see gpt.ts).
 *  - `/argon-usage`  Antigravity's five-hour and weekly Gemini/Claude allowance
 *                    (see argon.ts).
 *
 * `/venice-balance` reports Venice's key balances and lives with the key pool;
 * this extension is the same idea for the two plan-limited providers. Each
 * command is one note, so nothing extra reaches the model.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchQuota, formatQuota } from "./argon.js";
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

	pi.registerCommand("argon-usage", {
		description: "Show Antigravity (Gemini 4 Argon) usage: 5-hour and weekly allowance",
		handler: report("**📊 /argon-usage**", async () => formatQuota(await fetchQuota())),
	});
}
