import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_COMMANDS } from "./lib.js";

/**
 * Register user-facing agent workflows with pi. ACB is free to render shortcut
 * buttons for these commands, but pi owns validation, prompt construction, and
 * delivery so the same commands work in the TUI and every RPC client.
 */
export default function registerAcbWorkflows(pi: ExtensionAPI): void {
	for (const command of WORKFLOW_COMMANDS) {
		pi.registerCommand(command.name, {
			description: command.description,
			handler: async (rawArgs, ctx) => {
				const args = rawArgs.trim();
				const prompt = command.buildPrompt(args);
				if (!prompt) {
					ctx.ui.notify(`Usage: ${command.usage ?? `/${command.name}`}`, "warning");
					return;
				}

				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					ctx.ui.notify(`/${command.name} queued for the next turn`, "info");
				}
			},
		});
	}
}
