import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ANTIGRAVITY_PROVIDER_ID,
	readAntigravityModelsCache,
	resolveModelsCachePath,
	toAntigravityModels,
	writeAntigravityModelsCache,
} from "./models-cache.js";
import { type CcpaThinkingProxy, startCcpaThinkingProxy } from "./proxy.js";

export const CCPA_BASE_URL_ENV = "AGY_ACP_CCPA_BASE_URL";
export const CCPA_PROXY_MANAGED_ENV = "AGY_ACP_CCPA_PROXY_MANAGED";
export const MODELS_REFRESH_PROBE_ENV = "PI_ANTIGRAVITY_MODELS_REFRESH_PROBE";
export const DISABLE_MODELS_CACHE_ENV = "PI_ANTIGRAVITY_DISABLE_MODELS_CACHE";

export interface RegisterAntigravityThinkingOptions {
	env?: NodeJS.ProcessEnv;
	startProxy?: typeof startCcpaThinkingProxy;
	argv?: readonly string[];
	cachePath?: string;
}

export async function registerAntigravityThinking(
	pi: ExtensionAPI,
	options: RegisterAntigravityThinkingOptions = {},
): Promise<CcpaThinkingProxy> {
	const env = options.env ?? process.env;
	const startProxy = options.startProxy ?? startCcpaThinkingProxy;

	const previousBaseUrl = env[CCPA_BASE_URL_ENV];
	const previousManaged = env[CCPA_PROXY_MANAGED_ENV];
	const externalUpstream = previousBaseUrl && previousManaged !== "1" ? previousBaseUrl : undefined;

	const proxy = await startProxy(externalUpstream ? { upstreamBaseUrl: externalUpstream } : {});

	env[CCPA_BASE_URL_ENV] = proxy.url;
	env[CCPA_PROXY_MANAGED_ENV] = "1";

	pi.on("session_shutdown", async () => {
		if (env[CCPA_BASE_URL_ENV] === proxy.url) {
			if (previousBaseUrl === undefined) {
				delete env[CCPA_BASE_URL_ENV];
			} else {
				env[CCPA_BASE_URL_ENV] = previousBaseUrl;
			}
			if (previousManaged === undefined) {
				delete env[CCPA_PROXY_MANAGED_ENV];
			} else {
				env[CCPA_PROXY_MANAGED_ENV] = previousManaged;
			}
		}
		await proxy.close();
	});

	return proxy;
}

export interface LazyAntigravityThinkingHandle {
	isStarted(): boolean;
	ensureStarted(): Promise<CcpaThinkingProxy>;
}

export const ANTIGRAVITY_SHARED_RUNTIME_SYMBOL = Symbol.for("pi-antigravity-acp:runtime");
const WRAPPED_NATIVE_MARKER = Symbol.for("acb:antigravity-thinking:wrapped-native");

interface AntigravityNativeSharedSlot {
	provider?: Record<string, unknown> & {
		id: string;
		getModels?: () => unknown[];
		refreshModels?: (context: unknown) => Promise<void>;
	};
}

function wrapNativeProviderWithCachedModels(
	provider: AntigravityNativeSharedSlot["provider"],
	cachedModels: ReturnType<typeof toAntigravityModels>,
): (AntigravityNativeSharedSlot["provider"] & { [WRAPPED_NATIVE_MARKER]?: boolean }) | null {
	if (!provider || provider.id !== ANTIGRAVITY_PROVIDER_ID || cachedModels.length === 0) {
		return null;
	}
	if ((provider as Record<symbol, unknown>)[WRAPPED_NATIVE_MARKER]) {
		return null;
	}
	const baseGetModels =
		typeof provider.getModels === "function" ? provider.getModels.bind(provider) : undefined;
	const initialModels = baseGetModels ? baseGetModels() : undefined;
	const wrapped = {
		...provider,
		[WRAPPED_NATIVE_MARKER]: true,
		getModels: () => {
			if (baseGetModels) {
				const current = baseGetModels();
				// If refreshModels published a new array since wrap time, prefer the live list.
				if (current !== initialModels && Array.isArray(current) && current.length > 0) {
					return current;
				}
			}
			return cachedModels;
		},
	};
	return wrapped;
}

/**
 * Serves cached antigravity-acp models through the native provider wrapper and
 * defers starting the CCPA thinking proxy until a session actually selects or
 * runs an `antigravity-acp` model. Non-Gemini sessions pay zero proxy startup
 * or open-socket overhead.
 */
export function registerLazyAntigravityThinking(
	pi: ExtensionAPI,
	options: RegisterAntigravityThinkingOptions = {},
): LazyAntigravityThinkingHandle {
	const env = options.env ?? process.env;
	const argv = options.argv ?? process.argv;
	const cachePath = options.cachePath ?? resolveModelsCachePath(env);
	const isRefreshProbe = env[MODELS_REFRESH_PROBE_ENV] === "1";
	const cacheDisabled = env[DISABLE_MODELS_CACHE_ENV] === "1";

	let cachedNativeApplied = false;
	const applyCachedModelsAtLoad = (): void => {
		if (isRefreshProbe || cacheDisabled || typeof pi.registerProvider !== "function") return;
		const cached = toAntigravityModels(readAntigravityModelsCache(cachePath));
		if (cached.length === 0) return;
		const slot = (globalThis as Record<symbol, AntigravityNativeSharedSlot | undefined>)[
			ANTIGRAVITY_SHARED_RUNTIME_SYMBOL
		];
		const wrapped = wrapNativeProviderWithCachedModels(slot?.provider, cached);
		if (wrapped) {
			(pi.registerProvider as (provider: unknown) => void)(wrapped);
			cachedNativeApplied = true;
		}
	};
	applyCachedModelsAtLoad();

	let inflight: Promise<CcpaThinkingProxy> | null = null;
	let startedProxy: CcpaThinkingProxy | null = null;

	const ensureStarted = (): Promise<CcpaThinkingProxy> => {
		if (!inflight) {
			inflight = registerAntigravityThinking(pi, options)
				.then((proxy) => {
					startedProxy = proxy;
					return proxy;
				})
				.catch((error) => {
					inflight = null;
					throw error;
				});
		}
		return inflight;
	};

	const maybeActivateForProvider = async (provider: string | undefined): Promise<void> => {
		if (provider === ANTIGRAVITY_PROVIDER_ID) {
			await ensureStarted();
		}
	};

	const syncModelsToCache = (ctx: Pick<ExtensionContext, "modelRegistry">): void => {
		if (cacheDisabled) return;
		try {
			const models =
				ctx.modelRegistry?.getModelsOfType?.("chat", ANTIGRAVITY_PROVIDER_ID) ??
				ctx.modelRegistry?.getAll?.().filter((m) => m.provider === ANTIGRAVITY_PROVIDER_ID);
			if (Array.isArray(models) && models.length > 0) {
				writeAntigravityModelsCache(models, cachePath);
			}
		} catch {
			// Best-effort cache write; never break session startup.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!cachedNativeApplied && !isRefreshProbe && !cacheDisabled) {
			const cached = toAntigravityModels(readAntigravityModelsCache(cachePath));
			const native = ctx.modelRegistry?.getRegisteredNativeProvider?.(ANTIGRAVITY_PROVIDER_ID);
			const wrapped = wrapNativeProviderWithCachedModels(
				native as AntigravityNativeSharedSlot["provider"],
				cached,
			);
			if (wrapped && typeof ctx.modelRegistry?.registerProvider === "function") {
				(ctx.modelRegistry.registerProvider as (provider: unknown) => void)(wrapped);
				cachedNativeApplied = true;
			}
		}
		if (isRefreshProbe && typeof ctx.modelRegistry?.refresh === "function") {
			try {
				await ctx.modelRegistry.refresh({
					providers: [ANTIGRAVITY_PROVIDER_ID],
					allowNetwork: true,
					signal: AbortSignal.timeout(15_000),
				});
				syncModelsToCache(ctx);
			} catch {
				// Leave any existing cache intact on transient refresh errors.
			}
		}
		await maybeActivateForProvider(ctx.model?.provider);
	});

	pi.on("model_select", async (event) => {
		await maybeActivateForProvider(event.model?.provider);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (
			!argv.includes("--offline") &&
			!isRefreshProbe &&
			ctx.model?.provider === ANTIGRAVITY_PROVIDER_ID
		) {
			syncModelsToCache(ctx);
		}
		await maybeActivateForProvider(ctx.model?.provider);
	});

	return {
		isStarted: () => startedProxy !== null,
		ensureStarted,
	};
}

export default function antigravityThinkingExtension(pi: ExtensionAPI): void {
	registerLazyAntigravityThinking(pi);
}
