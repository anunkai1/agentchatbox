/**
 * Runtime integration for `pi-antigravity-acp-provider`.
 *
 * Hooks the shared runtime on `globalThis[Symbol.for("pi-antigravity-acp:runtime")]`
 * to:
 *  1. Inject the active/scoped account's `GEMINI_HOME` into `connectionFactory`
 *     so `agy_acp_server` reads and writes credentials in that account's own
 *     isolated directory.
 *  2. Wrap `runtime.stream()` to detect quota / auth refusals before any real
 *     model output has been emitted to Pi, mark the exhausted account on
 *     cooldown, close the failed ACP binding, and transparently replay the turn
 *     on the next available account.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { fetchQuota, type QuotaGroup, type QuotaSummary } from "../plan-usage/gemini.js";
import type { AntigravityAccount } from "./accounts.js";
import {
	type AccountPool,
	classifyAntigravityError,
	classifyModelGroup,
	type QuotaGroupKind,
} from "./pool.js";

export const ANTIGRAVITY_SHARED_RUNTIME_SYMBOL = Symbol.for("pi-antigravity-acp:runtime");
export const MANAGED_AUTH_MARKER = "pi-antigravity-acp:managed-by-antigravity";
const PATCHED_POOL_MARKER = Symbol.for("acb:antigravity-account-pool:patched");
const QUOTA_NOTICE_PREFIX = "Usage Limit Reached";

export interface ConnectionOptionsLike {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	[key: string]: unknown;
}

export interface AntigravityConnectionLike {
	closed?: boolean;
	close?: () => Promise<void>;
	process?: {
		alive?: boolean;
		exited?: Promise<unknown>;
	};
}

export interface StreamWriterLike {
	stream: AssistantMessageEventStream;
	message?: AssistantMessage;
	finished?: boolean;
}

export interface StreamModelLike {
	id: string;
	provider: string;
	api?: string;
	[key: string]: unknown;
}

export interface StreamOptionsLike {
	apiKey?: string;
	sessionId?: string;
	signal?: AbortSignal;
	[key: string]: unknown;
}

export interface AntigravityRuntimeLike {
	[PATCHED_POOL_MARKER]?: AntigravityPoolHookHandle;
	connectionFactory?: (options: ConnectionOptionsLike) => AntigravityConnectionLike;
	stream?: (
		model: StreamModelLike,
		context: unknown,
		options?: StreamOptionsLike,
	) => StreamWriterLike;
	closeSession?: (piSessionId: string) => Promise<void>;
	loginGoogle?: (
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
		manualInteraction?: {
			showAuthorizationUrl: (url: string, instructions: string) => void;
			promptForCallback: (signal: AbortSignal) => Promise<string>;
		},
	) => Promise<void>;
	quota?: (apiKey: string | undefined, signal?: AbortSignal) => Promise<unknown>;
}

export interface AntigravitySharedSlot {
	runtime?: AntigravityRuntimeLike;
	provider?: Record<string, unknown>;
}

export interface FailoverEvent {
	from: AntigravityAccount;
	to: AntigravityAccount;
	reason: string;
}

export interface PatchPoolOptions {
	probeQuota?: (tokenFile: string) => Promise<QuotaSummary>;
	onFailover?: (event: FailoverEvent) => void;
	onAccountSuccess?: (account: AntigravityAccount) => void;
}

export interface AntigravityPoolHookHandle {
	runWithGeminiHome<T>(geminiHome: string | undefined, fn: () => T): T;
	invalidateSession(piSessionId: string | undefined): Promise<void>;
	invalidateAllSessions(): Promise<void>;
	activeAccountLabelForSession(piSessionId: string | undefined): string | undefined;
}

const geminiHomeScope = new AsyncLocalStorage<string | undefined>();

export function isManagedOAuth(apiKey: string | undefined): boolean {
	return !apiKey || apiKey === MANAGED_AUTH_MARKER;
}

function classifySummaryGroup(group: QuotaGroup): QuotaGroupKind | undefined {
	const ids = (group.buckets ?? []).map((b) => b.bucketId ?? "");
	if (ids.some((id) => /argon/i.test(id)) || /argon/i.test(group.displayName ?? "")) {
		return "argon";
	}
	if (ids.some((id) => /^3p-/i.test(id)) || /claude|gpt/i.test(group.displayName ?? "")) {
		return "third-party";
	}
	if (ids.some((id) => /^gemini-/i.test(id)) || /\bgemini\b/i.test(group.displayName ?? "")) {
		return "gemini";
	}
	return undefined;
}

export function findExhaustedGroupBucket(
	summary: QuotaSummary,
	groupKind: QuotaGroupKind,
	now = Date.now(),
): { exhausted: boolean; resetTime?: string } {
	for (const group of summary.groups ?? []) {
		if (classifySummaryGroup(group) !== groupKind) continue;
		for (const bucket of group.buckets ?? []) {
			if (bucket.disabled) continue;
			if (typeof bucket.remainingFraction !== "number") continue;
			if (Math.round(bucket.remainingFraction * 100) > 0) continue;
			const resetMs = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
			if (!Number.isNaN(resetMs) && resetMs <= now) continue;
			return { exhausted: true, ...(bucket.resetTime ? { resetTime: bucket.resetTime } : {}) };
		}
	}
	return { exhausted: false };
}

function makeFallbackErrorMessage(
	model: StreamModelLike,
	errorText: string,
	aborted: boolean,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: (model.api ?? "antigravity-acp") as AssistantMessage["api"],
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: errorText,
		timestamp: Date.now(),
	};
}

export function patchAntigravityRuntimeForPool(
	runtime: AntigravityRuntimeLike | undefined,
	pool: AccountPool,
	options: PatchPoolOptions = {},
): AntigravityPoolHookHandle | undefined {
	if (!runtime) return undefined;
	if (runtime[PATCHED_POOL_MARKER]) return runtime[PATCHED_POOL_MARKER];
	if (typeof runtime.connectionFactory !== "function" || typeof runtime.stream !== "function") {
		return undefined;
	}

	const liveConnections = new Set<AntigravityConnectionLike>();
	const sessionAccountMap = new Map<string, string>();
	const probeQuota = options.probeQuota ?? ((tokenFile: string) => fetchQuota(tokenFile));

	const origFactory = runtime.connectionFactory;
	runtime.connectionFactory = (connectionOptions: ConnectionOptionsLike = {}) => {
		const baseEnv = connectionOptions.env ?? process.env;
		const scopedHome = geminiHomeScope.getStore();
		const targetHome = scopedHome ?? pool.activeAccount()?.geminiHome;
		const patchedOptions =
			targetHome && !connectionOptions.env?.GEMINI_HOME?.trim()
				? { ...connectionOptions, env: { ...baseEnv, GEMINI_HOME: targetHome } }
				: connectionOptions;

		const connection = origFactory(patchedOptions);
		if (connection) {
			liveConnections.add(connection);
			void connection.process?.exited
				?.then(() => {
					liveConnections.delete(connection);
				})
				.catch(() => {
					liveConnections.delete(connection);
				});
		}
		return connection;
	};

	const origStream = runtime.stream.bind(runtime);
	runtime.stream = (
		model: StreamModelLike,
		context: unknown,
		streamOptions: StreamOptionsLike = {},
	): StreamWriterLike => {
		if (!isManagedOAuth(streamOptions.apiKey) || pool.accounts().length === 0) {
			return origStream(model, context, streamOptions);
		}

		const outer = createAssistantMessageEventStream();
		let finished = false;
		let latestMessage: AssistantMessage | undefined;

		const emitDone = (event: AssistantMessageEvent) => {
			if (finished) return;
			finished = true;
			if ("message" in event) latestMessage = event.message;
			else if ("error" in event) latestMessage = event.error;
			outer.push(event);
			outer.end();
		};

		const emitError = (errorText: string, aborted = false) => {
			if (finished) return;
			const msg = makeFallbackErrorMessage(model, errorText, aborted);
			finished = true;
			latestMessage = msg;
			outer.push({ type: "error", reason: aborted ? "aborted" : "error", error: msg });
			outer.end();
		};

		const sessionId = streamOptions.sessionId;
		const runWithFailover = async () => {
			const initialCandidates = pool.candidates(model.id);
			if (initialCandidates.length === 0) {
				emitError("No Antigravity accounts available.");
				return;
			}

			const tried = new Set<string>();
			let lastErrorEvent: AssistantMessageEvent | undefined;
			let pendingNotification: { from: AntigravityAccount; reason: string } | undefined;

			for (;;) {
				if (streamOptions.signal?.aborted) {
					emitError("Antigravity ACP request aborted", true);
					return;
				}

				const candidates = pool
					.candidates(model.id)
					.filter((candidate) => !tried.has(candidate.label));
				if (candidates.length === 0) break;

				const account = candidates[0]!;
				tried.add(account.label);

				// On failover with additional backups left, quickly probe quota so we
				// skip accounts already at 0% instead of waiting on a 30s 429 timeout.
				if (pendingNotification && candidates.length > 1) {
					try {
						const group = classifyModelGroup(model.id);
						const summary = await probeQuota(account.tokenFile);
						const bucket = findExhaustedGroupBucket(summary, group);
						if (bucket.exhausted) {
							pool.markBucketExhausted(account.label, group, bucket.resetTime);
							continue;
						}
					} catch {
						// Fail open: if quota probe errors, attempt the inference directly.
					}
				}

				if (pendingNotification) {
					options.onFailover?.({
						from: pendingNotification.from,
						to: account,
						reason: pendingNotification.reason,
					});
					pendingNotification = undefined;
				}

				// If this session's warm binding belongs to a different account, drop it
				// before prompting so `createBinding` spawns under the new GEMINI_HOME.
				if (sessionId) {
					const previousLabel = sessionAccountMap.get(sessionId);
					if (previousLabel && previousLabel !== account.label) {
						try {
							await runtime.closeSession?.(sessionId);
						} catch {
							// Best effort cleanup before binding under new account.
						}
					}
					sessionAccountMap.set(sessionId, account.label);
				}

				let attemptWriter: StreamWriterLike;
				try {
					attemptWriter = geminiHomeScope.run(account.geminiHome, () =>
						origStream(model, context, streamOptions),
					);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					const classified = classifyAntigravityError(msg);
					if (classified && !streamOptions.signal?.aborted) {
						pool.markFailure(account.label, model.id, msg);
						if (sessionId) {
							sessionAccountMap.delete(sessionId);
							await runtime.closeSession?.(sessionId).catch(() => undefined);
						}
						pendingNotification = { from: account, reason: classified.kind };
						lastErrorEvent = {
							type: "error",
							reason: "error",
							error: makeFallbackErrorMessage(model, msg, false),
						};
						continue;
					}
					emitError(msg, streamOptions.signal?.aborted === true);
					return;
				}

				let committed = false;
				const buffered: AssistantMessageEvent[] = [];
				let bufferedText = "";
				let retryWithNext: string | undefined;

				for await (const event of attemptWriter.stream) {
					if ("partial" in event) latestMessage = event.partial;
					if (!committed) {
						if (event.type === "start" || event.type === "text_start") {
							buffered.push(event);
							continue;
						}
						if (event.type === "text_delta") {
							buffered.push(event);
							bufferedText += event.delta;
							const trimmed = bufferedText.trimStart();
							const maybeQuotaNotice =
								trimmed.length <= QUOTA_NOTICE_PREFIX.length
									? QUOTA_NOTICE_PREFIX.startsWith(trimmed)
									: trimmed.startsWith(QUOTA_NOTICE_PREFIX);
							if (maybeQuotaNotice) continue;

							committed = true;
							for (const ev of buffered) outer.push(ev);
							buffered.length = 0;
							continue;
						}
						if (event.type === "text_end") {
							buffered.push(event);
							continue;
						}
						if (event.type === "thinking_start" || event.type === "toolcall_start") {
							committed = true;
							for (const ev of buffered) outer.push(ev);
							buffered.length = 0;
							outer.push(event);
							continue;
						}
						if (event.type === "done") {
							committed = true;
							for (const ev of buffered) outer.push(ev);
							buffered.length = 0;
							pool.markSuccess(account.label, model.id);
							options.onAccountSuccess?.(account);
							emitDone(event);
							return;
						}
						if (event.type === "error") {
							const msg = event.error?.errorMessage ?? "";
							const classified =
								event.reason !== "aborted" && !streamOptions.signal?.aborted
									? classifyAntigravityError(msg)
									: undefined;
							if (classified) {
								retryWithNext = msg;
								lastErrorEvent = event;
								break;
							}
							for (const ev of buffered) outer.push(ev);
							buffered.length = 0;
							emitDone(event);
							return;
						}
						committed = true;
						for (const ev of buffered) outer.push(ev);
						buffered.length = 0;
						outer.push(event);
						continue;
					}

					if (event.type === "error") {
						const msg = event.error?.errorMessage ?? "";
						const classified =
							event.reason !== "aborted" && !streamOptions.signal?.aborted
								? classifyAntigravityError(msg)
								: undefined;
						if (classified) {
							pool.markFailure(account.label, model.id, msg);
							if (sessionId) sessionAccountMap.delete(sessionId);
						}
						emitDone(event);
						return;
					}
					if (event.type === "done") {
						pool.markSuccess(account.label, model.id);
						options.onAccountSuccess?.(account);
						emitDone(event);
						return;
					}
					outer.push(event);
				}

				if (retryWithNext !== undefined) {
					const classified = classifyAntigravityError(retryWithNext);
					pool.markFailure(account.label, model.id, retryWithNext);
					if (sessionId) {
						sessionAccountMap.delete(sessionId);
						await runtime.closeSession?.(sessionId).catch(() => undefined);
					}
					pendingNotification = {
						from: account,
						reason: classified?.kind ?? "quota",
					};
					continue;
				}

				if (!finished) {
					const finalResult = await attemptWriter.stream.result().catch(() => undefined);
					if (finalResult) {
						emitDone({
							type:
								finalResult.stopReason === "error" || finalResult.stopReason === "aborted"
									? "error"
									: "done",
							...(finalResult.stopReason === "error" || finalResult.stopReason === "aborted"
								? {
										reason: finalResult.stopReason,
										error: finalResult,
									}
								: {
										reason:
											finalResult.stopReason === "length" || finalResult.stopReason === "toolUse"
												? finalResult.stopReason
												: "stop",
										message: finalResult,
									}),
						} as AssistantMessageEvent);
					} else {
						emitError("Antigravity ACP stream ended unexpectedly.");
					}
				}
				return;
			}

			if (lastErrorEvent) {
				emitDone(lastErrorEvent);
				return;
			}
			emitError("All Antigravity accounts are currently unavailable.");
		};

		void runWithFailover().catch((error: unknown) => {
			emitError(
				error instanceof Error ? error.message : String(error),
				streamOptions.signal?.aborted === true,
			);
		});

		return {
			stream: outer,
			get message() {
				return latestMessage;
			},
			get finished() {
				return finished;
			},
		};
	};

	const handle: AntigravityPoolHookHandle = {
		runWithGeminiHome<T>(geminiHome: string | undefined, fn: () => T): T {
			return geminiHomeScope.run(geminiHome, fn);
		},
		async invalidateSession(piSessionId: string | undefined): Promise<void> {
			if (!piSessionId) return;
			sessionAccountMap.delete(piSessionId);
			await runtime.closeSession?.(piSessionId);
		},
		async invalidateAllSessions(): Promise<void> {
			const sids = [...sessionAccountMap.keys()];
			sessionAccountMap.clear();
			await Promise.allSettled(sids.map((sid) => runtime.closeSession?.(sid)));
			await Promise.allSettled([...liveConnections].map((conn) => conn.close?.()));
		},
		activeAccountLabelForSession(piSessionId: string | undefined): string | undefined {
			return piSessionId ? sessionAccountMap.get(piSessionId) : undefined;
		},
	};

	runtime[PATCHED_POOL_MARKER] = handle;
	return handle;
}
