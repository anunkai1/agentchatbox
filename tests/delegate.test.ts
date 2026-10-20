import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerDelegate from "../extensions/delegate/index.js";
import {
	BRIEF_GUIDANCE,
	buildBrief,
	type Delegation,
	DISPATCH_GUIDANCE,
	formatStatusList,
	parseDelegateArgs,
	parseStatusLine,
	REPORT_GUIDANCE,
	readDelegation,
	resolveModelToken,
	STATUS_NOTE,
	writeDelegation,
} from "../extensions/delegate/lib.js";

type Handler = (...args: unknown[]) => Promise<unknown>;
type Tool = {
	name: string;
	execute: Handler;
	description: string;
	promptGuidelines?: string[];
	parameters: { properties: Record<string, { description?: string }> };
	annotations?: { readOnlyHint?: boolean };
};

const MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-5-5" },
	{ provider: "anthropic", id: "claude-opus-5-5" },
	{ provider: "openai", id: "gpt-6.1-sol" },
];

function harness() {
	const tools = new Map<string, Tool>();
	const events = new Map<string, Handler>();
	const commands = new Map<string, Handler>();
	let sessionName: string | undefined;
	// pi.events: the bus claude-delegate talks to this extension on.
	const bus = new EventEmitter();
	const pi = {
		events: {
			emit: (channel: string, data: unknown) => bus.emit(channel, data),
			on: (channel: string, handler: (data: unknown) => void) => {
				bus.on(channel, handler);
				return () => bus.off(channel, handler);
			},
		},
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
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

let recordsDir: string;
beforeEach(() => {
	recordsDir = mkdtempSync(join(tmpdir(), "acb-delegations-"));
	vi.stubEnv("ACB_DELEGATIONS_DIR", recordsDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(recordsDir, { recursive: true, force: true });
});

function saveWorker(id: string, overrides: Partial<Delegation> = {}): Delegation {
	const model = { provider: "openai", modelId: "gpt-6.1-sol", thinkingLevel: "high" };
	const record: Delegation = {
		id,
		title: "Fix journal",
		task: "Restore the journal page; verify with the journal tests.",
		cwd: tmpdir(),
		parentSessionId: "parent-1",
		parentModel: model,
		workerModel: model,
		status: "working",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T01:00:00.000Z",
		reportSeq: 0,
		...overrides,
	};
	writeDelegation(record);
	return record;
}

async function workerStatus(h: ReturnType<typeof harness>, params = {}) {
	const result = (await h.tools.get("delegate_status")!.execute("call", params)) as {
		content: Array<{ text: string }>;
		structuredContent: {
			note: string;
			total: number;
			offset: number;
			nextOffset: number | null;
			workers: Array<
				Pick<
					Delegation,
					"id" | "title" | "task" | "cwd" | "parentSessionId" | "status" | "updatedAt"
				> & {
					recordPath: string;
					url: string;
					parentUrl: string;
					summary: string | null;
				}
			>;
		};
	};
	expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
	return result.structuredContent;
}

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
		expect(h.acb.prompt).toHaveBeenCalledWith("worker-1", "/delegate start worker-1", model);
		// The worker's own copy of the extension then sends the brief.
		await h.commands.get("delegate")!("start worker-1", h.ctx("worker-1"));
		const brief = h.pi.sendUserMessage.mock.calls[0][0];
		expect(brief).toContain("Fix the journal page");
		expect(brief).toContain("[main chat](/s/parent-1)");
		expect(brief).toContain("delegation_report");
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
			expect.stringMatching(/delegate tool or delegate_message[\s\S]*Task: fix uploads$/),
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
		expect(h.pi.sendMessage.mock.calls[0][0].content).toContain(
			"🟢 [Fix page](/s/worker-1) · working (recorded) · /tmp",
		);
		expect(h.pi.sendMessage.mock.calls[0][0].content).toContain(STATUS_NOTE);
	});
});

describe("delegation guidance and context reuse", () => {
	it("supplies a brief template and adds collaboration/report guidance to every brief", () => {
		const h = harness();
		const task = [
			"Goal and why: Restore the journal so the owner can read it.",
			"Known facts: src/page.ts fails with 'missing journal'; owner said 'fix this'.",
			"Done when: Journal tests pass; return the changed paths and test output.",
		].join("\n");
		const brief = buildBrief(saveWorker("worker-1", { task }));
		expect(brief).toContain(task);
		expect(brief).toContain("You are not alone. Other workers may be editing this repository");
		expect(brief).toContain("preserve their changes and do not undo them");
		expect(brief).toContain("rather than inventing facts or asking the owner unnecessarily");
		expect(brief).toContain(REPORT_GUIDANCE);
		expect(brief).toMatch(/result first, then evidence[\s\S]*then open questions/);
		expect(brief).toContain("normally under 300 words");
		expect(h.tools.get("delegate")!.parameters.properties.task.description).toBe(BRIEF_GUIDANCE);
		expect(h.tools.get("delegation_report")!.parameters.properties.summary.description).toBe(
			REPORT_GUIDANCE,
		);
	});

	it("guides approved independent dispatches, topic reuse and no speculative progress", async () => {
		const h = harness();
		const tool = h.tools.get("delegate")!;
		expect(tool.promptGuidelines).toEqual([...DISPATCH_GUIDANCE, BRIEF_GUIDANCE]);
		expect(tool.description).toContain("ordinary requests are not approval");
		expect(tool.description).toContain("independently/concurrently");
		expect(tool.description).toContain("Do not split tightly dependent work unnecessarily");
		expect(tool.description).toContain("After all dispatches");
		expect(tool.description).toContain("Do not reuse an unrelated worker");
		expect(h.tools.get("delegate_message")!.description).toContain("retains context");
		expect(h.tools.get("delegate_status")!.promptGuidelines?.join(" ")).toContain(
			"never guess results or progress",
		);
		await h.commands.get("d")!("fix uploads and investigate the printer", h.ctx("parent-1"));
		const prompt = h.pi.sendUserMessage.mock.calls[0][0];
		for (const guidance of [...DISPATCH_GUIDANCE, BRIEF_GUIDANCE])
			expect(prompt).toContain(guidance);
		expect(prompt).toContain("Task: fix uploads and investigate the printer");
	});

	it("allows independent workers to be dispatched concurrently in the same repository", async () => {
		const h = harness();
		const results = await Promise.all(
			["Fix uploads", "Fix journal"].map((title) =>
				h.tools
					.get("delegate")!
					.execute(
						"call",
						{ title, task: title, cwd: tmpdir() },
						undefined,
						undefined,
						h.ctx("parent-1"),
					),
			),
		);
		expect(h.acb.create).toHaveBeenCalledTimes(2);
		expect(results).toHaveLength(2);
		expect(readDelegation("worker-1")?.title).toBe("Fix uploads");
		expect(readDelegation("worker-2")?.title).toBe("Fix journal");
	});

	it("finds and resumes the same-topic worker without a new chat or model/parent change", async () => {
		const h = harness();
		const record = saveWorker("journal-worker", {
			status: "done",
			workerModel: { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "low" },
		});
		const data = await workerStatus(h, { query: "journal restore", parentSessionId: "parent-1" });
		expect(data.workers.map((r) => r.id)).toEqual([record.id]);
		await h.tools.get("delegate_message")!.execute("call", {
			worker: data.workers[0].id,
			message: "Also cover the missing-journal regression.",
		});
		expect(h.acb.create).not.toHaveBeenCalled();
		expect(h.acb.prompt).toHaveBeenCalledWith(
			record.id,
			"Also cover the missing-journal regression.",
			record.workerModel,
		);
		await h.events.get("message_end")!({ message: { role: "user" } }, h.ctx(record.id));
		expect(readDelegation(record.id)).toMatchObject({
			parentSessionId: "parent-1",
			workerModel: record.workerModel,
			status: "working",
		});
	});

	it.each([
		"needs_input",
		"failed",
	] as const)("delivers a useful %s report unchanged to the parent and Telegram", async (status) => {
		const h = harness();
		saveWorker("worker-1");
		const summary =
			status === "needs_input"
				? "Result: Need a database choice.\nEvidence: Found SQLite and Postgres configs.\nOpen questions: Use SQLite? Recommended for this local task."
				: "Result: Blocked by missing fixtures.\nEvidence: Test runner reports ENOENT; no files changed.\nOpen questions: Restore fixtures, then rerun journal tests.";
		await h.tools
			.get("delegation_report")!
			.execute("call", { status, summary }, undefined, undefined, h.ctx("worker-1"));
		await h.events.get("agent_settled")!({}, h.ctx("worker-1"));
		expect(readDelegation("worker-1")).toMatchObject({ status, summary, reportSeq: 1 });
		expect(h.telegram).toHaveBeenCalledWith(expect.stringContaining(summary));
		await h.commands.get("d")!("report worker-1", h.ctx("parent-1"));
		expect(h.pi.sendMessage.mock.calls[0][0].content).toContain(summary);
		expect(h.pi.sendMessage.mock.calls[0][0].content).toContain("do not invent missing evidence");
	});
});

describe("record-backed delegate_status", () => {
	it("returns factual task/status/repo/parent metadata without observing or mutating workers", async () => {
		const h = harness();
		const record = saveWorker("old-worker", { summary: "Previous report only." });
		const file = join(recordsDir, `${record.id}.json`);
		const before = readFileSync(file, "utf8");
		const data = await workerStatus(h, { worker: record.id });
		expect(data).toMatchObject({ total: 1, offset: 0, nextOffset: null, note: STATUS_NOTE });
		expect(data.workers[0]).toEqual({
			id: record.id,
			title: record.title,
			task: record.task,
			recordPath: file,
			cwd: record.cwd,
			parentSessionId: record.parentSessionId,
			status: "working",
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			summary: "Previous report only.",
			url: "/s/old-worker",
			parentUrl: "/s/parent-1",
		});
		expect(data.note).toContain("not proof that it is still running");
		expect(data.note).toContain("may predate the current turn");
		expect(h.tools.get("delegate_status")!.annotations?.readOnlyHint).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(h.acb.create).not.toHaveBeenCalled();
		expect(h.acb.prompt).not.toHaveBeenCalled();
		expect(h.telegram).not.toHaveBeenCalled();
	});

	it("pages the last ten and searches older task/title records before limiting", async () => {
		const h = harness();
		saveWorker("older-journal");
		for (let day = 2; day <= 13; day++) {
			saveWorker(`uploads-${day}`, {
				title: "Uploads",
				task: "Fix uploads",
				createdAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
			});
		}
		const first = await workerStatus(h);
		expect(first).toMatchObject({ total: 13, offset: 0, nextOffset: 10 });
		expect(first.workers).toHaveLength(10);
		expect(first.workers[0].id).toBe("uploads-13");
		const next = await workerStatus(h, { offset: first.nextOffset });
		expect(next).toMatchObject({ total: 13, offset: 10, nextOffset: null });
		expect(next.workers.map((r) => r.id)).toEqual(["uploads-3", "uploads-2", "older-journal"]);
		const topic = await workerStatus(h, { query: "RESTORE journal", cwd: tmpdir(), limit: 1 });
		expect(topic.workers.map((r) => r.id)).toEqual(["older-journal"]);
		expect(topic.total).toBe(1);
		await h.commands.get("d")!("status", h.ctx("parent-1"));
		expect(h.pi.sendMessage.mock.calls[0][0].content).toContain("Last 10 delegations");
		expect(h.pi.sendMessage.mock.calls[0][0].content).not.toContain("older-journal");
	});

	it("bounds long task/report excerpts but searches and links to the complete saved context", async () => {
		const h = harness();
		const record = saveWorker("long-brief", {
			task: `${"Known facts. ".repeat(500)} Searchable ending.`,
			summary: "Evidence. ".repeat(500),
		});
		const data = await workerStatus(h, { query: "searchable ending" });
		expect(data.total).toBe(1);
		const result = data.workers[0];
		expect(result.task.length).toBeLessThan(1_100);
		expect(result.summary!.length).toBeLessThan(1_100);
		expect(result.task).toContain("[truncated; read recordPath for full text]");
		expect(JSON.parse(readFileSync(result.recordPath, "utf8"))).toMatchObject({
			task: record.task,
			summary: record.summary,
		});
	});

	it("filters exact worker, parent and cwd, and tolerates absent/corrupt records", async () => {
		const h = harness();
		expect(await workerStatus(h)).toMatchObject({ total: 0, workers: [], nextOffset: null });
		saveWorker("worker-1", { status: "needs_input" });
		saveWorker("worker-2", { status: "failed", parentSessionId: "parent-2" });
		writeFileSync(join(recordsDir, "broken.json"), "{");
		expect((await workerStatus(h, { parentSessionId: "parent-2" })).workers[0].status).toBe(
			"failed",
		);
		expect((await workerStatus(h, { worker: "worker-1" })).workers[0].status).toBe("needs_input");
		for (const params of [
			{ worker: "unknown" },
			{ cwd: "/another/repo" },
			{ query: "unrelated" },
		]) {
			expect(await workerStatus(h, params)).toMatchObject({ total: 0, workers: [] });
		}
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

describe("delegate when the chat limit is reached", () => {
	it("tells the owner when a worker cannot wake its main chat", async () => {
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
		h.acb.prompt.mockRejectedValueOnce(new Error("ACB: Chat limit reached"));
		await h.events.get("agent_settled")!({}, h.ctx("worker-1"));
		expect(h.telegram).toHaveBeenLastCalledWith(
			expect.stringContaining(
				'Worker "Fix page" could not report to the main chat: ACB: Chat limit reached',
			),
		);
	});
});

describe("/d shortcut", () => {
	it("is the same command as /delegate", async () => {
		const h = harness();
		expect(h.commands.get("d")).toBe(h.commands.get("delegate"));
		await h.commands.get("d")!("status", h.ctx("parent-1"));
		expect(h.pi.sendMessage.mock.calls[0][0].content).toBe("No delegations yet.");
	});
});

describe("Claude Code workers", () => {
	function claudeChat(h: ReturnType<typeof harness>, mode = "opus") {
		const starts: Array<{ mode: string; task: string }> = [];
		h.pi.events.on("claude-delegate:query", (data) =>
			(data as { reply(mode?: string): void }).reply(mode),
		);
		h.pi.events.on("claude-delegate:start", (data) => {
			const start = data as { mode: string; task: string; accept(): void };
			start.accept();
			starts.push({ mode: start.mode, task: start.task });
		});
		return starts;
	}

	async function delegate(h: ReturnType<typeof harness>, model?: string) {
		return (await h.tools.get("delegate")!.execute(
			"call",
			{
				title: "Fix page",
				task: "Fix the journal page",
				cwd: tmpdir(),
				...(model ? { model } : {}),
			},
			undefined,
			undefined,
			h.ctx("parent-1"),
		)) as { content: Array<{ text: string }> };
	}

	it("follow the main chat's Claude Code mode and report with a status line", async () => {
		const h = harness();
		const starts = claudeChat(h);
		const result = await delegate(h);
		expect(readDelegation("worker-1")?.claude).toBe("opus");
		expect(result.content[0].text).toContain("(Claude Code opus)");
		await h.commands.get("delegate")!("start worker-1", h.ctx("worker-1"));
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(starts).toHaveLength(1);
		expect(starts[0].mode).toBe("opus");
		expect(starts[0].task).toContain("Status: done");
		expect(starts[0].task).not.toContain("call delegation_report");
		expect(starts[0].task).toContain(`work in ${tmpdir()}, and first read the AGENTS.md there`);
	});

	it("use a named Claude Code model", async () => {
		const h = harness();
		claudeChat(h);
		await delegate(h, "sonnet");
		expect(readDelegation("worker-1")?.claude).toBe("sonnet");
	});

	it("report through the same path as pi workers when a run ends", async () => {
		const h = harness();
		claudeChat(h);
		await delegate(h);
		const worker = h.ctx("worker-1");
		h.pi.events.emit("claude-delegate:run-start", { ctx: worker });
		expect(readDelegation("worker-1")?.status).toBe("working");
		expect(worker.ui.setStatus).toHaveBeenLastCalledWith("delegation", "working");
		h.acb.prompt.mockClear();
		h.pi.events.emit("claude-delegate:run-end", {
			ctx: worker,
			text: "Fixed the page; 12 tests pass.\n\nStatus: done",
		});
		await vi.waitFor(() => expect(h.acb.prompt).toHaveBeenCalled());
		expect(readDelegation("worker-1")).toMatchObject({
			status: "done",
			summary: "Fixed the page; 12 tests pass.",
			reportSeq: 1,
		});
		expect(h.acb.prompt).toHaveBeenCalledWith(
			"parent-1",
			"/delegate report worker-1",
			expect.anything(),
		);
		expect(h.telegram).toHaveBeenCalledWith(expect.stringContaining("✅ Worker done"));
	});

	it("treat a missing status line as needing the owner, and a stop as stopped", async () => {
		const h = harness();
		claudeChat(h);
		await delegate(h);
		const worker = h.ctx("worker-1");
		h.pi.events.emit("claude-delegate:run-end", { ctx: worker, text: "Which DB?" });
		await vi.waitFor(() => expect(readDelegation("worker-1")?.status).toBe("needs_input"));
		h.acb.prompt.mockClear();
		h.telegram.mockClear();
		h.pi.events.emit("claude-delegate:run-end", { ctx: worker, cancelled: true });
		await vi.waitFor(() => expect(readDelegation("worker-1")?.status).toBe("stopped"));
		expect(h.acb.prompt).not.toHaveBeenCalled();
		expect(h.telegram).not.toHaveBeenCalled();
	});

	it("ignore a pi run that is not the worker's own", async () => {
		const h = harness();
		claudeChat(h);
		await delegate(h);
		h.acb.prompt.mockClear();
		await h.events.get("agent_settled")!({}, h.ctx("worker-1"));
		expect(readDelegation("worker-1")?.status).toBe("working");
		expect(h.acb.prompt).not.toHaveBeenCalled();
	});

	it("fall back to pi when Claude Code is unavailable", async () => {
		const h = harness();
		h.pi.events.on("claude-delegate:query", (data) =>
			(data as { reply(mode?: string): void }).reply("opus"),
		);
		await delegate(h);
		await h.commands.get("delegate")!("start worker-1", h.ctx("worker-1"));
		expect(readDelegation("worker-1")?.claude).toBeUndefined();
		expect(h.pi.sendUserMessage.mock.calls[0][0]).toContain("delegation_report");
	});

	it("read the closing status line", () => {
		expect(parseStatusLine("All good.\nStatus: done")).toEqual({
			status: "done",
			summary: "All good.",
		});
		expect(parseStatusLine("Q?\n**Status:** needs input")).toEqual({
			status: "needs_input",
			summary: "Q?",
		});
		expect(parseStatusLine("Status: failed — no access")).toEqual({
			status: "failed",
			summary: "",
		});
		expect(parseStatusLine("No status here")).toEqual({ summary: "No status here" });
	});
});

describe("reports to a main chat in Claude Code mode", () => {
	it("go to Claude Code, with the command-line way to answer the worker", async () => {
		const h = harness();
		writeDelegation({
			id: "worker-9",
			title: "Fix page",
			task: "t",
			cwd: "/tmp",
			parentSessionId: "parent-1",
			parentModel: { provider: "openai", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
			workerModel: { provider: "openai", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
			claude: "opus",
			status: "done",
			summary: "Fixed.",
			createdAt: "2026-10-20T00:00:00.000Z",
			updatedAt: "2026-10-20T00:00:00.000Z",
			reportSeq: 1,
		});
		const runs: string[] = [];
		h.pi.events.on("claude-delegate:query", (d) =>
			(d as { reply(m?: string): void }).reply("opus"),
		);
		h.pi.events.on("claude-delegate:run", (d) => {
			const run = d as { task: string; accept(): void };
			run.accept();
			runs.push(run.task);
		});
		await h.commands.get("delegate")!("report worker-9", h.ctx("parent-1"));
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toContain("Fixed.");
		expect(runs[0]).toContain("cli.ts message <worker id>");
		expect(runs[0]).toContain("Worker id: worker-9");
	});
});
