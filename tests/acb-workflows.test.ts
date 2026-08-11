import { describe, expect, it, vi } from "vitest";
import registerAcbWorkflows from "../extensions/acb-workflows/index.js";
import { WORKFLOW_COMMANDS, workflowByName } from "../extensions/acb-workflows/lib.js";

type Context = {
	isIdle(): boolean;
	ui: { notify(message: string, level: string): void };
};
type Handler = (args: string, ctx: Context) => Promise<void>;

function harness(idle = true) {
	const handlers = new Map<string, Handler>();
	const sendUserMessage = vi.fn();
	const notify = vi.fn();
	registerAcbWorkflows({
		registerCommand(name: string, options: { handler: Handler }) {
			handlers.set(name, options.handler);
		},
		sendUserMessage,
	} as never);
	return {
		handlers,
		sendUserMessage,
		notify,
		ctx: { isIdle: () => idle, ui: { notify } },
	};
}

describe("ACB pi workflows", () => {
	it("registers every workflow as a pi command", () => {
		const { handlers } = harness();
		expect([...handlers.keys()]).toEqual(WORKFLOW_COMMANDS.map((command) => command.name));
	});

	it("keeps welcome prompts out of browser code", async () => {
		const { handlers, sendUserMessage, ctx } = harness();
		await handlers.get("design")!("", ctx);
		expect(sendUserMessage).toHaveBeenCalledWith(
			"Design and build a small interactive web page for me. Pick the layout, colors, and copy.",
		);
	});

	it("builds sourced research prompts from trimmed arguments", async () => {
		const { handlers, sendUserMessage, ctx } = harness();
		await handlers.get("research")!("  pi extension commands  ", ctx);
		expect(sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Use web_search to look up: pi extension commands"),
		);
	});

	it("routes code search through the current web_search tool", () => {
		const prompt = workflowByName("codesearch")?.buildPrompt("TypeScript streams");
		expect(prompt).toContain("Use web_search");
		expect(prompt).not.toContain("code_search");
	});

	it("reports usage instead of starting an empty tool workflow", async () => {
		const { handlers, sendUserMessage, notify, ctx } = harness();
		await handlers.get("fetch")!("   ", ctx);
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Usage: /fetch <url>", "warning");
	});

	it("queues a follow-up when invoked during an active run", async () => {
		const { handlers, sendUserMessage, notify, ctx } = harness(false);
		await handlers.get("writing")!("", ctx);
		expect(sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "followUp" });
		expect(notify).toHaveBeenCalledWith("/writing queued for the next turn", "info");
	});
});
