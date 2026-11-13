import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	CCPA_BASE_URL_ENV,
	CCPA_PROXY_MANAGED_ENV,
	registerAntigravityThinking,
} from "../extensions/antigravity-thinking/index.js";
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
						thinkingConfig: { thinkingLevel: "HIGH" },
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
						thinkingConfig: { thinkingLevel: "LOW" },
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
});

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
