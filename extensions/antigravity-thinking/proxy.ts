import { createHash } from "node:crypto";
import {
	createServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export const CONSUMER_CCPA_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const PROD_CCPA_BASE_URL = "https://cloudcode-pa.googleapis.com";
export const CONSUMER_PROJECT_ID = "aicode-consumers";

export type ThinkingLevelName = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";

const GEMINI_3_PLUS_PREFIX = /^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/i;
const GEMINI_3_PLUS_EFFORT_SUFFIX =
	/^gemini-(?:[3-9]|\d{2,})(?:[.-][a-z0-9]+)*-(minimal|low|medium|high|xhigh)$/i;

const NUMERIC_THINKING_LEVELS: Readonly<Record<number, ThinkingLevelName>> = {
	1: "LOW",
	2: "MEDIUM",
	3: "HIGH",
	100: "XHIGH",
};

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
	"host",
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"content-length",
	"accept-encoding",
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

const MAX_DISCOVERY_BODY_BYTES = 4 * 1024 * 1024;
const LOAD_CODE_ASSIST_TIMEOUT_MS = 10_000;

export interface CcpaThinkingProxyOptions {
	/** Fixed upstream CCPA base URL (skips per-project consumer/prod detection). */
	upstreamBaseUrl?: string;
	/** Custom upstream resolver hook (used in tests). */
	resolveUpstreamBaseUrl?: (info: {
		project?: string;
		authorization?: string;
		userAgent?: string;
	}) => Promise<string>;
}

export interface CcpaThinkingProxy {
	readonly url: string;
	readonly discoveredLevels: ReadonlyMap<string, ThinkingLevelName>;
	close(): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isGemini3PlusModel(modelId: string): boolean {
	return GEMINI_3_PLUS_PREFIX.test(modelId.trim());
}

export function resolveThinkingLevelFromModelId(modelId: string): ThinkingLevelName | undefined {
	const match = GEMINI_3_PLUS_EFFORT_SUFFIX.exec(modelId.trim());
	if (!match?.[1]) return undefined;
	return match[1].toUpperCase() as ThinkingLevelName;
}

export function mapNumericThinkingLevel(level: unknown): ThinkingLevelName | undefined {
	if (typeof level !== "number" || !Number.isInteger(level)) return undefined;
	return NUMERIC_THINKING_LEVELS[level];
}

export function extractDiscoveredThinkingLevels(payload: unknown): Map<string, ThinkingLevelName> {
	const result = new Map<string, ThinkingLevelName>();
	if (!isPlainObject(payload) || !isPlainObject(payload.models)) return result;
	for (const [modelId, info] of Object.entries(payload.models)) {
		if (!isGemini3PlusModel(modelId) || !isPlainObject(info)) continue;
		const mapped = mapNumericThinkingLevel(info.thinkingLevel);
		if (mapped) result.set(modelId, mapped);
	}
	return result;
}

/**
 * Injects `request.generationConfig.thinkingConfig.thinkingLevel` into CCPA
 * `generateContent` / `streamGenerateContent` payloads when `agy_acp_server`
 * omitted it for a Gemini 3+ reasoning variant. Existing `thinkingLevel` or
 * `thinkingBudget` fields are preserved untouched.
 */
export function rewriteCcpaGeneratePayload(
	payload: unknown,
	discoveredLevels?: ReadonlyMap<string, ThinkingLevelName>,
): { rewritten: Record<string, unknown>; changed: boolean; thinkingLevel?: ThinkingLevelName } {
	if (!isPlainObject(payload)) return { rewritten: {}, changed: false };
	const model = typeof payload.model === "string" ? payload.model.trim() : "";
	if (!model) return { rewritten: payload, changed: false };

	const resolvedLevel = discoveredLevels?.get(model) ?? resolveThinkingLevelFromModelId(model);
	if (!resolvedLevel) return { rewritten: payload, changed: false };

	const request = payload.request;
	if (!isPlainObject(request)) return { rewritten: payload, changed: false };

	const generationConfig = isPlainObject(request.generationConfig) ? request.generationConfig : {};
	const thinkingConfig = isPlainObject(generationConfig.thinkingConfig)
		? generationConfig.thinkingConfig
		: {};

	const existingLevel = thinkingConfig.thinkingLevel;
	const existingBudget = thinkingConfig.thinkingBudget;
	if (
		(existingLevel !== undefined && existingLevel !== null && existingLevel !== "") ||
		(existingBudget !== undefined && existingBudget !== null)
	) {
		return { rewritten: payload, changed: false };
	}

	return {
		changed: true,
		thinkingLevel: resolvedLevel,
		rewritten: {
			...payload,
			request: {
				...request,
				generationConfig: {
					...generationConfig,
					thinkingConfig: {
						...thinkingConfig,
						thinkingLevel: resolvedLevel,
					},
				},
			},
		},
	};
}

function readStream(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer | string) => {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function forwardRequestHeaders(
	incoming: IncomingHttpHeaders,
	bodyLength?: number,
): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(incoming)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue;
		headers[lower] = value;
	}
	if (bodyLength !== undefined) {
		headers["content-length"] = String(bodyLength);
	}
	return headers;
}

function forwardResponseHeaders(incoming: IncomingHttpHeaders): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(incoming)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue;
		headers[lower] = value;
	}
	return headers;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
	const raw = headers[name];
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) return raw[0];
	return undefined;
}

async function defaultResolveUpstreamFromLoadCodeAssist(
	authorization: string,
	userAgent?: string,
): Promise<string> {
	const target = new URL("/v1internal:loadCodeAssist", PROD_CCPA_BASE_URL);
	const body = Buffer.from(JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }), "utf8");
	const headers: Record<string, string> = {
		authorization,
		"content-type": "application/json",
		"content-length": String(body.length),
	};
	if (userAgent) headers["user-agent"] = userAgent;

	return new Promise((resolve) => {
		const req = httpsRequest(
			target,
			{ method: "POST", headers, timeout: LOAD_CODE_ASSIST_TIMEOUT_MS },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer | string) => {
					chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
				});
				res.on("end", () => {
					try {
						const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
						if (
							isPlainObject(parsed) &&
							isPlainObject(parsed.paidTier) &&
							parsed.paidTier.usesGcpTos === true
						) {
							resolve(PROD_CCPA_BASE_URL);
							return;
						}
					} catch {
						// Fall back to consumer daily endpoint if response cannot be parsed.
					}
					resolve(CONSUMER_CCPA_BASE_URL);
				});
				res.on("error", () => resolve(CONSUMER_CCPA_BASE_URL));
			},
		);
		req.on("timeout", () => {
			req.destroy();
			resolve(CONSUMER_CCPA_BASE_URL);
		});
		req.on("error", () => resolve(CONSUMER_CCPA_BASE_URL));
		req.end(body);
	});
}

export async function startCcpaThinkingProxy(
	options: CcpaThinkingProxyOptions = {},
): Promise<CcpaThinkingProxy> {
	const discoveredLevels = new Map<string, ThinkingLevelName>();
	const resolvedUpstreams = new Map<string, string>();
	const inflightUpstreams = new Map<string, Promise<string>>();

	async function resolveUpstream(info: {
		project?: string;
		authorization?: string;
		userAgent?: string;
	}): Promise<string> {
		if (options.upstreamBaseUrl) return options.upstreamBaseUrl;
		if (options.resolveUpstreamBaseUrl) return options.resolveUpstreamBaseUrl(info);
		if (info.project === CONSUMER_PROJECT_ID) return CONSUMER_CCPA_BASE_URL;
		if (!info.authorization) return CONSUMER_CCPA_BASE_URL;

		const cacheKey = createHash("sha256")
			.update(`${info.project ?? ""}\0${info.authorization}`)
			.digest("hex");
		const cached = resolvedUpstreams.get(cacheKey);
		if (cached) return cached;

		if (!info.project) return CONSUMER_CCPA_BASE_URL;

		let pending = inflightUpstreams.get(cacheKey);
		if (!pending) {
			pending = defaultResolveUpstreamFromLoadCodeAssist(info.authorization, info.userAgent)
				.then((endpoint) => {
					resolvedUpstreams.set(cacheKey, endpoint);
					return endpoint;
				})
				.finally(() => {
					inflightUpstreams.delete(cacheKey);
				});
			inflightUpstreams.set(cacheKey, pending);
		}
		return pending;
	}

	const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const method = req.method ?? "GET";
		const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		const pathname = reqUrl.pathname;
		const isGeneratePath =
			method === "POST" &&
			(pathname === "/v1internal:streamGenerateContent" ||
				pathname === "/v1internal:generateContent");
		const isDiscoveryPath = method === "POST" && pathname === "/v1internal:fetchAvailableModels";

		let rawBody: Buffer | undefined;
		let forwardBody: Buffer | undefined;
		let parsedBody: unknown;

		try {
			if (method !== "GET" && method !== "HEAD") {
				rawBody = await readStream(req);
				forwardBody = rawBody;
				if (rawBody.length > 0 && pathname.startsWith("/v1internal:")) {
					try {
						parsedBody = JSON.parse(rawBody.toString("utf8"));
					} catch {
						parsedBody = undefined;
					}
				}
				if (isGeneratePath && parsedBody !== undefined) {
					const { rewritten, changed } = rewriteCcpaGeneratePayload(parsedBody, discoveredLevels);
					if (changed) {
						forwardBody = Buffer.from(JSON.stringify(rewritten), "utf8");
					}
				}
			}

			const project =
				isPlainObject(parsedBody) && typeof parsedBody.project === "string"
					? parsedBody.project
					: undefined;
			const upstreamBase = await resolveUpstream({
				project,
				authorization: headerValue(req.headers, "authorization"),
				userAgent: headerValue(req.headers, "user-agent"),
			});
			const targetUrl = new URL(reqUrl.pathname + reqUrl.search, upstreamBase);
			const requester = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
			const headers = forwardRequestHeaders(req.headers, forwardBody?.length);

			const upstreamReq = requester(
				targetUrl,
				{
					method,
					headers,
				},
				(upstreamRes) => {
					const statusCode = upstreamRes.statusCode ?? 502;
					const respHeaders = forwardResponseHeaders(upstreamRes.headers);
					res.writeHead(statusCode, respHeaders);

					const shouldTapDiscovery = isDiscoveryPath && statusCode === 200;
					const discoveryChunks: Buffer[] = [];
					let discoveryBytes = 0;
					let discoveryOverflow = false;

					if (shouldTapDiscovery) {
						upstreamRes.on("data", (chunk: Buffer | string) => {
							if (discoveryOverflow) return;
							const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
							discoveryBytes += buf.length;
							if (discoveryBytes > MAX_DISCOVERY_BODY_BYTES) {
								discoveryOverflow = true;
								discoveryChunks.length = 0;
								return;
							}
							discoveryChunks.push(buf);
						});
						upstreamRes.on("end", () => {
							if (discoveryOverflow || discoveryChunks.length === 0) return;
							try {
								const parsed = JSON.parse(Buffer.concat(discoveryChunks).toString("utf8"));
								for (const [id, level] of extractDiscoveredThinkingLevels(parsed)) {
									discoveredLevels.set(id, level);
								}
							} catch {
								// Ignore malformed discovery payloads; suffix fallback still applies.
							}
						});
					}

					upstreamRes.on("error", (err) => {
						if (!res.writableEnded) res.destroy(err);
					});
					upstreamRes.pipe(res);
				},
			);

			res.on("close", () => {
				if (!res.writableFinished) {
					upstreamReq.destroy();
				}
			});

			upstreamReq.on("error", (err) => {
				if (!res.headersSent) {
					const payload = JSON.stringify({
						error: {
							code: 502,
							message: `CCPA thinking proxy upstream error: ${err.message}`,
							status: "UNAVAILABLE",
						},
					});
					res.writeHead(502, {
						"content-type": "application/json; charset=utf-8",
						"content-length": String(Buffer.byteLength(payload)),
					});
					res.end(payload);
				} else if (!res.writableEnded) {
					res.destroy(err);
				}
			});

			if (forwardBody !== undefined) {
				upstreamReq.end(forwardBody);
			} else {
				upstreamReq.end();
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) {
				const payload = JSON.stringify({
					error: {
						code: 500,
						message: `CCPA thinking proxy error: ${message}`,
						status: "INTERNAL",
					},
				});
				res.writeHead(500, {
					"content-type": "application/json; charset=utf-8",
					"content-length": String(Buffer.byteLength(payload)),
				});
				res.end(payload);
			} else if (!res.writableEnded) {
				res.destroy();
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	server.unref();

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Failed to bind CCPA thinking proxy to loopback TCP port");
	}

	const url = `http://127.0.0.1:${address.port}`;
	let closed = false;
	return {
		url,
		discoveredLevels,
		close: async () => {
			if (closed) return;
			closed = true;
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		},
	};
}
