import { describe, expect, it, vi } from "vitest";
import {
	MIRROR_PROVIDER,
	PROMPT_MESSAGE_TYPE,
	parseCcArgs,
	parseCcControl,
	registerClaudeDelegate,
	restoreStickyMode,
	runClaudeTask,
	STICKY_ENTRY_TYPE,
} from "../extensions/claude-delegate/index.js";
import {
	buildClaudeSpawn,
	buildPrompt,
	DEFAULT_EFFORT,
	delegationLabel,
	FileDelegationStore,
	parseDelegationMode,
	parseEffortLevel,
	prettyModelName,
	progressTail,
	resolveEffort,
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

describe("effort levels", () => {
	it("defaults Opus and Sonnet to high, and leaves Haiku alone", () => {
		expect(DEFAULT_EFFORT.opus).toBe("high");
		expect(DEFAULT_EFFORT.sonnet).toBe("high");
		expect(DEFAULT_EFFORT.haiku).toBeUndefined();
		expect(DEFAULT_EFFORT.off).toBeUndefined();
	});

	it("resolves an override over the default", () => {
		expect(resolveEffort("opus")).toBe("high");
		expect(resolveEffort("sonnet", "auto")).toBe("high");
		expect(resolveEffort("opus", "xhigh")).toBe("xhigh");
		expect(resolveEffort("haiku", "high")).toBe("high");
		expect(resolveEffort("off", "max")).toBeUndefined();
	});

	it("parses level names and auto", () => {
		expect(parseEffortLevel("HIGH")).toBe("high");
		expect(parseEffortLevel("xhigh")).toBe("xhigh");
		expect(parseEffortLevel("auto")).toBe("auto");
		expect(parseEffortLevel("nonsense")).toBeUndefined();
	});

	it("passes --effort only when a level applies", () => {
		const withEffort = buildClaudeSpawn({ task: "t", mode: "opus", effort: "high" });
		expect(withEffort.args[withEffort.args.indexOf("--effort") + 1]).toBe("high");
		const withoutEffort = buildClaudeSpawn({ task: "t", mode: "haiku" });
		expect(withoutEffort.args).not.toContain("--effort");
	});

	it("shows effort in the status label", () => {
		expect(delegationLabel("opus", "claude-opus-5-5", "high")).toBe("Opus 5.5 · high");
		expect(delegationLabel("opus", "claude-opus-5-5")).toBe("Opus 5.5");
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

	it("stores per-mode effort overrides", () => {
		const base = `/tmp/claude-delegate-effort-${process.pid}`;
		const store = new FileDelegationStore(
			`${base}-mode`,
			`${base}-sessions.json`,
			`${base}-models.json`,
			`${base}-effort.json`,
		);
		expect(store.readEffort("opus")).toBeUndefined();
		expect(resolveEffort("opus", store.readEffort("opus"))).toBe("high");
		store.writeEffort("opus", "max");
		expect(resolveEffort("opus", store.readEffort("opus"))).toBe("max");
		store.writeEffort("opus", "auto");
		expect(resolveEffort("opus", store.readEffort("opus"))).toBe("high");
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

type CommandHandler = (args: string, ctx: unknown, ...rest: unknown[]) => Promise<void>;

function harness(
	mode = "off",
	knownModels: Record<string, string> = {},
	probe?: (forMode: string) => Promise<string | undefined>,
	runTask?: (
		args: string[],
		options?: { env: Record<string, string> },
	) => Promise<{
		resultText?: string;
		isError: boolean;
		claudeSessionId?: string;
		models: string[];
	}>,
	entries: Array<{ type: string; customType?: string; data?: unknown }> = [],
) {
	let current = mode;
	const sessions: Record<string, string> = {};
	const effortByMode: Record<string, string> = {};
	const store = {
		readMode: () => current as never,
		writeMode: (next: string) => {
			current = next;
		},
		readClaudeSession: (key: string) => sessions[key],
		writeClaudeSession: (key: string, id: string) => {
			sessions[key] = id;
		},
		clearClaudeSession: () => undefined,
		readModel: (forMode: string) => knownModels[forMode],
		writeModel: (forMode: string, modelId: string) => {
			knownModels[forMode] = modelId;
		},
		readEffort: (forMode: string) => effortByMode[forMode],
		writeEffort: (forMode: string, setting: string) => {
			effortByMode[forMode] = setting;
		},
	};
	const handlers: Record<string, CommandHandler> = {};
	let activeTools = ["read", "bash"];
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	let input: ((event: unknown, ctx: unknown) => { action: string }) | undefined;
	const notify = vi.fn();
	const setStatus = vi.fn();
	const sendMessage = vi.fn();
	const appendEntry = vi.fn((customType: string, data: unknown) => {
		entries.push({ type: "custom", customType, data });
	});
	const registered: Array<{ name: string; execute?: unknown }> = [];
	const delegate = registerClaudeDelegate(
		{
			registerCommand(name: string, options: { handler: CommandHandler }) {
				handlers[name] = options.handler;
			},
			registerTool(definition: { name: string; execute?: unknown }) {
				registered.push(definition);
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => void) {
				if (event === "session_start") sessionStart = handler;
				if (event === "input") input = handler as never;
			},
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
			sendMessage,
			appendEntry,
		} as never,
		store as never,
		"/tmp/claude-delegate-workspace",
		probe,
		runTask as never,
	);
	const ui = {
		notify,
		select: vi.fn(async (_title: string, options: string[]) => options[1]),
		setStatus,
	};
	const appendMessage = vi.fn();
	const uiCtx = {
		ui,
		sessionManager: { getSessionId: () => "chat-1", getEntries: () => entries, appendMessage },
	};
	return {
		get mode() {
			return current;
		},
		get activeTools() {
			return activeTools;
		},
		command: handlers.claude!,
		cc: handlers.cc!,
		sessionStart: () => sessionStart?.({}, uiCtx),
		input: (text: string, extra: Record<string, unknown> = {}) =>
			input?.({ type: "input", text, source: "rpc", ...extra }, uiCtx),
		whenIdle: () => delegate.whenIdle(),
		appendEntry,
		sessions,
		entries,
		registered,
		ui,
		uiCtx,
		sendMessage,
		appendMessage,
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
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus · high");
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
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus 5.5 · high");
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

	it("sets effort for the active mode and reports the default", async () => {
		const h = harness("opus", { opus: "claude-opus-5-5" });
		await h.command("effort", h.uiCtx);
		let message = h.ui.notify.mock.calls.map((call) => String(call[0])).join("\n");
		expect(message).toContain("Opus effort: high (default)");

		await h.command("effort xhigh", h.uiCtx);
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus 5.5 · xhigh");
		message = h.ui.notify.mock.calls.map((call) => String(call[0])).join("\n");
		expect(message).toContain("Opus effort set to xhigh");
	});

	it("rejects an unknown effort and requires a mode", async () => {
		const h = harness("sonnet");
		await h.command("effort turbo", h.uiCtx);
		expect(h.ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("Unknown effort"),
			"warning",
		);
		const off = harness("off");
		await off.command("effort high", off.uiCtx);
		expect(off.ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("Select a delegation mode"),
			"warning",
		);
	});

	it("parses /cc arguments with an optional model token", () => {
		expect(parseCcArgs("opus register an account")).toEqual({
			mode: "opus",
			task: "register an account",
		});
		expect(parseCcArgs("summarise the last 5 emails")).toEqual({
			task: "summarise the last 5 emails",
		});
		// A bare alias with no task is treated as the task, not a mode.
		expect(parseCcArgs("haiku")).toEqual({ task: "haiku" });
		// `off` is not a delegation mode.
		expect(parseCcArgs("off do something")).toEqual({ task: "off do something" });
	});

	it("sends a task straight to Claude Code with /cc", async () => {
		const seen: string[][] = [];
		const h = harness("sonnet", { sonnet: "claude-sonnet-5-5" }, undefined, async (args) => {
			seen.push(args);
			return {
				resultText: "registered ok",
				isError: false,
				claudeSessionId: "s-cc",
				models: ["claude-sonnet-5-5"],
			};
		});
		await h.cc("register an account at example.com", h.uiCtx);

		expect(seen).toHaveLength(1);
		expect(seen[0][seen[0].indexOf("--model") + 1]).toBe("sonnet");
		expect(seen[0][seen[0].indexOf("--effort") + 1]).toBe("high");
		expect(h.sendMessage).toHaveBeenCalledTimes(2);
		// The prompt is recorded first so it stays in the chat history.
		expect(h.sendMessage.mock.calls[0][0]).toMatchObject({
			customType: PROMPT_MESSAGE_TYPE,
			content: "register an account at example.com",
			display: true,
		});
		const message = h.sendMessage.mock.calls[1][0];
		// ACB only draws the "note" and "voice-reply" custom types.
		expect(message.customType).toBe("note");
		expect(message.display).toBe(true);
		expect(String(message.content)).toContain("registered ok");
		expect(String(message.content)).toContain("Sonnet 5.5");
	});

	it("honours the model prefix and refuses when delegation is off", async () => {
		const seen: string[][] = [];
		const h = harness("off", {}, undefined, async (args) => {
			seen.push(args);
			return { resultText: "ok", isError: false, models: ["claude-opus-5-5"] };
		});
		await h.cc("do a thing", h.uiCtx);
		expect(h.ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("Claude Code delegation is off"),
			"warning",
		);
		expect(seen).toHaveLength(0);

		await h.cc("opus do a thing", h.uiCtx);
		expect(seen).toHaveLength(1);
		expect(seen[0][seen[0].indexOf("--model") + 1]).toBe("opus");
	});

	it("reports a failed /cc run as an error but keeps the prompt", async () => {
		const h = harness("haiku", {}, undefined, async () => ({
			resultText: "captcha wall",
			isError: true,
			models: ["claude-haiku-4-5-20251001"],
		}));
		await h.cc("summarise inbox", h.uiCtx);
		expect(h.ui.notify).toHaveBeenLastCalledWith("captcha wall", "error");
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
		expect(h.sendMessage.mock.calls[0][0].customType).toBe(PROMPT_MESSAGE_TYPE);
	});

	it("keys Claude session continuity by the chat's own session id", async () => {
		const h = harness("sonnet", {}, undefined, async () => ({
			resultText: "ok",
			isError: false,
			claudeSessionId: "claude-s1",
			models: [],
		}));
		await h.cc("first", h.uiCtx);
		expect(h.sessions).toEqual({ "chat-1": "claude-s1" });
	});

	it("shows the resolved version in the status label", async () => {
		const h = harness("opus", { opus: "claude-opus-5-5" });
		await h.command("report", h.uiCtx);
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus 5.5 · high");
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

describe("claude-delegate sticky mode", () => {
	const ok = async () => ({ resultText: "done", isError: false, models: ["claude-opus-5-5"] });

	it("parses only the bare on/off/status controls", () => {
		expect(parseCcControl("on")).toEqual({ kind: "on" });
		expect(parseCcControl("ON opus")).toEqual({ kind: "on", mode: "opus" });
		expect(parseCcControl("off")).toEqual({ kind: "off" });
		expect(parseCcControl("status")).toEqual({ kind: "status" });
		// Longer text is an ordinary task, not a control.
		expect(parseCcControl("on Monday book a table")).toBeUndefined();
		expect(parseCcControl("off the top of your head")).toBeUndefined();
		expect(parseCcControl("on off")).toBeUndefined();
		expect(parseCcControl("on 1")).toBeUndefined();
	});

	it("restores the last sticky entry", () => {
		const entries = [
			{ type: "custom", customType: STICKY_ENTRY_TYPE, data: { mode: "opus" } },
			{ type: "custom", customType: STICKY_ENTRY_TYPE, data: { mode: "haiku" } },
		];
		expect(restoreStickyMode(entries)).toBe("haiku");
		entries.push({ type: "custom", customType: STICKY_ENTRY_TYPE, data: { mode: "off" } });
		expect(restoreStickyMode(entries)).toBeUndefined();
		expect(restoreStickyMode([])).toBeUndefined();
	});

	it("leaves ordinary messages with pi until /cc on", () => {
		const h = harness("opus", {}, undefined, ok);
		expect(h.input("hello")).toEqual({ action: "continue" });
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("diverts every typed message to Claude Code while on, and stops at /cc off", async () => {
		const seen: string[][] = [];
		const h = harness("off", { opus: "claude-opus-5-5" }, undefined, async (args) => {
			seen.push(args);
			return ok();
		});
		await h.cc("on opus", h.uiCtx);
		expect(h.appendEntry).toHaveBeenLastCalledWith(STICKY_ENTRY_TYPE, { mode: "opus" });
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Off");
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("claude-sticky", "Opus 5.5 · high");

		expect(h.input("check my inbox")).toEqual({ action: "handled" });
		expect(h.input("and reply to Sam")).toEqual({ action: "handled" });
		await h.whenIdle();
		expect(seen).toHaveLength(2);
		expect(seen[0][seen[0].indexOf("--model") + 1]).toBe("opus");
		expect(seen[1][1]).toContain("and reply to Sam");
		const types = h.sendMessage.mock.calls.map((call) => call[0].customType);
		expect(types).toEqual([PROMPT_MESSAGE_TYPE, PROMPT_MESSAGE_TYPE, "note", "note"]);

		await h.cc("off", h.uiCtx);
		expect(h.input("back to pi")).toEqual({ action: "continue" });
		expect(h.appendEntry).toHaveBeenLastCalledWith(STICKY_ENTRY_TYPE, { mode: "off" });
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("claude-sticky", undefined);
	});

	it("mirrors each reply as an assistant message so pi saves the chat", async () => {
		const h = harness("opus", {}, undefined, ok);
		await h.cc("on", h.uiCtx);
		expect(h.input("check my inbox")).toEqual({ action: "handled" });
		await h.whenIdle();
		expect(h.appendMessage).toHaveBeenCalledTimes(1);
		const mirrored = h.appendMessage.mock.calls[0][0];
		expect(mirrored).toMatchObject({
			role: "assistant",
			provider: MIRROR_PROVIDER,
			model: "claude-opus-5-5",
			stopReason: "stop",
		});
		expect(mirrored.content[0].text).toContain("done");
	});

	it("mirrors a failed run too, so the chat still saves", async () => {
		const h = harness("opus", {}, undefined, async () => ({
			isError: true,
			resultText: "boom",
			models: [],
		}));
		await h.cc("on", h.uiCtx);
		h.input("try this");
		await h.whenIdle();
		expect(h.appendMessage.mock.calls[0][0].content[0].text).toBe("⚠ boom");
	});

	it("uses the global model for a bare /cc on, falling back to Sonnet", async () => {
		const h = harness("haiku", {}, undefined, ok);
		await h.cc("on", h.uiCtx);
		expect(h.appendEntry).toHaveBeenLastCalledWith(STICKY_ENTRY_TYPE, { mode: "haiku" });
		const off = harness("off", {}, undefined, ok);
		await off.cc("on", off.uiCtx);
		expect(off.appendEntry).toHaveBeenLastCalledWith(STICKY_ENTRY_TYPE, { mode: "sonnet" });
	});

	it("passes extension prompts, slash input and steering through to pi", async () => {
		const h = harness("opus", {}, undefined, ok);
		await h.cc("on", h.uiCtx);
		expect(h.input("hi", { source: "extension" })).toEqual({ action: "continue" });
		expect(h.input("/skill:foo")).toEqual({ action: "continue" });
		expect(h.input("wait", { streamingBehavior: "steer" })).toEqual({ action: "continue" });
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("restores sticky mode for the chat on session start", async () => {
		const h = harness("off", {}, undefined, ok, [
			{ type: "custom", customType: STICKY_ENTRY_TYPE, data: { mode: "sonnet" } },
		]);
		h.sessionStart();
		expect(h.input("hello")).toEqual({ action: "handled" });
		await h.whenIdle();
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
