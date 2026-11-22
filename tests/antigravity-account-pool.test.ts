import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultAccountsDir,
	defaultPrimaryHome,
	defaultStateFile,
	findDuplicateLabel,
	PRIMARY_LABEL,
	prepareAccountDirectory,
	readAntigravityAccounts,
	removeAccountSlot,
	suggestNextLabel,
	validateAccountLabel,
} from "../extensions/antigravity-account-pool/accounts.js";
import { registerAntigravityAccountPool } from "../extensions/antigravity-account-pool/index.js";
import {
	AccountPool,
	classifyAntigravityError,
	classifyModelGroup,
	parseResetFromError,
} from "../extensions/antigravity-account-pool/pool.js";
import {
	ANTIGRAVITY_SHARED_RUNTIME_SYMBOL,
	type AntigravityRuntimeLike,
	type AntigravitySharedSlot,
	MANAGED_AUTH_MARKER,
	patchAntigravityRuntimeForPool,
	type StreamModelLike,
} from "../extensions/antigravity-account-pool/runtime-hook.js";
import type { QuotaSummary } from "../extensions/plan-usage/gemini.js";

const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix = "acb-agy-pool-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeToken(geminiHome: string, refreshToken: string): string {
	const acpDir = join(geminiHome, "antigravity-acp");
	mkdirSync(acpDir, { recursive: true, mode: 0o700 });
	const tokenFile = join(acpDir, "acp_token.json");
	writeFileSync(
		tokenFile,
		JSON.stringify({
			client_id: "test-client",
			client_secret: "test-secret",
			refresh_token: refreshToken,
		}),
		{ mode: 0o600 },
	);
	return tokenFile;
}

function makeMessage(
	model: StreamModelLike,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "antigravity-acp" as AssistantMessage["api"],
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length > 0) {
		const fn = cleanups.pop();
		if (fn) await fn();
	}
});

describe("accounts.ts", () => {
	it("discovers primary first and extra accounts sorted alphabetically, deduplicating refresh tokens", () => {
		const root = makeTempDir();
		const primaryHome = join(root, "primary-home");
		const accountsDir = join(root, "accounts");

		writeToken(primaryHome, "tok-primary");
		writeToken(join(accountsDir, "zeta"), "tok-zeta");
		writeToken(join(accountsDir, "alpha"), "tok-alpha");
		writeToken(join(accountsDir, "dup-of-primary"), "tok-primary");
		mkdirSync(join(accountsDir, "empty-slot", "antigravity-acp"), { recursive: true });
		mkdirSync(join(accountsDir, ".hidden"), { recursive: true });
		writeToken(join(accountsDir, ".hidden"), "tok-hidden");

		const accounts = readAntigravityAccounts(primaryHome, accountsDir);
		expect(accounts.map((a) => ({ label: a.label, isPrimary: a.isPrimary }))).toEqual([
			{ label: PRIMARY_LABEL, isPrimary: true },
			{ label: "alpha", isPrimary: false },
			{ label: "zeta", isPrimary: false },
		]);
		expect(suggestNextLabel(accounts)).toBe("pro2");

		writeToken(join(accountsDir, "pro2"), "tok-pro2");
		expect(suggestNextLabel(readAntigravityAccounts(primaryHome, accountsDir))).toBe("pro3");
	});

	it("respects ACB_ANTIGRAVITY_* environment overrides", () => {
		const prevPrimary = process.env.ACB_ANTIGRAVITY_PRIMARY_HOME;
		const prevDir = process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR;
		const prevState = process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE;
		cleanups.push(() => {
			if (prevPrimary === undefined) delete process.env.ACB_ANTIGRAVITY_PRIMARY_HOME;
			else process.env.ACB_ANTIGRAVITY_PRIMARY_HOME = prevPrimary;
			if (prevDir === undefined) delete process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR;
			else process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR = prevDir;
			if (prevState === undefined) delete process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE;
			else process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE = prevState;
		});

		process.env.ACB_ANTIGRAVITY_PRIMARY_HOME = "/tmp/custom-primary";
		process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR = "/tmp/custom-accounts";
		process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE = "/tmp/custom-state.json";

		expect(defaultPrimaryHome()).toBe("/tmp/custom-primary");
		expect(defaultAccountsDir()).toBe("/tmp/custom-accounts");
		expect(defaultStateFile()).toBe("/tmp/custom-state.json");
	});

	it("validates labels, prepares isolated GEMINI_HOME dirs with 0700/0600, detects duplicates, and removes extra slots only", () => {
		expect(validateAccountLabel("pro2")).toBe("pro2");
		expect(() => validateAccountLabel("")).toThrow();
		expect(() => validateAccountLabel("auto")).toThrow(/reserved/);
		expect(() => validateAccountLabel("AUTO")).toThrow(/reserved/);
		expect(() => validateAccountLabel(".")).toThrow();
		expect(() => validateAccountLabel("..")).toThrow();
		expect(() => validateAccountLabel("../bad")).toThrow();
		expect(() => validateAccountLabel("bad label")).toThrow();

		const root = makeTempDir();
		const primaryHome = join(root, "primary-home");
		const accountsDir = join(root, "accounts");
		writeToken(primaryHome, "tok-1");

		const paths = prepareAccountDirectory("pro2", primaryHome, accountsDir);
		expect(existsSync(paths.acpDir)).toBe(true);
		expect(statSync(paths.acpDir).mode & 0o777).toBe(0o700);
		expect(statSync(paths.settingsFile).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(paths.settingsFile, "utf8"))).toEqual({
			auth: { type: "oauth-personal" },
		});

		// Preserves existing settings.json if auth is already configured.
		chmodSync(paths.settingsFile, 0o600);
		writeFileSync(
			paths.settingsFile,
			JSON.stringify({ auth: { type: "oauth-personal" }, extra: 42 }),
		);
		prepareAccountDirectory("pro2", primaryHome, accountsDir);
		expect(JSON.parse(readFileSync(paths.settingsFile, "utf8"))).toEqual({
			auth: { type: "oauth-personal" },
			extra: 42,
		});

		writeToken(join(accountsDir, "pro2"), "tok-1");
		expect(findDuplicateLabel(paths.tokenFile, "pro2", primaryHome, accountsDir)).toBe("primary");
		expect(
			findDuplicateLabel(paths.tokenFile, "primary", primaryHome, accountsDir),
		).toBeUndefined();

		expect(() => removeAccountSlot("primary", accountsDir)).toThrow(/Cannot remove "primary"/);
		expect(removeAccountSlot("pro2", accountsDir)).toBe(true);
		expect(removeAccountSlot("pro2", accountsDir)).toBe(false);
		expect(existsSync(paths.geminiHome)).toBe(false);
	});
});

describe("pool.ts", () => {
	it("classifies model groups and Antigravity errors accurately", () => {
		expect(classifyModelGroup(undefined)).toBe("gemini");
		expect(classifyModelGroup("gemini-4-hydrogen-high")).toBe("gemini");
		expect(classifyModelGroup("gemini-4-argon-high")).toBe("argon");
		expect(classifyModelGroup("claude-opus-5-5-high")).toBe("third-party");
		expect(classifyModelGroup("gpt-oss-120b-medium")).toBe("third-party");

		const reset = parseResetFromError("Quota exhausted. Resets at 2026-11-22T10:00:00Z.");
		expect(reset?.toISOString()).toBe("2026-11-22T10:00:00.000Z");

		expect(classifyAntigravityError("Usage Limit Reached. Resets at 2026-11-22T10:00:00Z")).toEqual(
			{
				kind: "quota",
				resetAt: new Date("2026-11-22T10:00:00.000Z"),
			},
		);
		expect(classifyAntigravityError("HTTP 429 RESOURCE_EXHAUSTED")).toEqual({
			kind: "rate_limit",
		});
		expect(classifyAntigravityError("Antigravity authentication required")).toEqual({
			kind: "auth",
		});
		expect(classifyAntigravityError("network socket hang up")).toBeUndefined();
	});

	it("orders preferred > custom order > primary > alpha, scopes cooldowns by model group, and falls back to earliest expiry", () => {
		const root = makeTempDir();
		const primaryHome = join(root, "primary");
		const accountsDir = join(root, "accounts");
		const stateFile = join(accountsDir, "state.json");

		writeToken(primaryHome, "tok-p");
		writeToken(join(accountsDir, "pro2"), "tok-2");
		writeToken(join(accountsDir, "pro3"), "tok-3");

		const pool = new AccountPool({ primaryHome, accountsDir, stateFile });
		const t0 = new Date("2026-11-22T00:00:00Z");

		// Default order: primary, pro2, pro3
		expect(pool.orderedAccounts().map((a) => a.label)).toEqual(["primary", "pro2", "pro3"]);

		pool.setOrder(["pro3", "primary"]);
		expect(pool.orderedAccounts().map((a) => a.label)).toEqual(["pro3", "primary", "pro2"]);

		pool.setPreferred("pro2");
		expect(pool.orderedAccounts().map((a) => a.label)).toEqual(["pro2", "pro3", "primary"]);
		expect(statSync(stateFile).mode & 0o777).toBe(0o600);

		pool.setPreferred(undefined);
		expect(pool.orderedAccounts().map((a) => a.label)).toEqual(["pro3", "primary", "pro2"]);

		// Quota failure on Gemini for pro3 only blocks gemini group, NOT third-party (Claude)
		pool.markFailure(
			"pro3",
			"gemini-4-hydrogen-high",
			"Antigravity quota exceeded. Resets at 2026-11-22T02:00:00Z",
			t0,
		);
		expect(pool.candidates("gemini-4-hydrogen-high", t0).map((a) => a.label)).toEqual([
			"primary",
			"pro2",
		]);
		expect(pool.candidates("claude-opus-5-5-high", t0).map((a) => a.label)).toEqual([
			"pro3",
			"primary",
			"pro2",
		]);

		// Cool down remaining accounts for gemini with different reset times -> when all are cooled down,
		// candidates() sorts by earliest expiry.
		pool.markFailure(
			"primary",
			"gemini-4-hydrogen-high",
			"Usage Limit Reached. Resets at 2026-11-22T05:00:00Z",
			t0,
		);
		pool.markFailure(
			"pro2",
			"gemini-4-hydrogen-high",
			"Usage Limit Reached. Resets at 2026-11-22T01:00:00Z",
			t0,
		);
		expect(pool.candidates("gemini-4-hydrogen-high", t0).map((a) => a.label)).toEqual([
			"pro2",
			"pro3",
			"primary",
		]);

		// After pro2 resets, it becomes usable again immediately.
		const tAfterPro2 = new Date("2026-11-22T01:05:00Z");
		expect(pool.candidates("gemini-4-hydrogen-high", tAfterPro2).map((a) => a.label)).toEqual([
			"pro2",
		]);

		pool.forgetAccount("pro3");
		expect(pool.state().order).toEqual(["primary"]);
		expect(pool.orderedAccounts().map((a) => a.label)).toEqual(["primary", "pro2", "pro3"]);
	});
});

describe("runtime-hook.ts", () => {
	function setupTestPool() {
		const root = makeTempDir();
		const primaryHome = join(root, "primary");
		const accountsDir = join(root, "accounts");
		const stateFile = join(accountsDir, "state.json");
		writeToken(primaryHome, "tok-primary");
		writeToken(join(accountsDir, "pro2"), "tok-pro2");
		writeToken(join(accountsDir, "pro3"), "tok-pro3");
		const pool = new AccountPool({ primaryHome, accountsDir, stateFile });
		return { root, primaryHome, accountsDir, pool };
	}

	const geminiModel: StreamModelLike = {
		id: "gemini-4-hydrogen-high",
		provider: "antigravity-acp",
		api: "antigravity-acp",
	};

	it("injects GEMINI_HOME via connectionFactory while preserving explicit overrides and passing through non-OAuth streams", async () => {
		const { primaryHome, pool } = setupTestPool();
		const seenConnectionEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
		const seenApis: Array<string | undefined> = [];

		const runtime: AntigravityRuntimeLike = {
			connectionFactory(opts) {
				seenConnectionEnvs.push(opts.env);
				return { closed: false };
			},
			stream(model, _ctx, opts) {
				seenApis.push(opts?.apiKey);
				const s = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const msg = makeMessage(model);
					s.push({ type: "done", reason: "stop", message: msg });
					s.end();
				});
				return { stream: s, message: undefined, finished: false };
			},
		};

		const hook = patchAntigravityRuntimeForPool(runtime, pool);
		expect(hook).toBeDefined();
		// Idempotent re-patching returns the same hook handle.
		expect(patchAntigravityRuntimeForPool(runtime, pool)).toBe(hook);

		runtime.connectionFactory!({ env: { FOO: "bar" } });
		expect(seenConnectionEnvs[0]).toEqual({ FOO: "bar", GEMINI_HOME: primaryHome });

		// Explicit GEMINI_HOME in options is never clobbered.
		runtime.connectionFactory!({ env: { GEMINI_HOME: "/explicit/home" } });
		expect(seenConnectionEnvs[1]).toEqual({ GEMINI_HOME: "/explicit/home" });

		// runWithGeminiHome overrides default pool account for connectionFactory.
		hook!.runWithGeminiHome("/scoped/home", () => {
			runtime.connectionFactory!({ env: {} });
		});
		expect(seenConnectionEnvs[2]).toEqual({ GEMINI_HOME: "/scoped/home" });

		// Explicit third-party API key passes straight through origStream untouched.
		const customWriter = runtime.stream!(geminiModel, {}, { apiKey: "sk-explicit-key" });
		const final = await customWriter.stream.result();
		expect(final.stopReason).toBe("stop");
		expect(seenApis).toEqual(["sk-explicit-key"]);
	});

	it("buffers 'Usage Limit Reached' without leaking start/text_delta, probes backups to skip 0% buckets, and replays seamlessly", async () => {
		const { primaryHome, accountsDir, pool } = setupTestPool();
		const closedSessions: string[] = [];
		const spawnedHomes: Array<string | undefined> = [];
		const failovers: Array<{ from: string; to: string; reason: string }> = [];
		const probedFiles: string[] = [];

		const runtime: AntigravityRuntimeLike = {
			connectionFactory(opts) {
				return { closed: false, env: opts?.env } as unknown as Record<string, unknown>;
			},
			async closeSession(sid) {
				closedSessions.push(sid);
			},
			stream(model, _ctx, _opts) {
				const conn = runtime.connectionFactory!({}) as unknown as { env?: NodeJS.ProcessEnv };
				const geminiHome = conn.env?.GEMINI_HOME;
				spawnedHomes.push(geminiHome);
				const s = createAssistantMessageEventStream();

				queueMicrotask(() => {
					if (geminiHome === primaryHome) {
						// Emits start + partial "Usage Limit Reached" text, then errors!
						const partial = makeMessage(model);
						s.push({ type: "start", partial });
						s.push({ type: "text_start", contentIndex: 0, partial });
						s.push({ type: "text_delta", contentIndex: 0, delta: "Usage Limit ", partial });
						s.push({ type: "text_delta", contentIndex: 0, delta: "Reached.", partial });
						s.push({
							type: "error",
							reason: "error",
							error: makeMessage(model, {
								stopReason: "error",
								errorMessage: "Antigravity quota exceeded. Resets at 2099-01-01T00:00:00Z",
							}),
						});
						s.end();
						return;
					}
					const okPartial = makeMessage(model);
					s.push({ type: "start", partial: okPartial });
					s.push({ type: "text_start", contentIndex: 0, partial: okPartial });
					s.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "Hello from pro3!",
						partial: okPartial,
					});
					s.push({
						type: "text_end",
						contentIndex: 0,
						content: "Hello from pro3!",
						partial: okPartial,
					});
					s.push({
						type: "done",
						reason: "stop",
						message: makeMessage(model, {
							content: [{ type: "text", text: "Hello from pro3!" }],
						}),
					});
					s.end();
				});

				return { stream: s, message: undefined, finished: false };
			},
		};

		patchAntigravityRuntimeForPool(runtime, pool, {
			probeQuota: async (tokenFile): Promise<QuotaSummary> => {
				probedFiles.push(tokenFile);
				// pro2 has 0% left on gemini -> should be skipped without running ACP!
				if (tokenFile.includes(`${join(accountsDir, "pro2")}`)) {
					return {
						groups: [
							{
								displayName: "Gemini Models",
								buckets: [
									{
										bucketId: "gemini-5h",
										remainingFraction: 0,
										resetTime: "2099-01-01T00:00:00Z",
									},
								],
							},
						],
					};
				}
				return { groups: [] };
			},
			onFailover: ({ from, to, reason }) => {
				failovers.push({ from: from.label, to: to.label, reason });
			},
		});

		const writer = runtime.stream!(
			geminiModel,
			{},
			{ apiKey: MANAGED_AUTH_MARKER, sessionId: "chat-1" },
		);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of writer.stream) {
			events.push(ev);
		}

		// `start` must appear exactly once and NO quota refusal text may leak to `outer`.
		expect(events.filter((e) => e.type === "start")).toHaveLength(1);
		const streamedText = events
			.filter(
				(e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> => e.type === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(streamedText).toBe("Hello from pro3!");
		expect(events.at(-1)?.type).toBe("done");

		// pro2 was skipped via probeQuota; ACP only ran on primary and pro3.
		expect(spawnedHomes).toEqual([primaryHome, join(accountsDir, "pro3")]);
		expect(probedFiles).toEqual([join(accountsDir, "pro2", "antigravity-acp", "acp_token.json")]);
		expect(failovers).toEqual([{ from: "primary", to: "pro3", reason: "quota" }]);
		expect(closedSessions).toContain("chat-1");
		expect(pool.activeAccount(geminiModel.id)?.label).toBe("pro3");
	});

	it("flushes immediately once output diverges from 'Usage Limit Reached' and never fails over on user abort", async () => {
		const { primaryHome, pool } = setupTestPool();
		let calls = 0;

		const runtime: AntigravityRuntimeLike = {
			connectionFactory: () => ({ closed: false }),
			stream(model) {
				calls += 1;
				const s = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const p = makeMessage(model);
					s.push({ type: "start", partial: p });
					s.push({ type: "text_start", contentIndex: 0, partial: p });
					s.push({ type: "text_delta", contentIndex: 0, delta: "Us", partial: p });
					s.push({ type: "text_delta", contentIndex: 0, delta: "er guide", partial: p });
					s.push({
						type: "error",
						reason: "aborted",
						error: makeMessage(model, {
							stopReason: "aborted",
							errorMessage: "Antigravity quota exceeded",
						}),
					});
					s.end();
				});
				return { stream: s };
			},
		};

		patchAntigravityRuntimeForPool(runtime, pool);
		const writer = runtime.stream!(geminiModel, {}, { sessionId: "chat-abort" });
		const events: AssistantMessageEvent[] = [];
		for await (const ev of writer.stream) events.push(ev);

		expect(calls).toBe(1);
		expect(events.map((e) => e.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"error",
		]);
		// Cooldown must still record only non-aborted failures; abort leaves primary clean.
		expect(pool.activeAccount(geminiModel.id)?.geminiHome).toBe(primaryHome);
	});
});

describe("/gemini-accounts command handler", () => {
	function setupCommandHarness(pool: AccountPool, runtime?: AntigravityRuntimeLike) {
		const slots = globalThis as Record<symbol, AntigravitySharedSlot | undefined>;
		const prevSlot = slots[ANTIGRAVITY_SHARED_RUNTIME_SYMBOL];
		slots[ANTIGRAVITY_SHARED_RUNTIME_SYMBOL] = runtime ? { runtime } : undefined;
		cleanups.push(() => {
			if (prevSlot === undefined) delete slots[ANTIGRAVITY_SHARED_RUNTIME_SYMBOL];
			else slots[ANTIGRAVITY_SHARED_RUNTIME_SYMBOL] = prevSlot;
		});

		const eventHandlers = new Map<string, Array<(ev: unknown, ctx: unknown) => void>>();
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const notes: string[] = [];
		const notifications: Array<{ msg: string; level: string }> = [];
		const statuses: Array<{ key: string; value: string | undefined }> = [];
		const selectResponses: Array<string | undefined> = [];
		const inputResponses: Array<string | undefined> = [];

		const pi = {
			on(name: string, fn: (ev: unknown, ctx: unknown) => void) {
				const list = eventHandlers.get(name) ?? [];
				list.push(fn);
				eventHandlers.set(name, list);
			},
			registerCommand(
				name: string,
				def: { handler: (args: string, ctx: unknown) => Promise<void> },
			) {
				commands.set(name, def.handler);
			},
			sendMessage(msg: { content: string }) {
				notes.push(msg.content);
			},
		};

		const ctx = {
			model: { id: "gemini-4-hydrogen-high", provider: "antigravity-acp" },
			sessionManager: { getSessionId: () => "session-cmd-1" },
			ui: {
				setStatus(key: string, value: string | undefined) {
					statuses.push({ key, value });
				},
				notify(msg: string, level: string) {
					notifications.push({ msg, level });
				},
				async select() {
					return selectResponses.shift();
				},
				async input() {
					return inputResponses.shift();
				},
			},
		};

		const { ensureHook } = registerAntigravityAccountPool(pi as never, pool);

		return {
			notes,
			notifications,
			statuses,
			selectResponses,
			inputResponses,
			ensureHook,
			run: async (args: string) => {
				const handler = commands.get("gemini-accounts");
				if (!handler) throw new Error("command not registered");
				await handler(args, ctx);
			},
		};
	}

	it("supports use, use auto, order, remove, and reset subcommands", async () => {
		const root = makeTempDir();
		const primaryHome = join(root, "primary");
		const accountsDir = join(root, "accounts");
		const stateFile = join(accountsDir, "state.json");
		writeToken(primaryHome, "tok-1");
		writeToken(join(accountsDir, "pro2"), "tok-2");

		const prevPrimary = process.env.ACB_ANTIGRAVITY_PRIMARY_HOME;
		const prevDir = process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR;
		const prevState = process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE;
		process.env.ACB_ANTIGRAVITY_PRIMARY_HOME = primaryHome;
		process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR = accountsDir;
		process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE = stateFile;
		cleanups.push(() => {
			if (prevPrimary === undefined) delete process.env.ACB_ANTIGRAVITY_PRIMARY_HOME;
			else process.env.ACB_ANTIGRAVITY_PRIMARY_HOME = prevPrimary;
			if (prevDir === undefined) delete process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR;
			else process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR = prevDir;
			if (prevState === undefined) delete process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE;
			else process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE = prevState;
		});

		const closedSessions: string[] = [];
		const runtime: AntigravityRuntimeLike = {
			connectionFactory: () => ({ closed: false }),
			stream: () => ({ stream: createAssistantMessageEventStream() }),
			async closeSession(sid) {
				closedSessions.push(sid);
			},
		};

		const pool = new AccountPool({ primaryHome, accountsDir, stateFile });
		const h = setupCommandHarness(pool, runtime);

		await h.run("use pro2");
		expect(pool.state().preferred).toBe("pro2");
		expect(closedSessions).toEqual(["session-cmd-1"]);
		expect(h.statuses.at(-1)).toEqual({ key: "gemini-account", value: "Gemini: pro2" });

		await h.run("use auto");
		expect(pool.state().preferred).toBeUndefined();
		expect(h.statuses.at(-1)).toEqual({ key: "gemini-account", value: "Gemini: primary" });

		await h.run("order pro2 primary");
		expect(pool.orderedAccounts().map((a) => a.label)).toEqual(["pro2", "primary"]);

		pool.markFailure("pro2", "gemini-4-hydrogen-high", "Usage Limit Reached");
		expect(pool.activeCooldown("pro2", "gemini")).toBeDefined();
		await h.run("reset");
		expect(pool.activeCooldown("pro2", "gemini")).toBeUndefined();

		await h.run("remove pro2");
		expect(pool.accounts().map((a) => a.label)).toEqual(["primary"]);
		expect(existsSync(join(accountsDir, "pro2"))).toBe(false);
	});

	it("handles /gemini-accounts login in an isolated slot and rejects duplicate Google accounts", async () => {
		const root = makeTempDir();
		const primaryHome = join(root, "primary");
		const accountsDir = join(root, "accounts");
		const stateFile = join(accountsDir, "state.json");
		writeToken(primaryHome, "tok-primary");

		const prevPrimary = process.env.ACB_ANTIGRAVITY_PRIMARY_HOME;
		const prevDir = process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR;
		const prevState = process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE;
		process.env.ACB_ANTIGRAVITY_PRIMARY_HOME = primaryHome;
		process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR = accountsDir;
		process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE = stateFile;
		cleanups.push(() => {
			if (prevPrimary === undefined) delete process.env.ACB_ANTIGRAVITY_PRIMARY_HOME;
			else process.env.ACB_ANTIGRAVITY_PRIMARY_HOME = prevPrimary;
			if (prevDir === undefined) delete process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR;
			else process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR = prevDir;
			if (prevState === undefined) delete process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE;
			else process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE = prevState;
		});

		let tokenToWrite = "tok-primary";
		const runtime: AntigravityRuntimeLike = {
			connectionFactory: (opts) =>
				({ closed: false, env: opts?.env }) as unknown as Record<string, unknown>,
			stream: () => ({ stream: createAssistantMessageEventStream() }),
			async loginGoogle(_signal, _onProgress, manual) {
				const conn = runtime.connectionFactory!({}) as unknown as { env?: NodeJS.ProcessEnv };
				const targetHome = conn.env?.GEMINI_HOME;
				expect(targetHome).toBe(join(accountsDir, "pro2"));
				manual?.showAuthorizationUrl(
					"https://accounts.google.com/o/oauth2/v2/auth?test=1",
					"Open link",
				);
				const callback = await manual?.promptForCallback(new AbortController().signal);
				expect(callback).toBe("http://127.0.0.1:9999/?code=abc");
				writeToken(targetHome!, tokenToWrite);
			},
		};

		const pool = new AccountPool({ primaryHome, accountsDir, stateFile });
		const h = setupCommandHarness(pool, runtime);

		// 1. Logging in the same Google account cleans up the slot and warns instead of adding duplicate.
		h.inputResponses.push("http://127.0.0.1:9999/?code=abc");
		await h.run("login pro2");
		expect(
			h.notes.some((n) =>
				n.includes("[Open Google Sign-In](https://accounts.google.com/o/oauth2/v2/auth?test=1)"),
			),
		).toBe(true);
		expect(h.notes.some((n) => n.includes("same Google account as **primary**"))).toBe(true);
		expect(existsSync(join(accountsDir, "pro2"))).toBe(false);

		// 2. Logging in a distinct Google account keeps the slot and makes it available to the pool.
		tokenToWrite = "tok-pro2-unique";
		h.inputResponses.push("http://127.0.0.1:9999/?code=abc");
		await h.run("login pro2");
		expect(pool.accounts().map((a) => a.label)).toEqual(["primary", "pro2"]);
		expect(h.notes.some((n) => n.includes("Signed in **pro2**"))).toBe(true);
	});
});
