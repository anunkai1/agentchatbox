import { describe, expect, it, vi } from "vitest";
import { registerClaudeDelegate, runClaudeTask } from "../extensions/claude-delegate/index.js";
import {
	buildClaudeSpawn,
	buildPrompt,
	FileDelegationStore,
	parseDelegationMode,
	progressTail,
	StreamParser,
} from "../extensions/claude-delegate/lib.js";

describe("claude-delegate mode parsing", () => {
	it("accepts canonical modes and aliases", () => {
		expect(parseDelegationMode("off")).toBe("off");
		expect(parseDelegationMode("0")).toBe("off");
		expect(parseDelegationMode("opus")).toBe("opus");
		expect(parseDelegationMode("SONNET")).toBe("sonnet");
		expect(parseDelegationMode("haiku")).toBe("haiku");
		expect(parseDelegationMode("on")).toBe("sonnet");
		expect(parseDelegationMode("nonsense")).toBeUndefined();
	});
});

describe("claude-delegate spawn plan", () => {
	it("uses aliases, yolo permissions, and a fresh session id", () => {
		const plan = buildClaudeSpawn({ task: "do a thing", mode: "opus", newSessionId: "uuid-1" });
		expect(plan.args).toContain("--dangerously-skip-permissions");
		expect(plan.args).toContain("--output-format");
		expect(plan.args).toContain("stream-json");
		expect(plan.args[plan.args.indexOf("--model") + 1]).toBe("opus");
		expect(plan.args[plan.args.indexOf("--session-id") + 1]).toBe("uuid-1");
		expect(plan.args).not.toContain("--resume");
		expect(plan.args[1]).toContain("do a thing");
		expect(plan.args[1]).toContain("~/.secrets");
		expect(plan.env.BH_DOMAIN_SKILLS).toBe("1");
	});

	it("resumes a stored session and maps sonnet by default", () => {
		const plan = buildClaudeSpawn({ task: "t", mode: "sonnet", resumeSessionId: "uuid-2" });
		expect(plan.args[plan.args.indexOf("--model") + 1]).toBe("sonnet");
		expect(plan.args[plan.args.indexOf("--resume") + 1]).toBe("uuid-2");
		expect(plan.args).not.toContain("--session-id");
	});
});

describe("claude stream parser", () => {
	it("parses init, assistant text, and result events across chunk boundaries", () => {
		const parser = new StreamParser();
		const first = parser.feed(
			'{"type":"system","subtype":"init","session_id":"s-1"}\n{"type":"assist',
		);
		expect(first).toEqual([{ kind: "init", claudeSessionId: "s-1" }]);
		const second = parser.feed(
			'ant","message":{"content":[{"type":"text","text":"working on it"}]}}\n{"type":"result","subtype":"success","result":"done","is_error":false}\n',
		);
		expect(second).toEqual([
			{ kind: "text", text: "working on it" },
			{ kind: "result", text: "done", isError: false, usage: undefined },
		]);
	});

	it("ignores non-JSON noise", () => {
		const parser = new StreamParser();
		expect(parser.feed("not json at all\n")).toEqual([]);
	});

	it("caps progress tail length", () => {
		expect(progressTail("x".repeat(50), 10)).toBe(`…${"x".repeat(10)}`);
		expect(progressTail("short", 10)).toBe("short");
	});
});

describe("claude-delegate store", () => {
	it("round-trips mode and session mapping", () => {
		const modePath = `/tmp/claude-delegate-test-${process.pid}`;
		const sessionsPath = `${modePath}-sessions.json`;
		const store = new FileDelegationStore(modePath, sessionsPath);
		expect(store.readMode()).toBe("off");
		store.writeMode("haiku");
		expect(store.readMode()).toBe("haiku");
		store.writeClaudeSession("chat-1", "s-42");
		expect(store.readClaudeSession("chat-1")).toBe("s-42");
		store.clearClaudeSession("chat-1");
		expect(store.readClaudeSession("chat-1")).toBeUndefined();
	});
});

describe("delegated prompt", () => {
	it("forbids credential access and asks for a summary", () => {
		const prompt = buildPrompt("register an account");
		expect(prompt).toContain("register an account");
		expect(prompt).toContain("Never read, copy, or transmit");
		expect(prompt).toContain("/home/lepton/agentchatbox/uploads/");
		expect(prompt).toContain("never Anthropic's built-in browser/computer-use skills");
	});
});

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function harness(mode = "off") {
	let current = mode;
	const store = {
		readMode: () => current as never,
		writeMode: (next: string) => {
			current = next;
		},
		readClaudeSession: () => undefined,
		writeClaudeSession: () => undefined,
		clearClaudeSession: () => undefined,
	};
	let commandHandler: CommandHandler | undefined;
	let activeTools = ["read", "bash"];
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	const notify = vi.fn();
	const setStatus = vi.fn();
	const registered: Array<{ name: string; execute?: unknown }> = [];
	registerClaudeDelegate(
		{
			registerCommand(_name: string, options: { handler: CommandHandler }) {
				commandHandler = options.handler;
			},
			registerTool(definition: { name: string; execute?: unknown }) {
				registered.push(definition);
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => void) {
				if (event === "session_start") sessionStart = handler;
			},
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as never,
		store as never,
		"/tmp/claude-delegate-workspace",
	);
	const ui = {
		notify,
		select: vi.fn(async (_title: string, options: string[]) => options[1]),
		setStatus,
	};
	const uiCtx = { ui };
	return {
		get mode() {
			return current;
		},
		get activeTools() {
			return activeTools;
		},
		command: commandHandler!,
		sessionStart: () => sessionStart?.({}, uiCtx),
		registered,
		ui,
		uiCtx,
	};
}

describe("claude-delegate registration", () => {
	it("starts off with the tool inactive and reports the label", async () => {
		const h = harness("off");
		await h.command("report", h.uiCtx);
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Off");
	});

	it("enables the tool when a mode is selected", async () => {
		const h = harness("off");
		await h.command("opus", h.uiCtx);
		expect(h.mode).toBe("opus");
		expect(h.activeTools).toContain("claude_code_task");
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus");
	});

	it("removes the tool when disabled", async () => {
		const h = harness("sonnet");
		await h.command("off", h.uiCtx);
		expect(h.mode).toBe("off");
		expect(h.activeTools).not.toContain("claude_code_task");
	});

	it("syncs availability on session start", async () => {
		const h = harness("haiku");
		h.sessionStart();
		expect(h.activeTools).toContain("claude_code_task");
	});
});

describe("runClaudeTask", () => {
	it("streams text and returns the final result", async () => {
		const script = [
			'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"s-9"})+"\\n");',
			'process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"step one"}]}})+"\\n");',
			'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"all done",is_error:false})+"\\n");',
		].join("\n");
		const updates: string[] = [];
		const outcome = await runClaudeTask(["-e", script], {
			cwd: process.cwd(),
			env: {},
			bin: process.execPath,
			onText: (tail) => updates.push(tail),
		});
		expect(outcome.claudeSessionId).toBe("s-9");
		expect(outcome.resultText).toBe("all done");
		expect(outcome.isError).toBe(false);
		expect(updates).toEqual(["step one"]);
	});

	it("marks a failing run as an error", async () => {
		const script = 'process.stderr.write("boom");process.exit(3);';
		const outcome = await runClaudeTask(["-e", script], {
			cwd: process.cwd(),
			env: {},
			bin: process.execPath,
		});
		expect(outcome.isError).toBe(true);
		expect(outcome.resultText).toContain("boom");
	});
});
