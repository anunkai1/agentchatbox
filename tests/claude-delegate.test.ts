import { describe, expect, it, vi } from "vitest";
import {
	ACTIVITY_STATUS_KEY,
	formatElapsed,
	MIRROR_PROVIDER,
	PROMPT_MESSAGE_TYPE,
	parseCcArgs,
	parseCcControl,
	registerClaudeDelegate,
	restoreStickyMode,
	runClaudeTask,
	STICKY_ENTRY_TYPE,
	SteerChannel,
} from "../extensions/claude-delegate/index.js";
import {
	buildClaudeSpawn,
	buildPrompt,
	DEFAULT_EFFORT,
	delegationLabel,
	FileDelegationStore,
	normaliseToolArgs,
	parseDelegationMode,
	prettyModelName,
	type StreamEvent,
	StreamParser,
} from "../extensions/claude-delegate/lib.js";

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
		expect(store.readMode()).toBe("sonnet");
		store.writeMode("haiku");
		expect(store.readMode()).toBe("haiku");
		store.writeClaudeSession("chat-1", "s-42");
		expect(store.readClaudeSession("chat-1")).toBe("s-42");
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
) {
	let current = mode;
	const sessions: Record<string, string> = {};
	const store = {
		readMode: () => current as never,
		writeMode: (next: string) => {
			current = next;
		},
		readClaudeSession: (key: string) => sessions[key],
		writeClaudeSession: (key: string, id: string) => {
			sessions[key] = id;
		},
		readModel: (forMode: string) => knownModels[forMode],
		writeModel: (forMode: string, modelId: string) => {
			knownModels[forMode] = modelId;
		},
	};
	const handlers: Record<string, CommandHandler> = {};
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	let input: ((event: unknown, ctx: unknown) => { action: string }) | undefined;
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
			},
			sendMessage,
			appendEntry,
		} as never,
		store as never,
		"/tmp/claude-delegate-workspace",
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
		command: handlers.claude!,
		cc: handlers.cc!,
		sessionStart: () => sessionStart?.({}, uiCtx),
		input: (text: string, extra: Record<string, unknown> = {}) =>
			input?.({ type: "input", text, source: "rpc", ...extra }, uiCtx),
		whenIdle: () => delegate.whenIdle(),
		appendEntry,
		sessions,
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
		expect(seen[0][seen[0].indexOf("--model") + 1]).toBe("haiku");
		await h.cc("opus do a thing", h.uiCtx);
		expect(seen[1][seen[1].indexOf("--model") + 1]).toBe("opus");
	});

	it("reports a failed /cc run as an error but keeps the prompt", async () => {
		const h = harness("haiku", {}, async () => ({
			resultText: "captcha wall",
			isError: true,
			model: "claude-haiku-4-5-20251001",
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
	it("has no time limit", async () => {
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
