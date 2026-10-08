import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	ACTIVITY_STATUS_KEY,
	formatElapsed,
	MAX_RUN_MS,
	MIRROR_PROVIDER,
	mirrorReplyToSession,
	PROMPT_MESSAGE_TYPE,
	parseCcArgs,
	parseCcControl,
	registerClaudeDelegate,
	restoreStickyMode,
	runClaudeTask,
	STICKY_ENTRY_TYPE,
	SteerChannel,
	usageSummary,
} from "../extensions/claude-delegate/index.js";
import {
	buildClaudeSpawn,
	buildPrompt,
	DEFAULT_EFFORT,
	parseEffort,
	delegationLabel,
	descendantsOf,
	FileDelegationStore,
	normaliseToolArgs,
	parseDelegationMode,
	prettyModelName,
	RunRegistry,
	processStartTicks,
	saveAttachedImages,
	type StreamEvent,
	StreamParser,
	withImagePaths,
} from "../extensions/claude-delegate/lib.js";
import { buildCatchUp, foldClaudeSteps } from "../extensions/claude-delegate/transcript.js";

describe("claude-delegate mode parsing", () => {
	it("accepts only the three model names", () => {
		expect(parseDelegationMode("opus")).toBe("opus");
		expect(parseDelegationMode("SONNET")).toBe("sonnet");
		expect(parseDelegationMode("haiku")).toBe("haiku");
		expect(parseDelegationMode("off")).toBeUndefined();
		expect(parseDelegationMode("on")).toBeUndefined();
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
		expect(plan.args[plan.args.indexOf("--thinking-display") + 1]).toBe("summarized");
		// The prompt goes in on stdin so follow-ups can join the live run.
		expect(plan.args[plan.args.indexOf("--input-format") + 1]).toBe("stream-json");
		expect(plan.args).toContain("--replay-user-messages");
		expect(plan.args.join(" ")).not.toContain("do a thing");
		expect(plan.prompt).toContain("do a thing");
		expect(plan.prompt).toContain("/home/lepton/AGENTS.md");
		expect(plan.prompt).not.toContain("~/.secrets");
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
			{ kind: "result", text: "done", isError: false },
		]);
	});

	it("reports the model from init and assistant events", () => {
		const parser = new StreamParser();
		const events = parser.feed(
			[
				'{"type":"system","subtype":"init","session_id":"s-2","model":"claude-opus-5-5"}',
				'{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}]}}',
				"",
			].join("\n"),
		);
		expect(events[0]).toEqual({ kind: "init", claudeSessionId: "s-2", model: "claude-opus-5-5" });
		expect(events[1]).toEqual({ kind: "text", text: "hi", model: "claude-opus-5-5" });
	});

	it("parses thinking, tool calls and tool results", () => {
		const parser = new StreamParser();
		const events = parser.feed(
			[
				'{"type":"assistant","message":{"model":"m","content":[{"type":"thinking","thinking":"plan it"}]}}',
				'{"type":"assistant","message":{"model":"m","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
				'{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"a.txt"}],"is_error":false}]}}',
				"",
			].join("\n"),
		);
		expect(events).toEqual([
			{ kind: "thinking", text: "plan it" },
			{ kind: "text", text: "", model: "m" },
			{ kind: "text", text: "", model: "m" },
			{ kind: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
			{ kind: "tool_result", id: "t1", text: "a.txt", isError: false },
		]);
	});

	it("reports replayed stdin prompts, not tool results, as prompt events", () => {
		const parser = new StreamParser();
		const events = parser.feed(
			[
				JSON.stringify({ type: "user", message: { content: "also do X" }, isReplay: true }),
				JSON.stringify({
					type: "user",
					message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
				}),
				"",
			].join("\n"),
		);
		expect(events).toEqual([
			{ kind: "prompt", text: "also do X" },
			{ kind: "tool_result", id: "t", text: "ok", isError: false },
		]);
	});

	it("ignores non-JSON noise", () => {
		const parser = new StreamParser();
		expect(parser.feed("not json at all\n")).toEqual([]);
	});
});

describe("model version labels", () => {
	it("prettifies wire model ids", () => {
		expect(prettyModelName("claude-opus-5-5")).toBe("Opus 5.5");
		expect(prettyModelName("claude-haiku-5-5")).toBe("Haiku 5.5");
		expect(prettyModelName("claude-sonnet-5")).toBe("Sonnet 5");
		expect(prettyModelName("claude-fable-5-1")).toBe("Fable 5.1");
	});

	it("labels a mode with its resolved version", () => {
		expect(delegationLabel("opus")).toBe("Opus");
		expect(delegationLabel("opus", "claude-opus-5-5")).toBe("Opus 5.5");
		expect(delegationLabel("haiku", "claude-haiku-5-5")).toBe("Haiku 5.5");
		// A cross-family alias still names both halves.
		expect(delegationLabel("opus", "claude-fable-5-1")).toBe("Opus (Fable 5.1)");
	});
});

describe("effort levels", () => {
	it("defaults to high", () => {
		expect(DEFAULT_EFFORT).toBe("high");
	});

	it("passes --effort only when a level is given", () => {
		const withEffort = buildClaudeSpawn({ task: "t", mode: "opus", effort: "xhigh" });
		expect(withEffort.args[withEffort.args.indexOf("--effort") + 1]).toBe("xhigh");
		const withoutEffort = buildClaudeSpawn({ task: "t", mode: "opus" });
		expect(withoutEffort.args).not.toContain("--effort");
	});

	it("runs Haiku on the pinned 5.5 id and the others on their aliases", () => {
		const model = (mode: "opus" | "sonnet" | "haiku") => {
			const { args } = buildClaudeSpawn({ task: "t", mode });
			return args[args.indexOf("--model") + 1];
		};
		expect(model("haiku")).toBe("claude-haiku-5-5");
		expect(model("opus")).toBe("opus");
		expect(model("sonnet")).toBe("sonnet");
	});

	it("parses effort levels", () => {
		expect(parseEffort(" Max ")).toBe("max");
		expect(parseEffort("ultra")).toBeUndefined();
	});

	it("shows effort in the status label", () => {
		expect(delegationLabel("opus", "claude-opus-5-5", "high")).toBe("Opus 5.5 · high");
		expect(delegationLabel("opus", "claude-opus-5-5")).toBe("Opus 5.5");
	});
});

function tmpStore() {
	const dir = mkdtempSync(join(tmpdir(), "claude-delegate-store-"));
	const legacy = join(dir, "legacy.json");
	return {
		dir,
		legacy,
		store: new FileDelegationStore(
			join(dir, "mode"),
			join(dir, "sessions"),
			join(dir, "models"),
			legacy,
		),
	};
}

describe("claude-delegate store", () => {
	it("round-trips mode and session mapping", () => {
		const { store } = tmpStore();
		expect(store.readMode()).toBe("sonnet");
		store.writeMode("haiku");
		expect(store.readMode()).toBe("haiku");
		store.writeClaudeSession("chat-1", "s-42");
		expect(store.readClaudeSession("chat-1")).toBe("s-42");
		store.clearClaudeSession("chat-1");
		expect(store.readClaudeSession("chat-1")).toBeUndefined();
	});

	it("remembers the resolved model per mode", () => {
		const { store } = tmpStore();
		expect(store.readModel("opus")).toBeUndefined();
		store.writeModel("opus", "claude-opus-5-5");
		store.writeModel("haiku", "claude-haiku-5-5");
		expect(store.readModel("opus")).toBe("claude-opus-5-5");
		expect(store.readModel("haiku")).toBe("claude-haiku-5-5");
	});

	it("keeps each chat in its own file so chats cannot overwrite each other", () => {
		const { store, dir } = tmpStore();
		// Two store instances stand in for two pi processes finishing together.
		const other = new FileDelegationStore(
			join(dir, "mode"),
			join(dir, "sessions"),
			join(dir, "models"),
			undefined,
		);
		store.writeClaudeSession("chat-a", "s-a");
		other.writeClaudeSession("chat-b", "s-b");
		store.writeClaudeSession("chat-c", "s-c");
		expect(readdirSync(join(dir, "sessions")).sort()).toEqual([
			"chat-a.json",
			"chat-b.json",
			"chat-c.json",
		]);
		expect(other.readClaudeSession("chat-a")).toBe("s-a");
		expect(store.readClaudeSession("chat-b")).toBe("s-b");
	});

	it("keeps chats whose ids clean up to the same name in separate files", () => {
		const { store, dir } = tmpStore();
		store.writeClaudeSession("chat/1", "s-slash");
		store.writeClaudeSession("chat 1", "s-space");
		store.writeClaudeSession("chat_1", "s-plain");
		expect(store.readClaudeSession("chat/1")).toBe("s-slash");
		expect(store.readClaudeSession("chat 1")).toBe("s-space");
		expect(store.readClaudeSession("chat_1")).toBe("s-plain");
		expect(readdirSync(join(dir, "sessions"))).toHaveLength(3);
		expect(readdirSync(join(dir, "sessions"))).toContain("chat_1.json");
	});

	it("pins a chat's model per conversation and resets it for a new one", () => {
		const { store } = tmpStore();
		store.writeClaudeSession("chat-1", "s-1", { mode: "opus", model: "claude-opus-5-5" });
		expect(store.readPinnedModel("chat-1", "opus")).toBe("claude-opus-5-5");
		expect(store.readPinnedModel("chat-1", "sonnet")).toBeUndefined();
		// The same conversation keeps its pins when another mode is added.
		store.writeClaudeSession("chat-1", "s-1", { mode: "sonnet", model: "claude-sonnet-5-5" });
		expect(store.readPinnedModel("chat-1", "opus")).toBe("claude-opus-5-5");
		// A new conversation starts unpinned.
		store.writeClaudeSession("chat-1", "s-2");
		expect(store.readPinnedModel("chat-1", "opus")).toBeUndefined();
	});

	it("falls back to the old single-file map until a chat is cleared", () => {
		const { store, legacy } = tmpStore();
		writeFileSync(
			legacy,
			JSON.stringify({ "old-chat": { claudeSessionId: "s-old", updatedAt: "2026-01-01" } }),
		);
		expect(store.readClaudeSession("old-chat")).toBe("s-old");
		store.clearClaudeSession("old-chat");
		expect(store.readClaudeSession("old-chat")).toBeUndefined();
		store.writeClaudeSession("old-chat", "s-new");
		expect(store.readClaudeSession("old-chat")).toBe("s-new");
	});

	it("keeps odd chat keys inside the sessions directory", () => {
		const { store, dir } = tmpStore();
		store.writeClaudeSession("../../escape", "s-x");
		expect(readdirSync(join(dir, "sessions"))).toHaveLength(1);
		expect(store.readClaudeSession("../../escape")).toBe("s-x");
	});
});

describe("delegated prompt", () => {
	it("applies the ACB assistant's rules and adds only Claude Code facts", () => {
		const prompt = buildPrompt("register an account");
		expect(prompt).toContain("register an account");
		expect(prompt).toContain("/home/lepton/agentchatbox/AGENTS.md");
		expect(prompt).not.toContain("Never read, copy, or transmit");
		expect(prompt).toContain("/home/lepton/agentchatbox/uploads/");
		expect(prompt).toContain("never Anthropic's built-in browser/computer-use skills");
	});
});

type CommandHandler = (args: string, ctx: unknown, ...rest: unknown[]) => Promise<void>;

function harness(
	mode = "sonnet",
	knownModels: Record<string, string> = {},
	runTask?: (args: string[]) => Promise<{
		resultText?: string;
		isError: boolean;
		claudeSessionId?: string;
		model?: string;
	}>,
	entries: Array<{ type: string; customType?: string; data?: unknown }> = [],
	options: { maxRunMs?: number; branch?: unknown[] } = {},
) {
	let current = mode;
	const sessions: Record<string, string> = {};
	const pins: Record<string, string> = {};
	const efforts: Record<string, string> = {};
	const store = {
		readMode: () => current as never,
		writeMode: (next: string) => {
			current = next;
		},
		readClaudeSession: (key: string) => sessions[key],
		writeClaudeSession: (key: string, id: string, pin?: { mode: string; model: string }) => {
			sessions[key] = id;
			if (pin) pins[`${key}:${pin.mode}`] = pin.model;
		},
		clearClaudeSession: (key: string) => {
			delete sessions[key];
		},
		readPinnedModel: (key: string, forMode: string) => pins[`${key}:${forMode}`],
		readModel: (forMode: string) => knownModels[forMode],
		writeModel: (forMode: string, modelId: string) => {
			knownModels[forMode] = modelId;
		},
		readEffort: (forMode: string) => efforts[forMode] ?? "high",
		writeEffort: (forMode: string, level: string) => {
			efforts[forMode] = level;
		},
	};
	const handlers: Record<string, CommandHandler> = {};
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	let input: ((event: unknown, ctx: unknown) => { action: string }) | undefined;
	let shutdown: (() => void) | undefined;
	let context: ((event: { messages: unknown[] }) => { messages: unknown[] }) | undefined;
	const runsDir = mkdtempSync(join(tmpdir(), "claude-delegate-runs-"));
	// Every pid counts as a live Claude Code here; the stand-in runs have no real process.
	const registry = new RunRegistry(runsDir, () => true);
	const notify = vi.fn();
	const setStatus = vi.fn();
	const sendMessage = vi.fn();
	const appendEntry = vi.fn((customType: string, data: unknown) => {
		entries.push({ type: "custom", customType, data });
	});
	const delegate = registerClaudeDelegate(
		{
			registerCommand(name: string, options: { handler: CommandHandler }) {
				handlers[name] = options.handler;
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => void) {
				if (event === "session_start") sessionStart = handler;
				if (event === "input") input = handler as never;
				if (event === "session_shutdown") shutdown = handler as never;
				if (event === "context") context = handler as never;
			},
			sendMessage,
			appendEntry,
		} as never,
		store as never,
		"/tmp/claude-delegate-workspace",
		runTask as never,
		registry,
		options.maxRunMs,
	);
	const ui = {
		notify,
		select: vi.fn(async (_title: string, options: string[]) => options[1]),
		setStatus,
	};
	const appendMessage = vi.fn();
	const uiCtx = {
		ui,
		sessionManager: {
			getSessionId: () => "chat-1",
			getEntries: () => entries,
			getBranch: () => options.branch ?? [],
			getSessionFile: () => "/tmp/chat-1.jsonl",
			appendMessage,
		},
	};
	return {
		get mode() {
			return current;
		},
		command: handlers.claude!,
		cc: handlers.cc!,
		sessionStart: () => sessionStart?.({}, uiCtx),
		input: (text: string, extra: Record<string, unknown> = {}) =>
			input?.({ type: "input", text, source: "rpc", ...extra }, uiCtx),
		whenIdle: () => delegate.whenIdle(),
		shutdown: () => shutdown?.(),
		context: (messages: unknown[]) => context?.({ messages }),
		registry,
		runsDir,
		appendEntry,
		sessions,
		pins,
		efforts,
		entries,
		ui,
		uiCtx,
		sendMessage,
		appendMessage,
	};
}

describe("claude-delegate registration", () => {
	it("reports the default model label, with its version once known", async () => {
		const h = harness("opus", { opus: "claude-opus-5-5" });
		h.sessionStart();
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus 5.5 · high");
	});

	it("sets the default model with /claude", async () => {
		const h = harness("sonnet");
		await h.command("opus", h.uiCtx);
		expect(h.mode).toBe("opus");
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus · high");
		await h.command("off", h.uiCtx);
		expect(h.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage"), "warning");
		expect(h.mode).toBe("opus");
	});

	it("labels the menu entries with versions and still selects the model", async () => {
		const h = harness("sonnet", { opus: "claude-opus-5-5" });
		h.ui.select.mockImplementation(async (_title: string, options: string[]) =>
			options.find((option) => option.includes("Opus 5.5")),
		);
		await h.command("menu", h.uiCtx);
		expect(h.mode).toBe("opus");
	});

	it("follows the model pick with an effort pick for that model", async () => {
		const h = harness("sonnet", { opus: "claude-opus-5-5" });
		h.ui.select.mockImplementation(async (title: string, options: string[]) =>
			title.startsWith("Effort")
				? options.find((option) => option.endsWith("xhigh"))
				: options.find((option) => option.includes("Opus 5.5")),
		);
		await h.command("menu", h.uiCtx);
		expect(h.ui.select).toHaveBeenLastCalledWith("Effort for Opus", [
			"low",
			"medium",
			"✓ high",
			"xhigh",
			"max",
		]);
		expect(h.efforts.opus).toBe("xhigh");
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("claude-sticky", undefined);
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Opus 5.5 · xhigh");
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
		// `off` is not a model.
		expect(parseCcArgs("off do something")).toEqual({ task: "off do something" });
	});

	it("sends a task straight to Claude Code with /cc", async () => {
		const seen: string[][] = [];
		const h = harness("sonnet", { sonnet: "claude-sonnet-5-5" }, async (args) => {
			seen.push(args);
			return {
				resultText: "registered ok",
				isError: false,
				claudeSessionId: "s-cc",
				model: "claude-sonnet-5-5",
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

	it("uses the default model unless the task names one", async () => {
		const seen: string[][] = [];
		const h = harness("haiku", {}, async (args) => {
			seen.push(args);
			return { resultText: "ok", isError: false, model: "claude-opus-5-5" };
		});
		await h.cc("do a thing", h.uiCtx);
		expect(seen[0][seen[0].indexOf("--model") + 1]).toBe("claude-haiku-5-5");
		await h.cc("opus do a thing", h.uiCtx);
		expect(seen[1][seen[1].indexOf("--model") + 1]).toBe("opus");
	});

	it("reports a failed /cc run as an error but keeps the prompt", async () => {
		const h = harness("haiku", {}, async () => ({
			resultText: "captcha wall",
			isError: true,
			model: "claude-haiku-5-5",
		}));
		await h.cc("summarise inbox", h.uiCtx);
		expect(h.ui.notify).toHaveBeenLastCalledWith("captcha wall", "error");
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
		expect(h.sendMessage.mock.calls[0][0].customType).toBe(PROMPT_MESSAGE_TYPE);
	});

	it("keys Claude session continuity by the chat's own session id", async () => {
		const h = harness("sonnet", {}, async () => ({
			resultText: "ok",
			isError: false,
			claudeSessionId: "claude-s1",
		}));
		await h.cc("first", h.uiCtx);
		expect(h.sessions).toEqual({ "chat-1": "claude-s1" });
	});
});

describe("claude-delegate sticky mode", () => {
	const ok = async () => ({ resultText: "done", isError: false, model: "claude-opus-5-5" });

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
		const h = harness("opus", {}, ok);
		expect(h.input("hello")).toEqual({ action: "continue" });
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("diverts every typed message to Claude Code while on, and stops at /cc off", async () => {
		const seen: string[][] = [];
		const prompts: string[] = [];
		const h = harness("sonnet", { opus: "claude-opus-5-5" }, (async (
			args: string[],
			options: { prompt: string },
		) => {
			seen.push(args);
			prompts.push(options.prompt);
			return ok();
		}) as never);
		await h.cc("on opus", h.uiCtx);
		expect(h.appendEntry).toHaveBeenLastCalledWith(STICKY_ENTRY_TYPE, { mode: "opus" });
		expect(h.ui.setStatus).toHaveBeenCalledWith("claude-delegate", "Sonnet · high");
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("claude-sticky", "Opus 5.5 · high");

		expect(h.input("check my inbox")).toEqual({ action: "handled" });
		expect(h.input("and reply to Sam")).toEqual({ action: "handled" });
		await h.whenIdle();
		expect(seen).toHaveLength(2);
		expect(seen[0][seen[0].indexOf("--model") + 1]).toBe("opus");
		expect(prompts[1]).toContain("and reply to Sam");
		const types = h.sendMessage.mock.calls.map((call) => call[0].customType);
		expect(types).toEqual([PROMPT_MESSAGE_TYPE, PROMPT_MESSAGE_TYPE, "note", "note"]);

		await h.cc("off", h.uiCtx);
		expect(h.input("back to pi")).toEqual({ action: "continue" });
		expect(h.appendEntry).toHaveBeenLastCalledWith(STICKY_ENTRY_TYPE, { mode: "off" });
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("claude-sticky", undefined);
	});

	it("mirrors each reply as an assistant message so pi saves the chat", async () => {
		const h = harness("opus", {}, ok);
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

	it("shows and saves Claude Code's thinking and tool calls like any model", async () => {
		type Run = (
			args: string[],
			options?: { onEvent?: (event: StreamEvent) => void },
		) => Promise<{
			resultText?: string;
			isError: boolean;
			model?: string;
		}>;
		const run: Run = async (_args, options) => {
			for (const event of [
				{ kind: "init", claudeSessionId: "s", model: "claude-opus-5-5" },
				{ kind: "thinking", text: "look first" },
				{ kind: "tool_use", id: "t1", name: "Read", input: { file_path: "/x/y.ts" } },
				{ kind: "tool_result", id: "t1", text: "contents", isError: false },
				{ kind: "thinking", text: "now answer" },
				{ kind: "text", text: "done", model: "claude-opus-5-5" },
			] as StreamEvent[]) {
				options?.onEvent?.(event);
			}
			return { resultText: "done", isError: false, model: "claude-opus-5-5" };
		};
		const h = harness("opus", {}, run as never);
		await h.cc("on", h.uiCtx);
		h.input("read it");
		await h.whenIdle();

		const saved = h.appendMessage.mock.calls.map((call) => call[0]);
		expect(saved.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
		expect(saved[0].stopReason).toBe("toolUse");
		expect(saved[0].content.map((b: { type: string }) => b.type)).toEqual(["thinking", "toolCall"]);
		expect(saved[0].content[1].arguments).toMatchObject({ path: "/x/y.ts" });
		expect(saved[1]).toMatchObject({ toolCallId: "t1", toolName: "Read", isError: false });
		expect(saved[2].content.map((b: { type: string }) => b.type)).toEqual(["thinking", "text"]);

		const live = h.ui.setStatus.mock.calls
			.filter(([key]: [string]) => key === ACTIVITY_STATUS_KEY)
			.map(([, text]: [string, string]) => JSON.parse(text));
		expect(live.map((p: { t: string }) => p.t)).toEqual([
			"thinking",
			"tool",
			"tool_end",
			"thinking",
		]);
		expect(live[2]).toMatchObject({ id: "t1", text: "contents", saved: 2 });

		const progress = h.ui.setStatus.mock.calls.filter(
			([key]: [string]) => key === "claude-progress",
		);
		expect(progress[0][1]).toMatch(/^Opus .* · working · 0s$/);
		expect(
			progress.some(([, text]: [string, string | undefined]) => text?.includes("Read: /x/y.ts")),
		).toBe(true);
		expect(progress.at(-1)?.[1]).toBeUndefined();
	});

	it("adds a follow-up to the live run instead of queueing a new one", async () => {
		const seen: string[][] = [];
		const written: string[] = [];
		let finish: () => void = () => {};
		type Run = (
			args: string[],
			options: {
				prompt: string;
				channel?: SteerChannel;
				onEvent?: (event: StreamEvent) => void;
			},
		) => Promise<{ resultText?: string; isError: boolean; model?: string }>;
		const run: Run = (args, options) => {
			seen.push(args);
			const channel = options.channel!;
			channel.attach(
				(line) => written.push(JSON.parse(line).message.content),
				() => {},
			);
			// As runClaudeTask does, the first prompt goes in on the channel.
			channel.send(options.prompt);
			options.onEvent?.({ kind: "init", claudeSessionId: "s", model: "claude-opus-5-5" });
			return new Promise((resolve) => {
				finish = () => {
					for (let i = 0; i < channel.sent; i += 1) {
						options.onEvent?.({ kind: "prompt", text: written[i] });
						channel.consumed += 1;
					}
					options.onEvent?.({ kind: "result", text: "both done", isError: false });
					channel.turnEnded();
					resolve({ resultText: "both done", isError: false, model: "claude-opus-5-5" });
				};
			});
		};
		const h = harness("opus", {}, run as never);
		await h.cc("on", h.uiCtx);
		h.input("check my inbox");
		await Promise.resolve();
		await Promise.resolve();
		expect(h.input("and reply to Sam")).toEqual({ action: "handled" });
		expect(written.at(-1)).toBe("and reply to Sam");
		const queued = h.ui.setStatus.mock.calls.filter(([key]: [string]) => key === "claude-progress");
		expect(queued.some(([, text]: [string, string]) => text?.includes("⟳ 1 queued"))).toBe(true);
		finish();
		await h.whenIdle();

		// One Claude Code run, both prompts in the chat, one reply for the turn.
		expect(seen).toHaveLength(1);
		const types = h.sendMessage.mock.calls.map((call) => call[0].customType);
		expect(types).toEqual([PROMPT_MESSAGE_TYPE, PROMPT_MESSAGE_TYPE, "note"]);
		expect(String(h.sendMessage.mock.calls[2][0].content)).toContain("both done");

		// Once the run has ended, the next message starts a fresh (resumed) run.
		h.input("thanks, one more thing");
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toHaveLength(2);
		finish();
		await h.whenIdle();
	});

	it("mirrors a failed run too, so the chat still saves", async () => {
		const h = harness("opus", {}, async () => ({
			isError: true,
			resultText: "boom",
		}));
		await h.cc("on", h.uiCtx);
		h.input("try this");
		await h.whenIdle();
		expect(h.appendMessage.mock.calls[0][0].content[0].text).toBe("⚠ boom");
	});

	it("uses the default model for a bare /cc on", async () => {
		const h = harness("haiku", {}, ok);
		await h.cc("on", h.uiCtx);
		expect(h.appendEntry).toHaveBeenLastCalledWith(STICKY_ENTRY_TYPE, { mode: "haiku" });
	});

	it("passes extension prompts, slash input and steering through to pi", async () => {
		const h = harness("opus", {}, ok);
		await h.cc("on", h.uiCtx);
		expect(h.input("hi", { source: "extension" })).toEqual({ action: "continue" });
		expect(h.input("/skill:foo")).toEqual({ action: "continue" });
		expect(h.input("wait", { streamingBehavior: "steer" })).toEqual({ action: "continue" });
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("restores sticky mode for the chat on session start", async () => {
		const h = harness("sonnet", {}, ok, [
			{ type: "custom", customType: STICKY_ENTRY_TYPE, data: { mode: "sonnet" } },
		]);
		h.sessionStart();
		expect(h.input("hello")).toEqual({ action: "handled" });
		await h.whenIdle();
	});
});

describe("attached images reaching Claude Code", () => {
	// A 1x1 PNG: the bytes only have to be real enough to name by hash.
	const PNG_1PX =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
	const image = (mimeType = "image/png", data = PNG_1PX) => ({ type: "image", data, mimeType });

	/** Run a test with ACB_UPLOADS_DIR pointed at a throwaway directory. */
	const withUploadsDir =
		(run: (dir: string) => void | Promise<void>) =>
		async (): Promise<void> => {
			const dir = mkdtempSync(join(tmpdir(), "claude-delegate-uploads-"));
			const previous = process.env.ACB_UPLOADS_DIR;
			process.env.ACB_UPLOADS_DIR = dir;
			try {
				await run(dir);
			} finally {
				if (previous === undefined) delete process.env.ACB_UPLOADS_DIR;
				else process.env.ACB_UPLOADS_DIR = previous;
			}
		};

	it(
		"saves an attached image once, under a content-addressed private name",
		withUploadsDir((dir) => {
			const [path] = saveAttachedImages([image()]);
			expect(path).toBeDefined();
			expect(dirname(path as string)).toBe(dir);
			expect(path).toMatch(/prompt-[0-9a-f]{16}\.png$/);
			expect(statSync(path as string).mode & 0o777).toBe(0o600);
			// The same picture sent twice is stored once and named the same way.
			expect(saveAttachedImages([image(), image()])).toEqual([path, path]);
			expect(readdirSync(dir)).toHaveLength(1);
		}),
	);

	it(
		"skips a format Claude Code cannot open, and says how many were missed",
		withUploadsDir((dir) => {
			// HEIC files start with an "ftyp" box, not a format Claude Code can read.
			const heic = Buffer.from("0000001c667479706865696300000000", "hex").toString("base64");
			expect(saveAttachedImages([image("image/heic", heic)])).toEqual([]);
			expect(readdirSync(dir)).toEqual([]);
			expect(withImagePaths("look at this", [], 1)).toContain(
				"(1 attached image could not be passed on.)",
			);
		}),
	);

	it(
		"names the file from its own bytes, not the type the browser claimed",
		withUploadsDir((dir) => {
			// Real PNG bytes labelled as a JPEG are still stored as a PNG.
			const [relabelled] = saveAttachedImages([image("image/jpeg")]);
			expect(relabelled).toMatch(/\.png$/);
			// A page labelled as a PNG is not an image and is not stored.
			const html = Buffer.from("<html><script>alert(1)</script>").toString("base64");
			expect(saveAttachedImages([image("image/png", html)])).toEqual([]);
			expect(readdirSync(dir)).toHaveLength(1);
		}),
	);

	it("leaves a task with no images exactly as it was", () => {
		expect(withImagePaths("check the invoice", [], 0)).toBe("check the invoice");
	});

	it("names every saved image in the task, for the Read tool", () => {
		const task = withImagePaths("what is wrong here?", ["/tmp/a.png", "/tmp/b.jpg"], 2);
		expect(task).toContain("what is wrong here?");
		expect(task).toContain("- /tmp/a.png");
		expect(task).toContain("- /tmp/b.jpg");
	});

	it(
		"passes a pasted image's path on to Claude Code",
		withUploadsDir(async (dir) => {
			const prompts: string[] = [];
			const h = harness("sonnet", {}, (async (
				_args: string[],
				options: { prompt: string },
			) => {
				prompts.push(options.prompt);
				return { resultText: "the button is cut off", isError: false, model: "claude-sonnet-5-5" };
			}) as never);
			await h.cc("on", h.uiCtx);
			// ACB sends the bytes and leaves only a bare label in the text.
			expect(
				h.input("what is wrong in this screenshot?", {
					images: [image()],
				}),
			).toEqual({ action: "handled" });
			await h.whenIdle();

			const [saved] = readdirSync(dir);
			expect(saved).toBeDefined();
			expect(prompts[0]).toContain("what is wrong in this screenshot?");
			expect(prompts[0]).toContain(join(dir, saved as string));
			// The prompt bubble ACB draws carries the same path.
			expect(String(h.sendMessage.mock.calls[0][0].content)).toContain(join(dir, saved as string));
		}),
	);
});

describe("tool display helpers", () => {
	it("mirrors file_path to path and caps long strings", () => {
		const args = normaliseToolArgs({ file_path: "/a/b.ts", content: "x".repeat(50) }, 10);
		expect(args.path).toBe("/a/b.ts");
		expect(args.content).toBe(`${"x".repeat(10)}… [40 more characters]`);
		expect(normaliseToolArgs(undefined)).toEqual({});
	});

	it("formats elapsed time compactly", () => {
		expect(formatElapsed(45_000)).toBe("45s");
		expect(formatElapsed(192_000)).toBe("3m12s");
		expect(formatElapsed(3_900_000)).toBe("1h05m");
	});
});

describe("SteerChannel", () => {
	it("closes stdin only when a turn ends with every follow-up taken in", () => {
		const end = vi.fn();
		const lines: string[] = [];
		const channel = new SteerChannel();
		expect(channel.send("too early")).toBe(false);
		channel.attach((line) => lines.push(line), end);
		expect(channel.send("first")).toBe(true);
		expect(channel.send("second")).toBe(true);
		expect(channel.queuedFollowUps).toBe(1);
		expect(JSON.parse(lines[1])).toEqual({
			type: "user",
			message: { role: "user", content: "second" },
		});
		channel.consumed = 1;
		channel.turnEnded();
		expect(end).not.toHaveBeenCalled();
		channel.consumed = 2;
		channel.turnEnded();
		expect(end).toHaveBeenCalledTimes(1);
		expect(channel.send("late")).toBe(false);
	});
});

describe("runClaudeTask", () => {
	it("sets no timer of its own; the caller's signal is the only stop", async () => {
		const spy = vi.spyOn(globalThis, "setTimeout");
		try {
			await runClaudeTask(["-e", "process.exit(0)"], {
				cwd: process.cwd(),
				env: {},
				bin: process.execPath,
			});
			expect(spy.mock.calls.filter(([, delay]) => (delay ?? 0) >= 60_000)).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	it("reports every parsed event through onEvent", async () => {
		const script = [
			'process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",id:"t",name:"Read",input:{}}]}})+"\\n");',
			'process.stdout.write(JSON.stringify({type:"result",result:"ok",is_error:false})+"\\n");',
		].join("\n");
		const kinds: string[] = [];
		await runClaudeTask(["-e", script], {
			cwd: process.cwd(),
			env: {},
			bin: process.execPath,
			onEvent: (event) => kinds.push(event.kind),
		});
		expect(kinds).toEqual(["tool_use", "result"]);
	});

	it("returns the final result and session id", async () => {
		const script = [
			'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"s-9"})+"\\n");',
			'process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"step one"}]}})+"\\n");',
			'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"all done",is_error:false})+"\\n");',
		].join("\n");
		const outcome = await runClaudeTask(["-e", script], {
			cwd: process.cwd(),
			env: {},
			bin: process.execPath,
		});
		expect(outcome.claudeSessionId).toBe("s-9");
		expect(outcome.resultText).toBe("all done");
		expect(outcome.isError).toBe(false);
		expect(outcome.model).toBeUndefined();
	});

	it("writes the prompt to stdin and ends it after an idle turn", async () => {
		// Stub: echo each stdin message back as a replay, then a result.
		const script = [
			'let buf="";process.stdin.on("data",d=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){',
			"const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);",
			'process.stdout.write(JSON.stringify({type:"user",isReplay:true,message:m.message})+"\\n");',
			'process.stdout.write(JSON.stringify({type:"result",result:"got "+m.message.content,is_error:false})+"\\n");',
			'}});process.stdin.on("end",()=>process.exit(0));',
		].join("");
		const kinds: string[] = [];
		const outcome = await runClaudeTask(["-e", script], {
			cwd: process.cwd(),
			env: {},
			bin: process.execPath,
			prompt: "hello",
			onEvent: (event) => kinds.push(event.kind),
		});
		expect(kinds).toEqual(["prompt", "result"]);
		expect(outcome.resultText).toBe("got hello");
		expect(outcome.isError).toBe(false);
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("stopping runs", () => {
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const waitFor = async (check: () => boolean, ms = 4000) => {
		const end = Date.now() + ms;
		while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	};

	it("kills the whole process tree, including a grandchild in its own group", async () => {
		// Like Claude Code's Bash tool, the grandchild is a session leader in a
		// group of its own, so signalling the child's group would miss it.
		const script = [
			'const {spawn}=require("node:child_process");',
			'const g=spawn("setsid",[process.execPath,"-e","setInterval(()=>{},1000)"],{stdio:"ignore"});',
			'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"s"})+"\\n");',
			"setInterval(()=>{},1000);",
		].join("");
		const abort = new AbortController();
		let pid = 0;
		let onInit: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			onInit = resolve;
		});
		const run = runClaudeTask(["-e", script], {
			cwd: process.cwd(),
			env: {},
			bin: process.execPath,
			signal: abort.signal,
			onSpawn: (spawned) => {
				pid = spawned;
			},
			onEvent: (event) => {
				if (event.kind === "init") onInit();
			},
		});
		await ready;
		await waitFor(() => descendantsOf(pid).length > 0);
		const tree = descendantsOf(pid);
		expect(tree.length).toBeGreaterThan(0);
		expect(alive(pid)).toBe(true);

		abort.abort();
		const outcome = await run;
		expect(outcome.cancelled).toBe(true);
		expect(outcome.isError).toBe(false);
		await waitFor(() => !alive(pid) && !tree.some(alive));
		expect(alive(pid)).toBe(false);
		for (const member of tree) expect(alive(member)).toBe(false);
	});

	it("resolves at once as cancelled when the signal is already aborted", async () => {
		const abort = new AbortController();
		abort.abort();
		const outcome = await runClaudeTask(["-e", "setInterval(()=>{},1000)"], {
			cwd: process.cwd(),
			env: {},
			bin: process.execPath,
			signal: abort.signal,
		});
		expect(outcome.cancelled).toBe(true);
	});

	// A runTask stand-in that stays "running" until its signal aborts.
	function hanging(spawnedPid = 4242) {
		return (
			_args: string[],
			options: { signal?: AbortSignal; onSpawn?: (pid: number) => void },
		) => {
			options.onSpawn?.(spawnedPid);
			return new Promise<{ isError: boolean; cancelled: boolean; model: string }>((resolve) => {
				options.signal?.addEventListener("abort", () =>
					resolve({ isError: false, cancelled: true, model: "claude-opus-5-5" }),
				);
			});
		};
	}

	it("/cc stop cancels this chat's live run and says so in the chat", async () => {
		const h = harness("opus", {}, hanging() as never);
		await h.cc("on", h.uiCtx);
		h.input("do a long thing");
		await flush();
		await h.cc("stop", h.uiCtx);
		await h.whenIdle();
		expect(h.ui.notify).toHaveBeenCalledWith("Stopping 1 Claude Code run…", "info");
		expect(h.ui.notify).toHaveBeenCalledWith("⏹ Stopped.", "warning");
		const note = h.sendMessage.mock.calls
			.map((call) => call[0])
			.find((m) => m.customType === "note");
		expect(note.content).toBe("⏹ Stopped.");
		// The progress label is cleared once the run is gone.
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("claude-sticky", "Opus 5.5 · high");
	});

	it("/cc stop reports when nothing is running", async () => {
		const h = harness("opus", {}, hanging() as never);
		await h.cc("stop", h.uiCtx);
		expect(h.ui.notify).toHaveBeenLastCalledWith("Nothing is running in this chat.", "info");
		await h.cc("stop all", h.uiCtx);
		expect(h.ui.notify).toHaveBeenLastCalledWith("No Claude Code runs are active.", "info");
	});

	it("drops runs queued behind the one that was stopped", async () => {
		const seen: number[] = [];
		const h = harness("opus", {}, ((args: string[], options: never) => {
			seen.push(seen.length);
			return hanging()(args, options);
		}) as never);
		// Different models cannot join the live run, so the second one queues.
		const first = h.cc("opus first", h.uiCtx);
		await flush();
		const second = h.cc("haiku second", h.uiCtx);
		await flush();
		await h.cc("stop", h.uiCtx);
		await Promise.all([first, second]);
		expect(seen).toEqual([0]);
	});

	it("stops a run at the time limit and says why", async () => {
		const h = harness("opus", {}, hanging() as never, [], { maxRunMs: 30 });
		await h.cc("do a long thing", h.uiCtx);
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("time limit"), "warning");
		expect(MAX_RUN_MS).toBe(3 * 60 * 60 * 1000);
	});

	it("registers a run for /cc ps and removes it when the run ends", async () => {
		let release: () => void = () => {};
		const h = harness("opus", {}, ((
			_args: string[],
			options: { onSpawn?: (p: number) => void },
		) => {
			options.onSpawn?.(process.pid); // a pid that is certainly alive
			return new Promise((resolve) => {
				release = () => resolve({ resultText: "ok", isError: false, model: "claude-opus-5-5" });
			});
		}) as never);
		const running = h.cc("work", h.uiCtx);
		await flush();
		const listed = h.registry.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ pid: process.pid, chat: "chat-1", mode: "opus" });
		await h.cc("ps", h.uiCtx);
		expect(String(h.ui.notify.mock.calls.at(-1)?.[0])).toContain("this chat");
		release();
		await running;
		expect(h.registry.list()).toEqual([]);
	});

	it("kills a live run when the session shuts down", async () => {
		const h = harness("opus", {}, hanging() as never);
		const running = h.cc("work", h.uiCtx);
		await flush();
		h.shutdown();
		await running;
		expect(h.ui.notify).toHaveBeenCalledWith("⏹ Stopped.", "warning");
	});
});

describe("run registry", () => {
	const record = (pid: number, owner: number) => ({
		pid,
		owner,
		chat: "c",
		mode: "opus" as const,
		startedAt: new Date().toISOString(),
	});

	it("lists live runs and deletes records of dead ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "runs-"));
		const registry = new RunRegistry(dir, (pid) => pid === 10);
		registry.add(record(10, 1));
		registry.add(record(11, 1));
		expect(registry.list().map((r) => r.pid)).toEqual([10]);
		expect(readdirSync(dir)).toEqual(["10.json"]);
		registry.remove(10);
		expect(registry.list()).toEqual([]);
	});

	it("drops a record whose pid now belongs to a different process", () => {
		const dir = mkdtempSync(join(tmpdir(), "runs-"));
		const registry = new RunRegistry(dir, () => true);
		const ticks = processStartTicks(process.pid);
		if (ticks === undefined) return; // No /proc here: nothing to compare.
		registry.add({ ...record(process.pid, 1), startTicks: ticks });
		expect(registry.list().map((r) => r.pid)).toEqual([process.pid]);
		registry.add({ ...record(process.pid, 1), startTicks: `${ticks}0` }); // reused pid
		expect(registry.list()).toEqual([]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("reaps runs whose owning pi process is gone, and only those", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runs-"));
		const child = (await import("node:child_process")).spawn(
			process.execPath,
			["-e", "setInterval(()=>{},1000)"],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();
		const registry = new RunRegistry(
			dir,
			() => true,
			(owner) => owner === 1,
		);
		registry.add(record(child.pid as number, 999_999)); // owner dead
		registry.add(record(process.pid, 1)); // owner alive: must survive
		expect(await registry.reapOrphans()).toEqual([child.pid]);
		expect(() => process.kill(child.pid as number, 0)).toThrow();
		expect(registry.list().map((r) => r.pid)).toEqual([process.pid]);
	});
});

describe("conversation continuity", () => {
	it("starts a fresh conversation, silently, when the stored one is gone", async () => {
		const calls: string[][] = [];
		const h = harness("sonnet", {}, async (args, options) => {
			calls.push(args);
			const events = (options as { onEvent?: (e: StreamEvent) => void }).onEvent;
			if (args.includes("--resume")) {
				events?.({ kind: "result", isError: true, staleSession: true });
				return { isError: true, staleSession: true, resultText: "No conversation found" };
			}
			return { resultText: "fresh answer", isError: false, claudeSessionId: "s-new" };
		});
		h.sessions["chat-1"] = "s-gone";
		await h.cc("carry on", h.uiCtx);

		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("--resume");
		expect(calls[1]).toContain("--session-id");
		expect(h.sessions["chat-1"]).toBe("s-new");
		// The failed attempt never reaches the chat; the retry's answer does.
		const errors = h.ui.notify.mock.calls.filter(([, type]) => type === "error");
		expect(errors).toEqual([]);
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("fresh one"), "warning");
		const notes = h.sendMessage.mock.calls.map((c) => c[0]).filter((m) => m.customType === "note");
		expect(String(notes.at(-1).content)).toContain("fresh answer");
	});

	it("resumes on the model the chat started with, not wherever the alias moved", async () => {
		const calls: string[][] = [];
		const h = harness("opus", { opus: "claude-opus-5-6" }, async (args) => {
			calls.push(args);
			return { resultText: "ok", isError: false, claudeSessionId: "s-1", model: "claude-opus-5-5" };
		});
		await h.cc("first", h.uiCtx);
		expect(calls[0][calls[0].indexOf("--model") + 1]).toBe("opus");
		expect(h.pins["chat-1:opus"]).toBe("claude-opus-5-5");
		await h.cc("second", h.uiCtx);
		expect(calls[1][calls[1].indexOf("--model") + 1]).toBe("claude-opus-5-5");
	});

	it("sends the owner context once, not on every resumed run", async () => {
		const prompts: string[] = [];
		const h = harness("sonnet", {}, async (_args, options) => {
			prompts.push((options as unknown as { prompt: string }).prompt);
			return { resultText: "ok", isError: false, claudeSessionId: "s-1" };
		});
		await h.cc("first", h.uiCtx);
		await h.cc("second", h.uiCtx);
		expect(prompts[0]).toContain("/home/lepton/AGENTS.md");
		expect(prompts[1]).toBe("second");
	});

	it("/cc new forgets the conversation, but not while a task is running", async () => {
		const h = harness("sonnet", {}, async () => ({ resultText: "ok", isError: false }));
		h.sessions["chat-1"] = "s-1";
		await h.cc("new", h.uiCtx);
		expect(h.sessions["chat-1"]).toBeUndefined();
	});

	it("runs in the workspace it is given", () => {
		const plan = buildClaudeSpawn({ task: "t", mode: "sonnet", workspace: "/tmp/elsewhere" });
		expect(plan.cwd).toBe("/tmp/elsewhere");
	});

	it("parses controls for stop, ps and new", () => {
		expect(parseCcControl("stop")).toEqual({ kind: "stop", all: false });
		expect(parseCcControl("STOP all")).toEqual({ kind: "stop", all: true });
		expect(parseCcControl("ps")).toEqual({ kind: "ps" });
		expect(parseCcControl("new")).toEqual({ kind: "new" });
		expect(parseCcControl("stop the printer")).toBeUndefined();
		expect(parseCcControl("new york flights")).toBeUndefined();
	});
});

describe("chat history across pi and Claude Code", () => {
	const user = (text: string) => ({
		type: "message",
		message: { role: "user", content: [{ type: "text", text }] },
	});
	const piReply = (text: string) => ({
		type: "message",
		message: { role: "assistant", provider: "venice", content: [{ type: "text", text }] },
	});
	const claudePrompt = (text: string) => ({
		type: "custom_message",
		customType: PROMPT_MESSAGE_TYPE,
		content: text,
	});
	const claudeReply = (text: string, extra: unknown[] = []) => ({
		type: "message",
		message: {
			role: "assistant",
			provider: MIRROR_PROVIDER,
			content: [...extra, { type: "text", text }],
		},
	});

	it("gives a fresh Claude conversation the whole chat, labelled by who said it", () => {
		const text = buildCatchUp(
			[
				user("what's the plan for the trip?"),
				piReply("book flights first"),
				claudePrompt("book them"),
				claudeReply("booked"),
			],
			{ fresh: true, sessionFile: "/x/chat.jsonl" },
		) as string;
		expect(text).toContain("User: what's the plan for the trip?");
		expect(text).toContain("Assistant: book flights first");
		expect(text).toContain("User (to Claude Code): book them");
		expect(text).toContain("Claude Code: booked");
		expect(text).toContain("/x/chat.jsonl");
		expect(text).toContain("act on the Task");
	});

	it("gives a resumed conversation only what pi said since Claude's last turn", () => {
		const text = buildCatchUp(
			[
				user("old question"),
				claudePrompt("first task"),
				claudeReply("first done"),
				user("new question for pi"),
				piReply("pi's answer"),
			],
			{ fresh: false },
		) as string;
		expect(text).toContain("new question for pi");
		expect(text).toContain("pi's answer");
		expect(text).not.toContain("old question");
		expect(text).not.toContain("first done");
		expect(text).toContain("Since your last reply");
	});

	it("adds nothing when Claude Code has seen everything", () => {
		expect(
			buildCatchUp([user("q"), claudePrompt("task"), claudeReply("done")], { fresh: false }),
		).toBeUndefined();
		expect(buildCatchUp([], { fresh: true })).toBeUndefined();
	});

	it("keeps the newest messages when the history is too long", () => {
		const entries = Array.from({ length: 50 }, (_, i) =>
			user(`message number ${i} ${"x".repeat(100)}`),
		);
		const text = buildCatchUp(entries, { fresh: true, limit: 1500 }) as string;
		expect(text).toContain("message number 49");
		expect(text).not.toContain("message number 0 ");
		expect(text).toMatch(/\[\d+ earlier messages omitted\]/);
	});

	it("summarises pi's tool calls and results, and treats compaction summaries as history", () => {
		const text = buildCatchUp(
			[
				{ type: "compaction", summary: "we discussed the router" },
				{
					type: "message",
					message: {
						role: "assistant",
						provider: "venice",
						content: [{ type: "toolCall", id: "p1", name: "bash", arguments: { command: "ls" } }],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "p1",
						toolName: "bash",
						content: [{ type: "text", text: "a.txt" }],
					},
				},
			],
			{ fresh: true },
		) as string;
		expect(text).toContain("we discussed the router");
		expect(text).toContain('[Assistant tool call: bash {"command":"ls"}]');
		expect(text).toContain("[tool result (bash): a.txt]");
	});

	it("puts the catch-up in the first prompt, before the task", async () => {
		const prompts: string[] = [];
		const h = harness(
			"sonnet",
			{},
			async (_args, options) => {
				prompts.push((options as unknown as { prompt: string }).prompt);
				return { resultText: "ok", isError: false, claudeSessionId: "s-1" };
			},
			[],
			{ branch: [user("we chose the blue one"), piReply("noted")] },
		);
		await h.cc("order it", h.uiCtx);
		expect(prompts[0]).toContain("we chose the blue one");
		expect(prompts[0]).toContain("Task: order it");
		expect(prompts[0].indexOf("we chose the blue one")).toBeLessThan(prompts[0].indexOf("Task:"));
	});

	it("re-sends the whole chat when a stale conversation restarts fresh", async () => {
		const prompts: string[] = [];
		const h = harness(
			"sonnet",
			{},
			async (args, options) => {
				prompts.push((options as unknown as { prompt: string }).prompt);
				if (args.includes("--resume")) return { isError: true, staleSession: true };
				return { resultText: "ok", isError: false, claudeSessionId: "s-2" };
			},
			[],
			{
				branch: [user("early context"), claudePrompt("earlier task"), claudeReply("earlier done")],
			},
		);
		h.sessions["chat-1"] = "s-gone";
		await h.cc("carry on", h.uiCtx);
		// The resumed attempt had nothing new; the fresh one needs the lot.
		expect(prompts[0]).toBe("carry on");
		expect(prompts[1]).toContain("early context");
		expect(prompts[1]).toContain("Claude Code: earlier done");
	});

	it("marks the display notes so they can be told from the reply they repeat", async () => {
		const h = harness("sonnet", {}, async () => ({ resultText: "done", isError: false }));
		await h.cc("go", h.uiCtx);
		const note = h.sendMessage.mock.calls.map((c) => c[0]).find((m) => m.customType === "note");
		expect(note.details).toEqual({ source: "claude-delegate" });
	});

	describe("what pi's model reads after a switch back from /cc", () => {
		function chat() {
			const dir = mkdtempSync(join(tmpdir(), "acb-fold-"));
			const manager = SessionManager.create(dir, dir);
			const say = (role: "user" | "assistant", text: string, provider = "venice") =>
				manager.appendMessage(
					(role === "user"
						? { role, content: [{ type: "text", text }], timestamp: 1 }
						: {
								role,
								content: [{ type: "text", text }],
								api: provider,
								provider,
								model: "m",
								usage: {},
								stopReason: "stop",
								timestamp: 2,
							}) as never,
				);
			return { manager, say };
		}

		it("shows each Claude Code reply once, with its tool steps folded into text", () => {
			const { manager, say } = chat();
			say("user", "hello pi");
			say("assistant", "hello owner");
			manager.appendCustomMessageEntry(PROMPT_MESSAGE_TYPE, "check my inbox", true, {});
			// A tool step, its result, then the final reply (saved after its note).
			manager.appendMessage({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private plan" },
					{ type: "toolCall", id: "t1", name: "Bash", arguments: { command: "gog list" } },
				],
				api: MIRROR_PROVIDER,
				provider: MIRROR_PROVIDER,
				model: "claude-opus-5-5",
				usage: {},
				stopReason: "toolUse",
				timestamp: 3,
			} as never);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "t1",
				toolName: "Bash",
				content: [{ type: "text", text: "3 unread" }],
				isError: false,
				timestamp: 4,
			} as never);
			manager.appendCustomMessageEntry("note", "You have 3 unread.", true, {
				source: "claude-delegate",
			});
			say("assistant", "You have 3 unread.", MIRROR_PROVIDER);

			const folded = foldClaudeSteps(manager.buildSessionContext().messages as never[]) as Array<{
				role: string;
				content: unknown;
			}>;
			const flat = JSON.stringify(folded);
			// The duplicate note is gone; the reply appears once.
			expect(flat.match(/You have 3 unread\./g)).toHaveLength(1);
			// Claude's tool call is text pi can read, with its result; no tool_use left.
			expect(flat).toContain("Claude Code ran Bash");
			expect(flat).toContain("gog list");
			expect(flat).toContain("3 unread");
			expect(flat).not.toContain("toolCall");
			expect(flat).not.toContain("private plan");
			expect(folded.some((m) => m.role === "toolResult")).toBe(false);
			// The prompt is marked as having gone to Claude Code, and the steps read as one turn.
			expect(flat).toContain("[Sent to Claude Code] check my inbox");
			expect(folded.map((m) => m.role)).toEqual(["user", "assistant", "custom", "assistant"]);
		});

		it("keeps Claude Code's reply in a running chat, where only the display note exists", () => {
			// pi's live conversation gets sendMessage notes, not the assistant copies
			// written to the session file, so the note is the only record of the reply.
			const live = [
				{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
				{
					role: "custom",
					customType: PROMPT_MESSAGE_TYPE,
					content: "make a codeword",
					timestamp: 2,
				},
				{
					role: "custom",
					customType: "note",
					content: "Kronvest\n\n— Haiku 5.5 · 1 turn",
					details: { source: "claude-delegate" },
					timestamp: 3,
				},
			];
			const folded = foldClaudeSteps(live as never[]) as Array<{
				role: string;
				provider?: string;
				content: unknown;
			}>;
			expect(folded.map((m) => m.role)).toEqual(["user", "custom", "assistant"]);
			expect(folded[2].provider).toBe(MIRROR_PROVIDER);
			expect(JSON.stringify(folded[2].content)).toContain("Kronvest");
		});

		it("also drops duplicate notes from chats saved before notes were marked", () => {
			const { manager, say } = chat();
			manager.appendCustomMessageEntry("note", "old reply", true);
			say("assistant", "old reply", MIRROR_PROVIDER);
			const folded = foldClaudeSteps(manager.buildSessionContext().messages as never[]);
			expect(JSON.stringify(folded).match(/old reply/g)).toHaveLength(1);
		});

		it("leaves ordinary chats and other extensions' notes alone", () => {
			const { manager, say } = chat();
			say("user", "hi");
			manager.appendCustomMessageEntry("note", "something else", true);
			say("assistant", "hey");
			const messages = manager.buildSessionContext().messages as never[];
			expect(foldClaudeSteps(messages)).toEqual(messages);
		});

		it("is wired into pi's context event", () => {
			const h = harness("sonnet");
			const result = h.context([
				{
					role: "custom",
					customType: "note",
					content: "r",
					details: { source: "claude-delegate" },
				},
				{ role: "assistant", provider: MIRROR_PROVIDER, content: [{ type: "text", text: "r" }] },
			]);
			expect(result?.messages).toHaveLength(1);
		});

		it("gives the catch-up builder pi's real branch entries", () => {
			const { manager, say } = chat();
			say("user", "remember: the code is 4471");
			say("assistant", "noted");
			const text = buildCatchUp(manager.getBranch() as never[], {
				fresh: true,
				sessionFile: manager.getSessionFile(),
			}) as string;
			expect(text).toContain("User: remember: the code is 4471");
			expect(text).toContain("Assistant: noted");
		});
	});
});

describe("usage reporting", () => {
	it("reads usage and a vanished-conversation failure from the result event", () => {
		const parser = new StreamParser();
		const [ok] = parser.feed(
			`${JSON.stringify({
				type: "result",
				result: "done",
				is_error: false,
				duration_ms: 72_000,
				num_turns: 14,
				usage: {
					input_tokens: 10,
					cache_creation_input_tokens: 8000,
					cache_read_input_tokens: 30_000,
					output_tokens: 2100,
				},
			})}\n`,
		);
		expect(ok).toMatchObject({
			kind: "result",
			usage: {
				durationMs: 72_000,
				turns: 14,
				inputTokens: 8010,
				outputTokens: 2100,
				cacheReadTokens: 30_000,
			},
		});
		const [stale] = parser.feed(
			`${JSON.stringify({
				type: "result",
				is_error: true,
				errors: ["No conversation found with session ID: x"],
			})}\n`,
		);
		expect(stale).toMatchObject({ kind: "result", isError: true, staleSession: true });
	});

	it("summarises a turn for the reply footer", () => {
		expect(
			usageSummary({
				durationMs: 72_000,
				turns: 14,
				inputTokens: 8010,
				outputTokens: 2100,
				cacheReadTokens: 30_000,
			}),
		).toBe("14 turns · 1m12s · 38k in / 2.1k out");
		expect(usageSummary(undefined)).toBe("");
	});

	it("does not post an empty reply for a result with no text and no turns", async () => {
		const h = harness("sonnet", {}, async (_args, options) => {
			const emit = (options as { onEvent?: (e: StreamEvent) => void }).onEvent;
			emit?.({ kind: "init", claudeSessionId: "s", model: "claude-sonnet-5-5" });
			// Claude Code's leftover result from an earlier run's background task.
			emit?.({
				kind: "result",
				text: "",
				isError: false,
				usage: { turns: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
			});
			emit?.({
				kind: "result",
				text: "real answer",
				isError: false,
				usage: {
					turns: 2,
					durationMs: 4000,
					inputTokens: 500,
					outputTokens: 50,
					cacheReadTokens: 0,
				},
			});
			return { resultText: "real answer", isError: false, model: "claude-sonnet-5-5" };
		});
		await h.cc("go", h.uiCtx);
		const notes = h.sendMessage.mock.calls.map((c) => c[0]).filter((m) => m.customType === "note");
		expect(notes).toHaveLength(1);
		expect(String(notes[0].content)).toContain("real answer");
	});

	it("puts the summary in the reply footer", async () => {
		const h = harness("sonnet", {}, async (_args, options) => {
			const emit = (options as { onEvent?: (e: StreamEvent) => void }).onEvent;
			emit?.({ kind: "init", claudeSessionId: "s", model: "claude-sonnet-5-5" });
			emit?.({
				kind: "result",
				text: "done",
				isError: false,
				usage: {
					turns: 3,
					durationMs: 5000,
					inputTokens: 900,
					outputTokens: 120,
					cacheReadTokens: 0,
				},
			});
			return { resultText: "done", isError: false, model: "claude-sonnet-5-5" };
		});
		await h.cc("go", h.uiCtx);
		const note = h.sendMessage.mock.calls.map((c) => c[0]).find((m) => m.customType === "note");
		expect(String(note.content)).toContain("3 turns · 5s · 900 in / 120 out");
	});
});

describe("chat history mirroring against pi's real session manager", () => {
	// The mirror leans on SessionManager.appendMessage, which pi does not
	// promise to extensions. If a pi upgrade changes it, this fails first.
	it("writes a chat file that keeps the mirrored reply", () => {
		const dir = mkdtempSync(join(tmpdir(), "acb-mirror-"));
		const manager = SessionManager.create(dir, dir);
		const ctx = { ui: { setStatus: vi.fn(), notify: vi.fn() }, sessionManager: manager };
		mirrorReplyToSession(ctx, "answer from claude", "claude-opus-5-5", ["thought"]);

		const roles = manager
			.getEntries()
			.filter((e) => e.type === "message")
			.map((e) => (e as { message: { role: string } }).message.role);
		expect(roles).toEqual(["assistant"]);
		const file = manager.getSessionFile();
		expect(file).toBeTruthy();
		const saved = readFileSync(file as string, "utf8");
		expect(saved).toContain("answer from claude");
		expect(saved).toContain("thought");
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("warns once, instead of silently losing the chat, when appendMessage is gone", () => {
		const notify = vi.fn();
		const ctx = { ui: { setStatus: vi.fn(), notify }, sessionManager: {} };
		mirrorReplyToSession(ctx, "a", "m");
		mirrorReplyToSession(ctx, "b", "m");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("session API changed");
	});
});
