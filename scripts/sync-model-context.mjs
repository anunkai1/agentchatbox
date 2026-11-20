#!/usr/bin/env node
/**
 * Sync context windows, output limits, pricing, and reasoning metadata in
 * `~/.pi/agent/models.json` against Venice's live API so hand-written values
 * cannot silently go stale.
 *
 * Run:
 *   node scripts/sync-model-context.mjs            # apply updates
 *   node scripts/sync-model-context.mjs --dry-run  # print diffs only
 *
 * Keys are resolved from VENICE_API_KEY in the environment / .env,
 * ~/.pi/agent/auth.json, or ~/.secrets/llm/providers.env if present.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");
const AUTH_JSON = join(homedir(), ".pi", "agent", "auth.json");

/** Load optional env files the same way the server does. */
function loadEnv(path) {
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const m = line.match(/^\s*export\s+([A-Z_][A-Z0-9_]*)=(.*)$/);
			const m2 = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
			const mm = m || m2;
			if (!mm) continue;
			let val = mm[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
				val = val.slice(1, -1);
			if (val && process.env[mm[1]] === undefined) process.env[mm[1]] = val;
		}
	} catch {
		/* file optional */
	}
}
loadEnv(join(ROOT_DIR, ".env"));
loadEnv(join(homedir(), ".secrets", "llm", "providers.env"));

function resolveVeniceKey() {
	if (process.env.VENICE_API_KEY) return process.env.VENICE_API_KEY;
	try {
		const auth = JSON.parse(readFileSync(AUTH_JSON, "utf8"));
		if (typeof auth?.venice?.key === "string" && auth.venice.key.trim()) {
			return auth.venice.key.trim();
		}
	} catch {
		/* auth.json optional */
	}
	return undefined;
}

const VENICE_KEY = resolveVeniceKey();

/** Fetch + parse JSON with a timeout. */
async function getJSON(url, headers = {}, timeoutMs = 15000) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const r = await fetch(url, { headers, signal: ctrl.signal });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return await r.json();
	} finally {
		clearTimeout(t);
	}
}

function buildCost(pricing) {
	if (!pricing || typeof pricing !== "object") return undefined;
	const input = pricing.input?.usd;
	const output = pricing.output?.usd;
	if (typeof input !== "number" || typeof output !== "number") return undefined;
	const cacheRead = typeof pricing.cache_input?.usd === "number" ? pricing.cache_input.usd : 0;
	const cacheWrite = typeof pricing.cache_write?.usd === "number" ? pricing.cache_write.usd : 0;
	const cost = { input, output, cacheRead, cacheWrite };
	const ext = pricing.extended;
	if (ext && typeof ext.context_token_threshold === "number") {
		cost.tiers = [
			{
				inputTokensAbove: ext.context_token_threshold,
				input: typeof ext.input?.usd === "number" ? ext.input.usd : input,
				output: typeof ext.output?.usd === "number" ? ext.output.usd : output,
				cacheRead: typeof ext.cache_input?.usd === "number" ? ext.cache_input.usd : cacheRead,
				cacheWrite: typeof ext.cache_write?.usd === "number" ? ext.cache_write.usd : cacheWrite,
			},
		];
	}
	return cost;
}

function buildThinkingLevelMap(options) {
	if (!Array.isArray(options) || options.length === 0) return undefined;
	const opts = new Set(options);
	const map = {
		off: opts.has("none") ? "none" : null,
		minimal: opts.has("minimal") ? "minimal" : null,
		low: opts.has("low") ? "low" : null,
		medium: opts.has("medium") ? "medium" : null,
		high: opts.has("high") ? "high" : null,
	};
	if (opts.has("xhigh")) map.xhigh = "xhigh";
	if (opts.has("max")) map.max = "max";
	return map;
}

/** Venice: { [modelId]: { context, maxTokens, reasoning, supportsReasoningEffort, thinkingLevelMap, cost } } */
async function veniceCatalog() {
	if (!VENICE_KEY) throw new Error("VENICE_API_KEY not set — cannot sync Venice models");
	const j = await getJSON("https://api.venice.ai/api/v1/models", {
		Authorization: `Bearer ${VENICE_KEY}`,
	});
	const out = {};
	for (const x of j.data ?? []) {
		const spec = x.model_spec ?? {};
		const caps = spec.capabilities ?? {};
		const supportsReasoningEffort = caps.supportsReasoningEffort;
		out[x.id] = {
			context: x.context_length,
			maxTokens: spec.maxCompletionTokens,
			reasoning: caps.supportsReasoning,
			supportsReasoningEffort,
			thinkingLevelMap: supportsReasoningEffort
				? buildThinkingLevelMap(caps.reasoningEffortOptions)
				: undefined,
			cost: buildCost(spec.pricing),
		};
	}
	return out;
}

function stableEqual(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
	const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
	const cfg = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
	const venice = await veniceCatalog();

	const changes = [];
	const veniceProvider = cfg.providers?.venice;
	const providerDefaultEffort = veniceProvider?.compat?.supportsReasoningEffort ?? true;
	if (!veniceProvider?.models) {
		console.log("no venice provider/models in models.json — skipping Venice sync");
	} else {
		for (const m of veniceProvider.models) {
			const api = venice[m.id];
			if (!api) {
				changes.push({ id: m.id, kind: "MISSING", detail: "not listed by Venice API" });
				continue;
			}
			if (api.context != null && m.contextWindow !== api.context) {
				changes.push({
					id: m.id,
					kind: "contextWindow",
					from: m.contextWindow,
					to: api.context,
				});
				m.contextWindow = api.context;
			}
			if (api.maxTokens != null && m.maxTokens !== api.maxTokens) {
				changes.push({
					id: m.id,
					kind: "maxTokens",
					from: m.maxTokens,
					to: api.maxTokens,
				});
				m.maxTokens = api.maxTokens;
			}
			if (typeof api.reasoning === "boolean" && m.reasoning !== api.reasoning) {
				changes.push({
					id: m.id,
					kind: "reasoning",
					from: m.reasoning,
					to: api.reasoning,
				});
				m.reasoning = api.reasoning;
			}
			if (typeof api.supportsReasoningEffort === "boolean") {
				const currentEffort = m.compat?.supportsReasoningEffort ?? providerDefaultEffort;
				if (currentEffort !== api.supportsReasoningEffort) {
					changes.push({
						id: m.id,
						kind: "compat.supportsReasoningEffort",
						from: currentEffort,
						to: api.supportsReasoningEffort,
					});
					if (api.supportsReasoningEffort === providerDefaultEffort) {
						if (m.compat) {
							delete m.compat.supportsReasoningEffort;
							if (Object.keys(m.compat).length === 0) delete m.compat;
						}
					} else {
						m.compat = { ...m.compat, supportsReasoningEffort: api.supportsReasoningEffort };
					}
				}
			}
			if (api.supportsReasoningEffort === false && m.thinkingLevelMap !== undefined) {
				changes.push({
					id: m.id,
					kind: "thinkingLevelMap",
					from: JSON.stringify(m.thinkingLevelMap),
					to: "removed",
				});
				delete m.thinkingLevelMap;
			} else if (api.thinkingLevelMap && !stableEqual(m.thinkingLevelMap, api.thinkingLevelMap)) {
				changes.push({
					id: m.id,
					kind: "thinkingLevelMap",
					from: JSON.stringify(m.thinkingLevelMap ?? null),
					to: JSON.stringify(api.thinkingLevelMap),
				});
				m.thinkingLevelMap = api.thinkingLevelMap;
			}
			if (api.cost && !stableEqual(m.cost, api.cost)) {
				changes.push({
					id: m.id,
					kind: "cost",
					from: JSON.stringify(m.cost ?? null),
					to: JSON.stringify(api.cost),
				});
				m.cost = api.cost;
			}
		}
	}

	// Report providers we DON'T auto-sync so nothing silently rots.
	const notSynced = [];
	for (const [prov, p] of Object.entries(cfg.providers ?? {})) {
		if (prov === "venice") continue;
		for (const m of p.models ?? []) notSynced.push(`${prov}/${m.id} = ${m.contextWindow}`);
	}

	console.log(`\n=== Venice sync (${Object.keys(venice).length} models from API) ===`);
	if (changes.length === 0) {
		console.log("✓ all Venice models already match the API — no changes");
	} else {
		for (const c of changes) {
			if (c.kind === "MISSING") console.log(`  ? ${c.id}: ${c.detail}`);
			else console.log(`  ~ ${c.id} ${c.kind}: ${c.from} → ${c.to}`);
		}
	}

	if (notSynced.length) {
		console.log(`\n=== NOT auto-synced (verify manually) ===`);
		for (const x of notSynced) console.log(`  ${x}`);
	}

	// Only write back if a real (non-MISSING) value changed.
	const writes = changes.filter((c) => c.kind !== "MISSING");
	if (writes.length > 0 && dryRun) {
		console.log(`\nℹ dry-run: ${writes.length} update(s) detected, ${MODELS_JSON} left untouched`);
	} else if (writes.length > 0) {
		writeFileSync(MODELS_JSON, JSON.stringify(cfg, null, 2) + "\n");
		console.log(`\n✓ wrote ${writes.length} update(s) to ${MODELS_JSON}`);
	} else {
		console.log(`\n✓ no writable changes — ${MODELS_JSON} left untouched`);
	}
}

main().catch((e) => {
	console.error(`sync failed: ${e.message}`);
	process.exit(1);
});
