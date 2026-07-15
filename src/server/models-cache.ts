/**
 * Boot-time probe of `pi --mode rpc` `get_available_models`.
 *
 * Single source of truth for which chat models the picker advertises.
 * Per the transport-layer rule (AGENTS.md), ACB does not maintain its
 * own model list — it asks `pi` for what it knows (SDK built-ins + the
 * user's `~/.pi/agent/models.json`) and serves that. Adding a model:
 * put it in `models.json`. Removing one: delete it from there. ACB's
 * picker is a pure mirror.
 *
 * Why a separate probe and not a per-call RPC: get_available_models is
 * expensive (a `pi` boot + AgentSession construction + registry
 * enumeration — roughly half a second) and stable (the registry only
 * changes when models.json is edited or the SDK is updated, both of
 * which require an ACB restart anyway). One probe at boot, one cache,
 * one source of truth.
 *
 * The probe is fire-and-forget at boot; /api/models is always
 * responsive. If the probe fails (no provider key, pi crash, etc.)
 * the cache stays empty and /api/models returns an empty list — the
 * fix is to address the underlying issue and restart.
 */

import { getModels } from "@earendil-works/pi-ai";
import { config, getServerApiKey } from "./config.js";
import { log } from "./logger.js";
import type { PiProcess } from "./pi-process.js";
import { spawnPi } from "./pi-process.js";
import { SDK_PROVIDERS } from "./providers.js";
import { safeUnref } from "./util.js";

/** Model entry returned by pi's `get_available_models` and served via
 * /api/models. We only surface the subset the picker cares about. */
export interface AvailableModel {
	id: string;
	provider: string;
	name: string;
	reasoning: boolean;
}

/** Cached list, plus bookkeeping for the boot probe lifecycle. */
class ModelsCache {
	private models: AvailableModel[] = [];
	/** Single in-flight probe; concurrent callers await the same promise. */
	private inflight: Promise<void> | null = null;

	/** Current cached list. Empty until the first successful probe. */
	get(): readonly AvailableModel[] {
		return this.models;
	}

	/**
	 * Ensure the cache is populated. If a probe is in flight, await it.
	 * Otherwise kick off a probe and await it. Safe to call from
	 * request handlers (idempotent — concurrent calls share the
	 * in-flight promise).
	 */
	async ensureReady(timeoutMs = 5000): Promise<void> {
		if (this.models.length > 0) return;
		if (this.inflight) return this.inflight;
		this.inflight = this.probe(timeoutMs).finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	/**
	 * Spawn a one-shot `pi` child, ask for the model list, cache the
	 * result. The child is killed (SIGTERM, escalating to SIGKILL after
	 * 2s) once we have what we need or the timeout fires.
	 */
	private async probe(timeoutMs: number): Promise<void> {
		const start = pickBootProbe();
		if (!start) {
			log.warn("models cache probe skipped: no provider with API key");
			return;
		}
		const apiKey = getServerApiKey(start.provider);
		if (!apiKey) {
			log.warn("models cache probe skipped: no API key for boot probe provider", {
				provider: start.provider,
			});
			return;
		}

		const pi: PiProcess = spawnPi({
			bin: config.piBin,
			provider: start.provider,
			modelId: start.modelId,
			apiKey,
			cwd: config.piCwd,
		});

		try {
			const result = await new Promise<AvailableModel[]>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`get_available_models timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				// `unref` so a hung probe doesn't keep the server alive
				// past SIGTERM. (The explicit pi.kill() in the finally
				// block still runs.)
				safeUnref(timer);

				pi.on("event", (line) => {
					if (line.type !== "response" || line.command !== "get_available_models") {
						return;
					}
					clearTimeout(timer);
					if (line.success === false) {
						reject(new Error(String(line.error ?? "get_available_models failed")));
						return;
					}
					const data = line.data as { models?: unknown } | undefined;
					const rawModels = Array.isArray(data?.models) ? data.models : [];
					const out: AvailableModel[] = [];
					for (const raw of rawModels) {
						const m = raw as Partial<AvailableModel> & {
							provider?: unknown;
							id?: unknown;
							name?: unknown;
							reasoning?: unknown;
						};
						if (typeof m.provider !== "string" || typeof m.id !== "string") {
							continue;
						}
						out.push({
							id: m.id,
							provider: m.provider,
							name: typeof m.name === "string" ? m.name : m.id,
							reasoning: m.reasoning === true,
						});
					}
					resolve(out);
				});
				pi.on("exit", (info) => {
					clearTimeout(timer);
					reject(
						new Error(
							`pi exited before get_available_models responded (code=${info.code}, signal=${info.signal})`,
						),
					);
				});

				// Fire the RPC. The pi child also auto-emits its own
				// get_state response in the background, which we ignore
				// (it doesn't match our command filter above).
				pi.send({ type: "get_available_models" });
			});

			this.models = result;
			log.info("models cache populated from pi", {
				count: result.length,
				probeProvider: start.provider,
				probeModel: start.modelId,
			});
		} catch (err) {
			log.error("models cache probe failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			try {
				pi.kill();
			} catch {
				/* already dead */
			}
		}
	}
}

/** Process-wide singleton. */
export const modelsCache = new ModelsCache();

/**
 * Pick a (provider, modelId) pair to spawn `pi` with for the boot
 * probe. The probe model itself doesn't matter (we only call
 * `get_available_models`, which enumerates the full registry, not the
 * current model) but pi requires both flags at spawn time and validates
 * the modelId against the registry.
 *
 * Walks SDK_PROVIDERS, returning the first one with both a configured
 * API key and at least one model in the SDK's static registry. Doesn't
 * enumerate the user's `~/.pi/agent/models.json` here — pi does that
 * itself once it's spawned.
 */
function pickBootProbe(): { provider: string; modelId: string } | null {
	for (const provider of SDK_PROVIDERS) {
		if (!getServerApiKey(provider)) continue;
		try {
			const models = getModels(provider);
			if (models.length > 0) {
				return { provider, modelId: models[0].id };
			}
		} catch {
			// SDK doesn't know this provider; keep scanning.
		}
	}
	return null;
}
