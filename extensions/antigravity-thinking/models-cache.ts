import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model, ModelCostTier } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type ProviderChatModelConfig = Extract<
	ProviderModelConfig,
	{ contextWindow: number; maxTokens: number }
>;

export const ANTIGRAVITY_PROVIDER_ID = "antigravity-acp";
export const ANTIGRAVITY_API = "antigravity-acp" as Api;
export const ANTIGRAVITY_BASE_URL = "acp://antigravity";
export const MODELS_CACHE_ENV = "PI_ANTIGRAVITY_MODELS_CACHE_FILE";

export const DEFAULT_MODELS_CACHE_PATH = join(
	homedir(),
	".pi",
	"agent",
	"antigravity-acp-provider",
	"models-cache.json",
);

interface ModelsCacheFile {
	updatedAt: number;
	models: ProviderChatModelConfig[];
}

export function resolveModelsCachePath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[MODELS_CACHE_ENV]?.trim();
	return override || DEFAULT_MODELS_CACHE_PATH;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeCost(value: unknown): ProviderChatModelConfig["cost"] {
	const fallback = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	if (!isPlainObject(value)) return fallback;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
	const out: ProviderChatModelConfig["cost"] = {
		input: num(value.input),
		output: num(value.output),
		cacheRead: num(value.cacheRead),
		cacheWrite: num(value.cacheWrite),
	};
	if (Array.isArray(value.tiers)) {
		const tiers: ModelCostTier[] = [];
		for (const tier of value.tiers) {
			if (!isPlainObject(tier)) continue;
			if (typeof tier.inputTokensAbove !== "number" || !Number.isFinite(tier.inputTokensAbove)) {
				continue;
			}
			tiers.push({
				inputTokensAbove: tier.inputTokensAbove,
				input: num(tier.input),
				output: num(tier.output),
				cacheRead: num(tier.cacheRead),
				cacheWrite: num(tier.cacheWrite),
			});
		}
		if (tiers.length > 0) out.tiers = tiers;
	}
	return out;
}

function sanitizeInput(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) return ["text", "image"];
	const items = value.filter((v): v is "text" | "image" => v === "text" || v === "image");
	return items.length > 0 ? items : ["text", "image"];
}

function sanitizeThinkingLevelMap(value: unknown): Model<Api>["thinkingLevelMap"] | undefined {
	if (!isPlainObject(value)) return undefined;
	const out: Record<string, string | null> = {};
	for (const [k, v] of Object.entries(value)) {
		if (v === null || typeof v === "string") out[k] = v;
	}
	return Object.keys(out).length > 0 ? (out as Model<Api>["thinkingLevelMap"]) : undefined;
}

export function toCachedModelConfigs(models: readonly unknown[]): ProviderChatModelConfig[] {
	const out: ProviderChatModelConfig[] = [];
	const seen = new Set<string>();
	for (const raw of models) {
		if (!isPlainObject(raw)) continue;
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
		const contextWindow =
			typeof raw.contextWindow === "number" &&
			Number.isFinite(raw.contextWindow) &&
			raw.contextWindow > 0
				? raw.contextWindow
				: 1_000_000;
		const maxTokens =
			typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0
				? raw.maxTokens
				: 65_536;
		const thinkingLevelMap = sanitizeThinkingLevelMap(raw.thinkingLevelMap);
		out.push({
			id,
			name,
			api: ANTIGRAVITY_API,
			baseUrl: ANTIGRAVITY_BASE_URL,
			reasoning: raw.reasoning === true,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: sanitizeInput(raw.input),
			cost: sanitizeCost(raw.cost),
			contextWindow,
			maxTokens,
		});
	}
	return out;
}

export function toAntigravityModels(models: readonly unknown[]): Model<Api>[] {
	return toCachedModelConfigs(models).map((config) => ({
		...config,
		api: config.api ?? ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: config.baseUrl ?? ANTIGRAVITY_BASE_URL,
	}));
}

export function readAntigravityModelsCache(
	filePath = resolveModelsCachePath(),
): ProviderChatModelConfig[] {
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<ModelsCacheFile>;
		if (!Array.isArray(parsed.models)) return [];
		return toCachedModelConfigs(parsed.models);
	} catch {
		return [];
	}
}

export function writeAntigravityModelsCache(
	models: readonly unknown[],
	filePath = resolveModelsCachePath(),
): boolean {
	const normalized = toCachedModelConfigs(models);
	if (normalized.length === 0) return false;
	const existing = readAntigravityModelsCache(filePath);
	if (existing.length > 0 && JSON.stringify(existing) === JSON.stringify(normalized)) {
		return false;
	}
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const payload: ModelsCacheFile = {
		updatedAt: Date.now(),
		models: normalized,
	};
	writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmpPath, filePath);
	return true;
}
