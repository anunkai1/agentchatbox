import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CcpaThinkingProxy, startCcpaThinkingProxy } from "./proxy.js";

export const CCPA_BASE_URL_ENV = "AGY_ACP_CCPA_BASE_URL";
export const CCPA_PROXY_MANAGED_ENV = "AGY_ACP_CCPA_PROXY_MANAGED";

export interface RegisterAntigravityThinkingOptions {
	env?: NodeJS.ProcessEnv;
	startProxy?: typeof startCcpaThinkingProxy;
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

export default async function antigravityThinkingExtension(pi: ExtensionAPI): Promise<void> {
	await registerAntigravityThinking(pi);
}
