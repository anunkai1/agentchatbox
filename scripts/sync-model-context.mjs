#!/usr/bin/env node
/**
 * Sync context windows (and a couple of related fields) in the pi
 * `models.json` override file against each provider's AUTHORITATIVE source,
 * so hand-written values can't silently go stale (the GLM-5.2 200k→1M bug).
 *
 * Run:   node scripts/sync-model-context.mjs
 *
 * What it does:
 *   - Reads ~/.pi/agent/models.json (pi's per-user model override file).
 *   - For Venice models, fetches https://api.venice.ai/api/v1/models and
 *     reconciles `contextWindow` (and, if present, `maxTokens`) to the API's
 *     `context_length` / `maxCompletionTokens`. Venice's API is the source of
 *     truth — models.json was already correct, but this keeps it that way as
 *     Venice adds/extends models.
 *   - Prints a diff of every change and writes models.json back ONLY if
 *     something changed (preserves formatting/key order otherwise).
 *
 * Scope is deliberately narrow: it only WRITES contextWindow / maxTokens for
 * providers whose API exposes them (Venice). It never deletes models, never
 * touches cost/compat/name, and never edits models it can't verify — it just
 * warns about them. Other providers (minimax direct, ollama, zai/glm-5.2)
 * are reported as "not auto-synced" so you know to verify them manually.
 *
 * Keys are loaded from the same env files pi uses:
 *   /home/lepton/.secrets/llm/providers.env  (VENICE_API_KEY)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");

/** Load provider env files the same way the server does. */
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
loadEnv("/home/lepton/.secrets/llm/providers.env");

const VENICE_KEY = process.env.VENICE_API_KEY;

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

/** Venice: { [modelId]: { context, maxTokens } } from the live API. */
async function veniceCatalog() {
	if (!VENICE_KEY) throw new Error("VENICE_API_KEY not set — cannot sync Venice models");
	const j = await getJSON("https://api.venice.ai/api/v1/models", {
		Authorization: `Bearer ${VENICE_KEY}`,
	});
	const out = {};
	for (const x of j.data ?? []) {
		out[x.id] = {
			context: x.context_length,
			maxTokens: x.model_spec?.maxCompletionTokens,
		};
	}
	return out;
}

async function main() {
	const cfg = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
	const venice = await veniceCatalog();

	const changes = [];
	const veniceProvider = cfg.providers?.venice;
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
	if (writes.length > 0) {
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
