/**
 * gpt-usage — pi extension
 *
 * `/gpt-usage` reports the ChatGPT plan's own allowance (five-hour window,
 * weekly window, credits) the way `/venice-balance` reports Venice's key
 * balances, so the remaining allowance for the `openai` provider is visible
 * without opening Codex's status panel. All the reporting lives in usage.ts;
 * this file is only the command adapter.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchFirstUsage, formatUsage } from "./usage.js";

export default function registerGptUsage(pi: ExtensionAPI): void {
	const note = (content: string) =>
		pi.sendMessage({ customType: "note", content, display: true }, { triggerTurn: false });

	pi.registerCommand("gpt-usage", {
		description: "Show ChatGPT (GPT/Codex) plan usage: 5-hour and weekly allowance, credits",
		handler: async () => {
			try {
				note(formatUsage(await fetchFirstUsage()).join("\n\n"));
			} catch (error) {
				note(`**📊 /gpt-usage** — ${(error as Error).message}`);
			}
		},
	});
}
