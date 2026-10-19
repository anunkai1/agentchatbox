import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import registerDelegate from "../extensions/delegate/index.js";
import {
	formatStatusList,
	parseDelegateArgs,
	readDelegation,
	resolveModelToken,
} from "../extensions/delegate/lib.js";

type Handler = (...args: unknown[]) => Promise<unknown>;

const MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-5-5" },
	{ provider: "anthropic", id: "claude-opus-5-5" },
	{ provider: "openai", id: "gpt-6.1-sol" },
];

function harness() {
	const tools = new Map<string, { execute: Handler }>();
	const events = new Map<string, Handler>();
	const commands = new Map<string, Handler>();
	let sessionName: string | undefined;
	const pi = {
		registerTool: (tool: { name: string; execute: Handler }) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: { handler: Handler }) =>
			commands.set(name, options.handler),
		on: (event: string, handler: Handler) => events.set(event, handler),
		getThinkingLevel: () => "high",
		getActiveTools: () => ["read"],
		setActiveTools: vi.fn(),
		getSessionName: () => sessionName,
		setSessionName: (name: string) => {
			sessionName = name;
		},
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	};
	let nextId = 0;
	const acb = {
		create: vi.fn(async () => `worker-${++nextId}`),
		prompt: vi.fn(async () => {}),
	};
	const telegram = vi.fn();
	registerDelegate(pi as never, acb as never, telegram);
	const ctx = (sessionId: string, branch: unknown[] = []) => ({
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
		model: { provider: "openai", id: "gpt-6.1-sol" },
		modelRegistry: {
			find: (p: string, id: string) => MODELS.find((m) => m.provider === p && m.id === id),
			getAvailable: () => MODELS,
		},
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		isIdle: () => true,
	});
	return { pi, acb, telegram, tools, events, commands, ctx };
}

beforeEach(() => {
	process.env.ACB_DELEGATIONS_DIR = mkdtempSync(join(tmpdir(), "acb-delegations-"));
});

describe("delegate extension", () => {
	it("starts a worker chat in the given folder with the parent's model", async () => {
		const h = harness();
		const result = (await h.tools
			.get("delegate")!
			.execute(
				"call",
				{ title: "Fix page", task: "Fix the journal page", cwd: tmpdir() },
				undefined,
				undefined,
				h.ctx("parent-1"),
			)) as { content: Array<{ text: string }> };
		const model = { provider: "openai", modelId: "gpt-6.1-sol", thinkingLevel: "high" };
		expect(h.acb.create).toHaveBeenCalledWith(tmpdir(), model);
		expect(h.acb.prompt).toHaveBeenCalledWith(
			"worker-1",
			expect.stringContaining("Fix the journal page"),
			model,
		);
		expect(h.acb.prompt.mock.calls[0][1]).toContain("[main chat](/s/parent-1)");
		expect(result.content[0].text).toContain("[Fix page](/s/worker-1)");
		expect(readDelegation("worker-1")).toMatchObject({
			parentSessionId: "parent-1",
			status: "working",
		});
	});

	it("uses a named model only when asked", async () => {
		const h = harness();
		await h.tools
			.get("delegate")!
			.execute(
				"call",
				{ title: "T", task: "t", cwd: tmpdir(), model: "sonnet" },
				undefined,
				undefined,
				h.ctx("parent-1"),
			);
		expect(h.acb.create.mock.calls[0][1]).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-5-5",
			thinkingLevel: "high",
		});
	});

	it("rejects a folder that does not exist", async () => {
		const h = harness();
		await expect(
			h.tools
				.get("delegate")!
				.execute(
					"call",
					{ title: "T", task: "t", cwd: "/no/such/folder" },
					undefined,
					undefined,
					h.ctx("parent-1"),
				),
		).rejects.toThrow("not an existing folder");
		expect(h.acb.create).not.toHaveBeenCalled();
	});

	it("reports a finished worker to its parent and the owner, once", async () => {
		const h = harness();
		await h.tools
			.get("delegate")!
			.execute(
				"call",
				{ title: "Fix page", task: "t", cwd: tmpdir() },
				undefined,
				undefined,
				h.ctx("parent-1"),
			);
		const worker = h.ctx("worker-1");
		await h.events.get("before_agent_start")!({}, worker);
		expect(h.pi.setActiveTools).toHaveBeenCalledWith(["read", "delegation_report"]);

		await h.events.get("message_end")!({ message: { role: "user" } }, worker);
		expect(h.pi.getSessionName()).toBe("Fix page");
		expect(h.pi.appendEntry).toHaveBeenLastCalledWith("delegation", {
			status: "working",
			parentSessionId: "parent-1",
		});
		expect(worker.ui.setStatus).toHaveBeenLastCalledWith("delegation", "working");

		await h.tools
			.get("delegation_report")!
			.execute(
				"call",
				{ status: "done", summary: "Fixed; 12 tests pass" },
				undefined,
				undefined,
				worker,
			);
		h.acb.prompt.mockClear();
		await h.events.get("agent_settled")!({ aborted: false }, worker);
		expect(readDelegation("worker-1")).toMatchObject({ status: "done", reportSeq: 1 });
		expect(h.telegram).toHaveBeenCalledWith(expect.stringContaining("Fixed; 12 tests pass"));
		expect(h.acb.prompt).toHaveBeenCalledWith("parent-1", "/delegate report worker-1", {
			provider: "openai",
			modelId: "gpt-6.1-sol",
			thinkingLevel: "high",
		});

		const report = h.commands.get("delegate")!;
		await report("report worker-1", h.ctx("someone-else"));
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		await report("report worker-1", h.ctx("parent-1"));
		await report("report worker-1", h.ctx("parent-1"));
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "note", content: expect.stringContaining("✅ done") }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	it("treats stopping without a report as needing the owner", async () => {
		const h = harness();
		await h.tools
			.get("delegate")!
			.execute(
				"call",
				{ title: "Q", task: "t", cwd: tmpdir() },
				undefined,
				undefined,
				h.ctx("parent-1"),
			);
		const branch = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Which DB?" }] },
			},
		];
		await h.events.get("agent_settled")!({}, h.ctx("worker-1", branch));
		expect(readDelegation("worker-1")).toMatchObject({
			status: "needs_input",
			summary: "Which DB?",
		});
	});

	it("does not wake anyone when the owner stops a worker", async () => {
		const h = harness();
		await h.tools
			.get("delegate")!
			.execute(
				"call",
				{ title: "Q", task: "t", cwd: tmpdir() },
				undefined,
				undefined,
				h.ctx("parent-1"),
			);
		h.acb.prompt.mockClear();
		await h.events.get("agent_settled")!({ aborted: true }, h.ctx("worker-1"));
		expect(readDelegation("worker-1")?.status).toBe("stopped");
		expect(h.acb.prompt).not.toHaveBeenCalled();
		expect(h.telegram).not.toHaveBeenCalled();
	});

	it("ignores ordinary chats", async () => {
		const h = harness();
		await h.events.get("message_end")!({ message: { role: "user" } }, h.ctx("plain"));
		await h.events.get("agent_settled")!({}, h.ctx("plain"));
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
		expect(h.acb.prompt).not.toHaveBeenCalled();
	});

	it("turns /delegate [model] <task> into a delegate request", async () => {
		const h = harness();
		const command = h.commands.get("delegate")!;
		await command("opus fix uploads", h.ctx("parent-1"));
		expect(h.pi.sendUserMessage).toHaveBeenLastCalledWith(
			expect.stringMatching(/model anthropic\/claude-opus-5-5[\s\S]*Task: fix uploads$/),
		);
		await command("fix uploads", h.ctx("parent-1"));
		expect(h.pi.sendUserMessage).toHaveBeenLastCalledWith(
			expect.stringMatching(/tool\. Pick[\s\S]*Task: fix uploads$/),
		);
	});

	it("lists the last delegations with links", async () => {
		const h = harness();
		await h.tools
			.get("delegate")!
			.execute(
				"call",
				{ title: "Fix page", task: "t", cwd: "/tmp" },
				undefined,
				undefined,
				h.ctx("parent-1"),
			);
		await h.commands.get("delegate")!("status", h.ctx("parent-1"));
		expect(h.pi.sendMessage.mock.calls[0][0].content).toContain("🟢 [Fix page](/s/worker-1) · tmp");
	});
});

describe("delegate helpers", () => {
	it("parses /delegate arguments", () => {
		expect(parseDelegateArgs("")).toEqual({ kind: "usage" });
		expect(parseDelegateArgs(" status ")).toEqual({ kind: "status" });
		expect(parseDelegateArgs("report abc")).toEqual({ kind: "report", id: "abc" });
		expect(parseDelegateArgs("sonnet do it")).toEqual({
			kind: "task",
			task: "sonnet do it",
			first: "sonnet",
			rest: "do it",
		});
	});

	it("matches model words exactly or uniquely", () => {
		expect(resolveModelToken("openai/gpt-6.1-sol", MODELS)?.id).toBe("gpt-6.1-sol");
		expect(resolveModelToken("opus", MODELS)?.id).toBe("claude-opus-5-5");
		expect(resolveModelToken("claude", MODELS)).toBeUndefined();
		expect(resolveModelToken("fix", MODELS)).toBeUndefined();
	});

	it("says when there is nothing to list", () => {
		expect(formatStatusList([])).toBe("No delegations yet.");
	});
});
