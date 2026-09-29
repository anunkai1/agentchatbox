import { describe, expect, it, vi } from "vitest";
import { registerClaudeDelegate, runClaudeTask } from "../extensions/claude-delegate/index.js";
import {
	buildClaudeSpawn,
	buildPrompt,
	delegationLabel,
	FileDelegationStore,
	parseDelegationMode,
	prettyModelName,
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
			{ kind: "text", text: "working on it", model: undefined },
			{ kind: "result", text: "done", isError: false, usage: undefined, models: undefined },
		]);
	});

	it("reports the model from init, assistant and modelUsage events", () => {
		const parser = new StreamParser();
		const events = parser.feed(
			[
				'{"type":"system","subtype":"init","session_id":"s-2","model":"claude-opus-5-5"}',
				'{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}]}}',
				'{"type":"result","subtype":"success","result":"ok","is_error":false,"modelUsage":{"claude-opus-5-5":{"canonicalModel":"claude-opus-5-5"},"claude-haiku-4-5-20251001":{"canonicalModel":"claude-haiku-4-5-20251001"}}}',
				"",
			].join("\n"),
		);
		expect(events[0]).toEqual({ kind: "init", claudeSessionId: "s-2", model: "claude-opus-5-5" });
		expect(events[1]).toEqual({ kind: "text", text: "hi", model: "claude-opus-5-5" });
		expect(events[2]).toMatchObject({
			kind: "result",
			models: ["claude-opus-5-5", "claude-haiku-4-5-20251001"],
		});
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

describe("model version labels", () => {
	it("prettifies wire model ids", () => {
		expect(prettyModelName("claude-opus-5-5")).toBe("Opus 5.5");
		expect(prettyModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
		expect(prettyModelName("claude-sonnet-5")).toBe("Sonnet 5");
		expect(prettyModelName("claude-fable-5-1")).toBe("Fable 5.1");
	});

	it("labels a mode with its resolved version", () => {
		expect(delegationLabel("opus")).toBe("Opus");
		expect(delegationLabel("opus", "claude-opus-5-5")).toBe("Opus 5.5");
		expect(delegationLabel("haiku", "claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
		// A cross-family alias still names both halves.
		expect(delegationLabel("opus", "claude-fable-5-1")).toBe("Opus (Fable 5.1)");
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

	it("remembers the resolved model per mode", () => {
		const modePath = `/tmp/claude-delegate-models-${process.pid}`;
		const store = new FileDelegationStore(
			`${modePath}-mode`,
			`${modePath}-sessions.json`,
			`${modePath}-models.json`,
		);
		expect(store.readModel("opus")).toBeUndefined();
		store.writeModel("opus", "claude-opus-5-5");
		store.writeModel("haiku", "claude-haiku-4-5-20251001");
		expect(store.readModel("opus")).toBe("claude-opus-5-5");
		expect(store.readModel("haiku")).toBe("claude-haiku-4-5-20251001");
		expect(store.readModel("off")).toBeUndefined();
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

function harness(
	mode = "off",
	knownModels: Record<string, string> = {},
	probe?: (forMode: string) => Promise<string | undefined>,
) {
	let current = mode;
	const store = {
		readMode: () => current as never,
		writeMode: (next: string) => {
			current = next;
		},
		readClaudeSession: () => undefined,
		writeClaudeSession: () => undefined,
		clearClaudeSession: () => undefined,
		readModel: (forMode: string) => knownModels[forMode],
		writeModel: (forMode: string, modelId: string) => {
			knownModels[forMode] = modelId;
		},
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
		probe,
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

	it("resolves every alias version with /claude probe", async () => {
		const seen: string[] = [];
		const models = {
			haiku: "claude-haiku-4-5-20251001",
			sonnet: "claude-sonnet-5",
			opus: "claude-opus-5-5",
		};
		const h = harness("opus", {}, async (forMode) => {
			seen.push(forMode);
			return models[forMode as keyof typeof models];
		});
		await h.command("probe", h.uiCtx);
		expect(seen).toEqual(["haiku", "sonnet", "opus"]);
		const message = h.ui.notify.mock.calls.map((call) => String(call[0])).join("\n");
		expect(message).toContain("Haiku 4.5 (claude-haiku-4-5-20251001)");
		expect(message).toContain("Sonnet 5 (claude-sonnet-5)");
		expect(message).toContain("Opus 5.5 (claude-opus-5-5)");
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus 5.5");
	});

	it("keeps going when one alias probe fails", async () => {
		const h = harness("off", {}, async (forMode) => {
			if (forMode === "sonnet") throw new Error("no access");
			return "claude-haiku-4-5-20251001";
		});
		await h.command("versions", h.uiCtx);
		const message = h.ui.notify.mock.calls.map((call) => String(call[0])).join("\n");
		expect(message).toContain("Haiku 4.5");
		expect(message).toContain("Sonnet: failed (no access)");
	});

	it("shows the resolved version in the status label", async () => {
		const h = harness("opus", { opus: "claude-opus-5-5" });
		await h.command("report", h.uiCtx);
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus 5.5");
	});

	it("labels the menu entries with versions and still selects the mode", async () => {
		const h = harness("off", { opus: "claude-opus-5-5" });
		h.ui.select.mockImplementation(async (_title: string, options: string[]) =>
			options.find((option) => option.includes("Opus 5.5")),
		);
		await h.command("menu", h.uiCtx);
		expect(h.mode).toBe("opus");
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
		expect(outcome.models).toEqual([]);
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
