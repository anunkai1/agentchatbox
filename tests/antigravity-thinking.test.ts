import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CcpaThinkingProxy,
	CONSUMER_CCPA_BASE_URL,
	extractDiscoveredThinkingLevels,
	PROD_CCPA_BASE_URL,
	resolveThinkingLevelFromModelId,
	rewriteCcpaGeneratePayload,
	startCcpaThinkingProxy,
} from "../extensions/antigravity-thinking/proxy.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const fn = cleanups.pop();
		if (fn) await fn();
	}
});

function startMockUpstream(
	handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer | string) => {
				chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			});
			req.on("end", () => handler(req, Buffer.concat(chunks), res));
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("failed to bind mock upstream"));
				return;
			}
			const url = `http://127.0.0.1:${addr.port}`;
			const close = () =>
				new Promise<void>((resClose) => {
					server.close(() => resClose());
					server.closeAllConnections?.();
				});
			cleanups.push(close);
			resolve({ url, close });
		});
	});
}

describe("antigravity-thinking model mapping", () => {
	it("maps Gemini 3+ effort suffixes to uppercase thinkingLevel names", () => {
		expect(resolveThinkingLevelFromModelId("gemini-4-hydrogen-low")).toBe("LOW");
		expect(resolveThinkingLevelFromModelId("gemini-4-hydrogen-medium")).toBe("MEDIUM");
		expect(resolveThinkingLevelFromModelId("gemini-4-hydrogen-high")).toBe("HIGH");
		expect(resolveThinkingLevelFromModelId("gemini-4-hydrogen-xhigh")).toBe("XHIGH");
		expect(resolveThinkingLevelFromModelId("gemini-3.8-flash-low")).toBe("LOW");
		expect(resolveThinkingLevelFromModelId("gemini-3.8-flash-high")).toBe("HIGH");
		expect(resolveThinkingLevelFromModelId("gemini-4-argon-medium")).toBe("MEDIUM");
		expect(resolveThinkingLevelFromModelId("gemini-3.1-pro-low")).toBe("LOW");
		expect(resolveThinkingLevelFromModelId("gemini-3-pro-minimal")).toBe("MINIMAL");
	});

	it("ignores non-Gemini-3+, image, and un-suffixed models", () => {
		expect(resolveThinkingLevelFromModelId("gemini-2.5-flash")).toBeUndefined();
		expect(resolveThinkingLevelFromModelId("gemini-2.5-pro")).toBeUndefined();
		expect(resolveThinkingLevelFromModelId("gemini-3.1-flash-image")).toBeUndefined();
		expect(resolveThinkingLevelFromModelId("gemini-pro-agent")).toBeUndefined();
		expect(resolveThinkingLevelFromModelId("gpt-oss-120b-medium")).toBeUndefined();
		expect(resolveThinkingLevelFromModelId("claude-opus-5-5-high")).toBeUndefined();
	});

	it("extracts thinking levels from fetchAvailableModels for Gemini 3+ models only", () => {
		const levels = extractDiscoveredThinkingLevels({
			models: {
				"gemini-4-hydrogen-xhigh": { thinkingLevel: 100 },
				"gemini-4-hydrogen-low": { thinkingLevel: 1 },
				"gemini-3.8-flash-tiered": { thinkingLevel: 3 },
				"gemini-3-flash": { thinkingLevel: 3 },
				"gemini-3.1-flash-lite": { thinkingLevel: 1 },
				"gemini-3.1-flash-image": { thinkingLevel: null },
				"gemini-2.5-flash": { thinkingLevel: 1 },
				"claude-opus-5-5-high": { thinkingLevel: 3 },
				"gpt-oss-120b-medium": {},
			},
		});

		expect(levels.get("gemini-4-hydrogen-xhigh")).toBe("XHIGH");
		expect(levels.get("gemini-4-hydrogen-low")).toBe("LOW");
		expect(levels.get("gemini-3.8-flash-tiered")).toBe("HIGH");
		expect(levels.get("gemini-3-flash")).toBe("HIGH");
		expect(levels.get("gemini-3.1-flash-lite")).toBe("LOW");
		expect(levels.has("gemini-3.1-flash-image")).toBe(false);
		expect(levels.has("gemini-2.5-flash")).toBe(false);
		expect(levels.has("claude-opus-5-5-high")).toBe(false);
	});
});

describe("rewriteCcpaGeneratePayload", () => {
	it("injects thinkingConfig.thinkingLevel while preserving existing generationConfig fields", () => {
		const input = {
			project: "aicode-consumers",
			model: "gemini-4-hydrogen-xhigh",
			request: {
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
				generationConfig: {
					maxOutputTokens: 65535,
					thinkingConfig: { includeThoughts: true },
				},
			},
		};
		const { rewritten, changed, thinkingLevel } = rewriteCcpaGeneratePayload(input);
		expect(changed).toBe(true);
		expect(thinkingLevel).toBe("XHIGH");
		expect(rewritten).toEqual({
			project: "aicode-consumers",
			model: "gemini-4-hydrogen-xhigh",
			request: {
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
				generationConfig: {
					maxOutputTokens: 65535,
					thinkingConfig: { includeThoughts: true, thinkingLevel: "XHIGH" },
				},
			},
		});
	});

	it("injects includeThoughts: true when thinkingConfig is omitted, and preserves explicit includeThoughts: false", () => {
		const omitted = {
			project: "aicode-consumers",
			model: "gemini-4-neon-high",
			request: {
				generationConfig: { maxOutputTokens: 65536 },
			},
		};
		const omittedResult = rewriteCcpaGeneratePayload(omitted);
		expect(omittedResult.changed).toBe(true);
		expect(omittedResult.thinkingLevel).toBe("HIGH");
		expect(omittedResult.rewritten).toEqual({
			project: "aicode-consumers",
			model: "gemini-4-neon-high",
			request: {
				generationConfig: {
					maxOutputTokens: 65536,
					thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
				},
			},
		});

		const explicitFalse = {
			project: "aicode-consumers",
			model: "gemini-4-neon-high",
			request: {
				generationConfig: {
					maxOutputTokens: 65536,
					thinkingConfig: { includeThoughts: false },
				},
			},
		};
		const falseResult = rewriteCcpaGeneratePayload(explicitFalse);
		expect(falseResult.changed).toBe(true);
		expect(falseResult.rewritten).toEqual({
			project: "aicode-consumers",
			model: "gemini-4-neon-high",
			request: {
				generationConfig: {
					maxOutputTokens: 65536,
					thinkingConfig: { includeThoughts: false, thinkingLevel: "HIGH" },
				},
			},
		});
	});

	it("preserves explicit thinkingLevel or thinkingBudget if already set", () => {
		const withLevel = {
			project: "aicode-consumers",
			model: "gemini-4-hydrogen-xhigh",
			request: {
				generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
			},
		};
		expect(rewriteCcpaGeneratePayload(withLevel).changed).toBe(false);

		const withBudget = {
			project: "aicode-consumers",
			model: "gemini-4-hydrogen-high",
			request: {
				generationConfig: { thinkingConfig: { thinkingBudget: 2048 } },
			},
		};
		expect(rewriteCcpaGeneratePayload(withBudget).changed).toBe(false);
	});
});

describe("startCcpaThinkingProxy", () => {
	it("injects thinkingLevel on streamGenerateContent, taps fetchAvailableModels, and streams SSE", async () => {
		const seenBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
		const upstream = await startMockUpstream((req, raw, res) => {
			const url = req.url ?? "/";
			const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
			seenBodies.push({ path: url, body: parsed });

			if (url.startsWith("/v1internal:fetchAvailableModels")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						models: {
							"gemini-3.8-flash-tiered": { thinkingLevel: 3 },
							"gemini-4-hydrogen-low": { thinkingLevel: 1 },
							"gemini-4-hydrogen-xhigh": { thinkingLevel: 100 },
						},
					}),
				);
				return;
			}

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			res.write('data: {"response":{"candidates":[]}}\n\n');
			res.end('data: {"response":{"done":true}}\n\n');
		});

		const proxy = await startCcpaThinkingProxy({ upstreamBaseUrl: upstream.url });
		cleanups.push(() => proxy.close());

		// 1. Discovery call populates discoveredLevels.
		const discRes = await fetch(`${proxy.url}/v1internal:fetchAvailableModels?alt=json`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer tok" },
			body: JSON.stringify({ project: "aicode-consumers" }),
		});
		expect(discRes.status).toBe(200);
		await discRes.json();

		// 2. Discovered non-suffix model (`gemini-3.8-flash-tiered`) gets HIGH injected.
		const tieredRes = await fetch(`${proxy.url}/v1internal:streamGenerateContent?alt=sse`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer tok" },
			body: JSON.stringify({
				project: "aicode-consumers",
				model: "gemini-3.8-flash-tiered",
				request: { generationConfig: { maxOutputTokens: 65535 } },
			}),
		});
		expect(tieredRes.status).toBe(200);
		expect(await tieredRes.text()).toContain('"done":true');

		// 3. Suffix model (`gemini-4-hydrogen-low`) gets LOW injected.
		const lowRes = await fetch(`${proxy.url}/v1internal:generateContent`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer tok" },
			body: JSON.stringify({
				project: "aicode-consumers",
				model: "gemini-4-hydrogen-low",
				request: { generationConfig: { maxOutputTokens: 65535 } },
			}),
		});
		expect(lowRes.status).toBe(200);

		expect(seenBodies[1]).toEqual({
			path: "/v1internal:streamGenerateContent?alt=sse",
			body: {
				project: "aicode-consumers",
				model: "gemini-3.8-flash-tiered",
				request: {
					generationConfig: {
						maxOutputTokens: 65535,
						thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
					},
				},
			},
		});
		expect(seenBodies[2]).toEqual({
			path: "/v1internal:generateContent",
			body: {
				project: "aicode-consumers",
				model: "gemini-4-hydrogen-low",
				request: {
					generationConfig: {
						maxOutputTokens: 65535,
						thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" },
					},
				},
			},
		});
	});

	it("returns 502 when upstream is unreachable", async () => {
		const proxy = await startCcpaThinkingProxy({ upstreamBaseUrl: "http://127.0.0.1:1" });
		cleanups.push(() => proxy.close());

		const res = await fetch(`${proxy.url}/v1internal:generateContent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: "aicode-consumers",
				model: "gemini-4-hydrogen-high",
				request: {},
			}),
		});
		expect(res.status).toBe(502);
		const json = (await res.json()) as { error?: { code?: number } };
		expect(json.error?.code).toBe(502);
	});

	it("does not dispatch an upstream request if the client aborts while resolveUpstream is pending", async () => {
		let upstreamHits = 0;
		const upstream = await startMockUpstream((_req, _body, res) => {
			upstreamHits += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});

		let resolveGate!: () => void;
		let lookupStarted!: () => void;
		const lookupStartedPromise = new Promise<void>((r) => {
			lookupStarted = r;
		});
		const proxy = await startCcpaThinkingProxy({
			resolveUpstreamBaseUrl: async () => {
				lookupStarted();
				await new Promise<void>((r) => {
					resolveGate = r;
				});
				return upstream.url;
			},
		});
		cleanups.push(() => proxy.close());

		const ac = new AbortController();
		const reqPromise = fetch(`${proxy.url}/v1internal:generateContent`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer tok" },
			body: JSON.stringify({ project: "proj-1", model: "gemini-4-hydrogen-high", request: {} }),
			signal: ac.signal,
		}).catch((err) => err);

		await lookupStartedPromise;
		ac.abort();
		const result = await reqPromise;
		expect(result).toBeInstanceOf(Error);

		// Give the server socket close event a turn on the event loop before resolving lookup.
		await new Promise((r) => setTimeout(r, 25));
		resolveGate();
		await new Promise((r) => setTimeout(r, 25));
		expect(upstreamHits).toBe(0);
	});

	it("does not permanently cache transient loadCodeAssist failures onto the consumer endpoint", async () => {
		let loadCodeAssistHits = 0;
		let loadCodeAssistMode: "429" | "invalid-json" | "timeout" | "paid" | "consumer" = "429";
		let prodGenerateHits = 0;
		let consumerGenerateHits = 0;

		const mockProd = await startMockUpstream((req, _body, res) => {
			if (req.url === "/v1internal:loadCodeAssist") {
				loadCodeAssistHits += 1;
				if (loadCodeAssistMode === "429") {
					res.writeHead(429, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }));
					return;
				}
				if (loadCodeAssistMode === "invalid-json") {
					res.writeHead(200, { "content-type": "application/json" });
					res.end("{truncated");
					return;
				}
				if (loadCodeAssistMode === "timeout") {
					// Hang longer than loadCodeAssistTimeoutMs without answering.
					setTimeout(() => {
						if (!res.destroyed && !res.writableEnded) {
							res.writeHead(200);
							res.end("{}");
						}
					}, 200);
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify(
						loadCodeAssistMode === "paid"
							? { paidTier: { usesGcpTos: true } }
							: { cloudaicompanionProject: "p" },
					),
				);
				return;
			}
			prodGenerateHits += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ target: "prod" }));
		});

		const mockConsumer = await startMockUpstream((_req, _body, res) => {
			consumerGenerateHits += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ target: "consumer" }));
		});

		const proxy = await startCcpaThinkingProxy({
			prodBaseUrl: mockProd.url,
			consumerBaseUrl: mockConsumer.url,
			loadCodeAssistTimeoutMs: 40,
		});
		cleanups.push(() => proxy.close());

		const sendGenerate = (auth: string, project = "workspace-proj") =>
			fetch(`${proxy.url}/v1internal:generateContent`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: auth },
				body: JSON.stringify({ project, model: "gemini-4-hydrogen-high", request: {} }),
			});

		// 1. 429 on loadCodeAssist falls back once without caching consumerBaseUrl.
		loadCodeAssistMode = "429";
		expect(await (await sendGenerate("Bearer paid-1")).json()).toEqual({ target: "consumer" });
		expect(loadCodeAssistHits).toBe(1);

		// 2. Subsequent 200 invalid-json also must not cache.
		loadCodeAssistMode = "invalid-json";
		expect(await (await sendGenerate("Bearer paid-1")).json()).toEqual({ target: "consumer" });
		expect(loadCodeAssistHits).toBe(2);

		// 3. Subsequent timeout also must not cache.
		loadCodeAssistMode = "timeout";
		expect(await (await sendGenerate("Bearer paid-1")).json()).toEqual({ target: "consumer" });
		expect(loadCodeAssistHits).toBe(3);

		// 4. Recovery to authoritative 200 routes to prod and caches it.
		loadCodeAssistMode = "paid";
		expect(await (await sendGenerate("Bearer paid-1")).json()).toEqual({ target: "prod" });
		expect(loadCodeAssistHits).toBe(4);
		expect(prodGenerateHits).toBe(1);

		// 5. Repeat call reuses cached prod without hitting loadCodeAssist again.
		expect(await (await sendGenerate("Bearer paid-1")).json()).toEqual({ target: "prod" });
		expect(loadCodeAssistHits).toBe(4);
		expect(prodGenerateHits).toBe(2);

		// 6. Authoritative 200 without usesGcpTos caches consumer for a different token.
		loadCodeAssistMode = "consumer";
		expect(await (await sendGenerate("Bearer free-1")).json()).toEqual({ target: "consumer" });
		expect(await (await sendGenerate("Bearer free-1")).json()).toEqual({ target: "consumer" });
		expect(loadCodeAssistHits).toBe(5);
		expect(consumerGenerateHits).toBe(5);
	});
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CCPA_BASE_URL_ENV,
	CCPA_PROXY_MANAGED_ENV,
	MODELS_REFRESH_PROBE_ENV,
	patchAntigravityRuntime,
	registerAntigravityThinking,
	registerLazyAntigravityThinking,
	selectAuthoritativeAcpModels,
} from "../extensions/antigravity-thinking/index.js";
import {
	ANTIGRAVITY_API,
	ANTIGRAVITY_BASE_URL,
	ANTIGRAVITY_PROVIDER_ID,
	readAntigravityModelsCache,
	writeAntigravityModelsCache,
} from "../extensions/antigravity-thinking/models-cache.js";

describe("registerAntigravityThinking lifecycle", () => {
	function mockPi() {
		let onShutdown: (() => Promise<void> | void) | undefined;
		const pi = {
			on(event: string, handler: () => Promise<void> | void) {
				if (event === "session_shutdown") onShutdown = handler;
			},
		};
		return {
			pi: pi as never,
			shutdown: async () => {
				if (onShutdown) await onShutdown();
			},
		};
	}

	it("sets AGY_ACP_CCPA_BASE_URL and restores it on session_shutdown", async () => {
		const env: NodeJS.ProcessEnv = {};
		const { pi, shutdown } = mockPi();
		const proxy = await registerAntigravityThinking(pi, { env });
		cleanups.push(() => proxy.close());

		expect(env[CCPA_BASE_URL_ENV]).toBe(proxy.url);
		expect(env[CCPA_PROXY_MANAGED_ENV]).toBe("1");

		await shutdown();
		expect(env[CCPA_BASE_URL_ENV]).toBeUndefined();
		expect(env[CCPA_PROXY_MANAGED_ENV]).toBeUndefined();
	});

	it("forwards to an external AGY_ACP_CCPA_BASE_URL and restores it on shutdown", async () => {
		const seenOpts: Array<Record<string, unknown>> = [];
		const env: NodeJS.ProcessEnv = {
			[CCPA_BASE_URL_ENV]: PROD_CCPA_BASE_URL,
		};
		const { pi, shutdown } = mockPi();
		const proxy = await registerAntigravityThinking(pi, {
			env,
			startProxy: async (opts) => {
				seenOpts.push(opts as Record<string, unknown>);
				return {
					url: "http://127.0.0.1:44444",
					discoveredLevels: new Map(),
					close: async () => {},
				} satisfies CcpaThinkingProxy;
			},
		});

		expect(seenOpts).toEqual([{ upstreamBaseUrl: PROD_CCPA_BASE_URL }]);
		expect(env[CCPA_BASE_URL_ENV]).toBe(proxy.url);
		await shutdown();
		expect(env[CCPA_BASE_URL_ENV]).toBe(PROD_CCPA_BASE_URL);
		expect(env[CCPA_PROXY_MANAGED_ENV]).toBeUndefined();
	});

	it("does not chain onto an inherited managed parent proxy", async () => {
		const seenOpts: Array<Record<string, unknown>> = [];
		const env: NodeJS.ProcessEnv = {
			[CCPA_BASE_URL_ENV]: "http://127.0.0.1:39999",
			[CCPA_PROXY_MANAGED_ENV]: "1",
		};
		const { pi, shutdown } = mockPi();
		const proxy = await registerAntigravityThinking(pi, {
			env,
			startProxy: async (opts) => {
				seenOpts.push(opts as Record<string, unknown>);
				return {
					url: "http://127.0.0.1:45555",
					discoveredLevels: new Map(),
					close: async () => {},
				};
			},
		});

		expect(seenOpts).toEqual([{}]);
		expect(env[CCPA_BASE_URL_ENV]).toBe(proxy.url);
		expect(CONSUMER_CCPA_BASE_URL).toBe("https://daily-cloudcode-pa.googleapis.com");
		await shutdown();
		expect(env[CCPA_BASE_URL_ENV]).toBe("http://127.0.0.1:39999");
		expect(env[CCPA_PROXY_MANAGED_ENV]).toBe("1");
	});
});

describe("registerLazyAntigravityThinking & models-cache", () => {
	function makeTempCacheFile(): string {
		const dir = mkdtempSync(join(tmpdir(), "acb-agy-cache-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		return join(dir, "models-cache.json");
	}

	function harness() {
		const handlers = new Map<
			string,
			Array<(event: unknown, ctx: unknown) => Promise<void> | void>
		>();
		const registered: Array<{
			providerId?: string;
			config?: Record<string, unknown>;
			provider?: Record<string, unknown>;
		}> = [];
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerProvider(
				providerOrId: string | Record<string, unknown>,
				config?: Record<string, unknown>,
			) {
				if (typeof providerOrId === "string") {
					registered.push({ providerId: providerOrId, config });
				} else {
					registered.push({ provider: providerOrId });
				}
			},
		};
		const emit = async (eventName: string, event: unknown, ctx: unknown) => {
			for (const handler of handlers.get(eventName) ?? []) {
				await handler(event, ctx);
			}
		};
		return { pi: pi as never, emit, registered };
	}

	it("does not start the thinking proxy on non-Gemini sessions and activates lazily on switch", async () => {
		const cachePath = makeTempCacheFile();
		const env: NodeJS.ProcessEnv = {};
		let starts = 0;
		let closes = 0;
		const { pi, emit } = harness();

		const handle = registerLazyAntigravityThinking(pi, {
			env,
			cachePath,
			argv: ["node", "pi", "--offline"],
			startProxy: async () => {
				starts += 1;
				return {
					url: "http://127.0.0.1:46666",
					discoveredLevels: new Map(),
					close: async () => {
						closes += 1;
					},
				};
			},
		});

		expect(starts).toBe(0);
		expect(handle.isStarted()).toBe(false);

		// Non-Gemini session_start + before_agent_start: zero proxies started.
		await emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			{ model: { provider: "venice" } },
		);
		await emit(
			"before_agent_start",
			{ type: "before_agent_start" },
			{ model: { provider: "venice" } },
		);
		expect(starts).toBe(0);
		expect(env[CCPA_BASE_URL_ENV]).toBeUndefined();

		// Switching mid-session to antigravity-acp starts exactly one proxy.
		await emit(
			"model_select",
			{ type: "model_select", model: { provider: "antigravity-acp" } },
			{},
		);
		await emit(
			"before_agent_start",
			{ type: "before_agent_start" },
			{ model: { provider: "antigravity-acp" } },
		);
		expect(starts).toBe(1);
		expect(handle.isStarted()).toBe(true);
		expect(env[CCPA_BASE_URL_ENV]).toBe("http://127.0.0.1:46666");

		await emit("session_shutdown", { type: "session_shutdown" }, {});
		expect(closes).toBe(1);
		expect(env[CCPA_BASE_URL_ENV]).toBeUndefined();
	});

	it("loads cached antigravity models into native provider on startup and refreshes on probe", async () => {
		const cachePath = makeTempCacheFile();
		const sampleModel = {
			id: "gemini-5-alpha",
			name: "Gemini 5 Alpha",
			reasoning: true,
			thinkingLevelMap: { low: "gemini-5-alpha-low", high: "gemini-5-alpha-high" },
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65_536,
		};

		// 1. Refresh probe populates cache without overlaying old cache.
		const envProbe: NodeJS.ProcessEnv = { [MODELS_REFRESH_PROBE_ENV]: "1" };
		const probeHarness = harness();
		let refreshOpts: Record<string, unknown> | undefined;
		registerLazyAntigravityThinking(probeHarness.pi, {
			env: envProbe,
			cachePath,
			startProxy: async () => ({
				url: "http://127.0.0.1:47777",
				discoveredLevels: new Map(),
				close: async () => {},
			}),
		});
		expect(probeHarness.registered).toHaveLength(0);

		await probeHarness.emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			{
				model: { provider: "zai" },
				modelRegistry: {
					refresh: async (opts: Record<string, unknown>) => {
						refreshOpts = opts;
						return { aborted: false, errors: new Map() };
					},
					getModelsOfType: (type: string, provider?: string) =>
						type === "chat" && provider === ANTIGRAVITY_PROVIDER_ID ? [sampleModel] : [],
				},
			},
		);
		expect(refreshOpts).toMatchObject({ providers: [ANTIGRAVITY_PROVIDER_ID], allowNetwork: true });
		expect(readAntigravityModelsCache(cachePath)).toHaveLength(1);
		expect(JSON.parse(readFileSync(cachePath, "utf8")).models[0].id).toBe("gemini-5-alpha");

		// 2. Subsequent offline child wraps native provider synchronously while preserving auth/stream.
		const sharedSym = Symbol.for("pi-antigravity-acp:runtime");
		const slots = globalThis as Record<symbol, unknown>;
		const prevShared = slots[sharedSym];
		let liveModels = [{ id: "fallback-model", provider: ANTIGRAVITY_PROVIDER_ID }];
		const fakeStream = () => "stream-ok";
		const fakeAuth = { oauth: { name: "Google" } };
		slots[sharedSym] = {
			provider: {
				id: ANTIGRAVITY_PROVIDER_ID,
				name: "Google Antigravity (ACP)",
				auth: fakeAuth,
				streamSimple: fakeStream,
				getModels: () => liveModels,
			},
		};
		cleanups.push(() => {
			if (prevShared === undefined) delete slots[sharedSym];
			else slots[sharedSym] = prevShared;
		});

		const offlineHarness = harness();
		registerLazyAntigravityThinking(offlineHarness.pi, {
			env: {},
			cachePath,
			argv: ["node", "pi", "--offline"],
		});
		expect(offlineHarness.registered).toHaveLength(1);
		const wrapped = offlineHarness.registered[0]?.provider as {
			id: string;
			auth: unknown;
			streamSimple: unknown;
			getModels: () => Array<{ id: string; provider: string; baseUrl: string; api: string }>;
		};
		expect(wrapped.id).toBe(ANTIGRAVITY_PROVIDER_ID);
		expect(wrapped.auth).toBe(fakeAuth);
		expect(wrapped.streamSimple).toBe(fakeStream);
		expect(wrapped.getModels()).toEqual([
			{
				...sampleModel,
				provider: ANTIGRAVITY_PROVIDER_ID,
				api: ANTIGRAVITY_API,
				baseUrl: ANTIGRAVITY_BASE_URL,
			},
		]);

		// If a later refresh publishes a new array, getModels() seamlessly yields the fresh models.
		liveModels = [{ id: "gemini-6-live", provider: ANTIGRAVITY_PROVIDER_ID }];
		expect(wrapped.getModels().map((m) => m.id)).toEqual(["gemini-6-live"]);

		// Idempotent write skips rewrite when models haven't changed.
		expect(writeAntigravityModelsCache([sampleModel], cachePath)).toBe(false);
	});
});

describe("patchAntigravityRuntime & selectAuthoritativeAcpModels", () => {
	const baseConfigOptions = [
		{
			id: "model",
			type: "select",
			category: "model",
			currentValue: "gemini-3.8-flash",
			options: [
				{ value: "gemini-4-neon", name: "Gemini 4 Neon" },
				{ value: "gemini-4-argon", name: "Gemini 4 Argon" },
				{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
				{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
			],
		},
		{
			id: "thinking_level",
			type: "select",
			category: "thought_level",
			currentValue: "high",
			options: [
				{ value: "low", name: "Low" },
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
			],
		},
	];

	const rawAvailable = [
		{ modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
		{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
		{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
		{ modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
		{ modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
		{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
		{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
		{ modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
		{ modelId: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
		{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
		{ modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
		{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
		{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
		{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
	];

	const synthesizedFallback = rawAvailable.filter((m) => !m.modelId.endsWith("-xhigh"));

	it("preserves per-model variants like Neon/Hydrogen xhigh from models.availableModels", () => {
		const resolved = selectAuthoritativeAcpModels(
			{
				models: { currentModelId: "gemini-3.8-flash-high", availableModels: rawAvailable },
				configOptions: baseConfigOptions,
			},
			synthesizedFallback,
		);
		expect(resolved.map((m) => m.modelId)).toEqual(rawAvailable.map((m) => m.modelId));
	});

	it("falls back when models.availableModels is missing, duplicated, or mismatched", () => {
		expect(selectAuthoritativeAcpModels(undefined, synthesizedFallback)).toEqual(
			synthesizedFallback,
		);
		expect(
			selectAuthoritativeAcpModels(
				{
					models: {
						availableModels: [...rawAvailable, rawAvailable[0]!],
					},
					configOptions: baseConfigOptions,
				},
				synthesizedFallback,
			),
		).toEqual(synthesizedFallback);
		expect(
			selectAuthoritativeAcpModels(
				{
					models: {
						availableModels: [...rawAvailable, { modelId: "gemini-unknown-high", name: "Unknown" }],
					},
					configOptions: baseConfigOptions,
				},
				synthesizedFallback,
			),
		).toEqual(synthesizedFallback);
	});

	it("patches discoverModels and pre-switches base model before setting xhigh", async () => {
		const setModelCalls: string[] = [];
		const state = {
			models: { currentModelId: "gemini-3.8-flash-high", availableModels: rawAvailable },
			configOptions: structuredClone(baseConfigOptions),
		};

		const fakeRuntime = {
			connectionFactory: () => ({
				newSession: async () => state,
				getSessionState: () => state,
				setModel: async (_sessionId: string, modelId: string) => {
					setModelCalls.push(modelId);
					if (modelId === "gemini-4-neon") {
						state.configOptions[0]!.currentValue = "gemini-4-neon";
						state.configOptions[1]!.options = [
							{ value: "low", name: "Low" },
							{ value: "medium", name: "Medium" },
							{ value: "high", name: "High" },
							{ value: "xhigh", name: "Extra" },
						];
					} else if (modelId === "gemini-4-neon-xhigh") {
						if (!state.configOptions[1]!.options.some((o) => o.value === "xhigh")) {
							throw new Error("xhigh not in thought_level options");
						}
						state.configOptions[1]!.currentValue = "xhigh";
					}
				},
			}),
			discoverModels: async () => {
				const conn = fakeRuntime.connectionFactory({});
				await conn.newSession();
				return synthesizedFallback;
			},
		};

		expect(patchAntigravityRuntime(fakeRuntime)).toBe(true);
		expect(patchAntigravityRuntime(fakeRuntime)).toBe(false);

		const discovered = await fakeRuntime.discoverModels();
		expect(discovered.map((m) => m.modelId)).toContain("gemini-4-neon-xhigh");
		expect(discovered.map((m) => m.modelId)).toContain("gemini-4-hydrogen-xhigh");
		expect(discovered.map((m) => m.modelId)).not.toContain("gemini-4-argon-xhigh");

		// Pre-switches to gemini-4-neon so xhigh enters thought_level options, then applies xhigh.
		const conn = fakeRuntime.connectionFactory({});
		await conn.setModel("sid-1", "gemini-4-neon-xhigh");
		expect(setModelCalls).toEqual(["gemini-4-neon", "gemini-4-neon-xhigh"]);

		// Once xhigh is already in thought_level options, no extra pre-switch is issued.
		setModelCalls.length = 0;
		await conn.setModel("sid-1", "gemini-4-hydrogen-xhigh");
		expect(setModelCalls).toEqual(["gemini-4-hydrogen-xhigh"]);
	});
});
