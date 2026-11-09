/**
 * Key discovery and balance reporting.
 *
 * Keys come from pi's own `venice` credential plus extra slots in
 * `~/.secrets/llm/venice-keys/` (one key per file, filename used as the label).
 * `GET /api/v1/api_keys/rate_limits` is free and reports `accessPermitted`,
 * per-currency balances and the next epoch reset. Keys are only ever sent as an
 * Authorization header — never printed, never passed as argv.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RATE_LIMITS_URL = "https://api.venice.ai/api/v1/api_keys/rate_limits";
export const AUTH_FILE = join(homedir(), ".secrets", "llm", "pi-auth.json");
export const KEY_DIR = join(homedir(), ".secrets", "llm", "venice-keys");

/** Label of pi's own stored credential; extra slots use their filename. */
export const PRIMARY_LABEL = "venice";

export interface VeniceKey {
	label: string;
	key: string;
}

export interface VeniceBalance {
	accessPermitted?: boolean;
	apiTier?: { id?: string; isCharged?: boolean };
	balances?: Record<string, number>;
	nextEpochBegins?: string | null;
}

/** pi's stored venice credential first, then extra key slots, in filename order. */
export function readVeniceKeys(authFile = AUTH_FILE, keyDir = KEY_DIR): VeniceKey[] {
	const keys: VeniceKey[] = [];
	try {
		const stored = JSON.parse(readFileSync(authFile, "utf8")) as {
			venice?: { key?: unknown };
		};
		const key = stored.venice?.key;
		if (typeof key === "string" && key.length > 0 && !key.startsWith("!")) {
			keys.push({ label: PRIMARY_LABEL, key });
		}
	} catch {
		// Missing or unreadable auth.json: just report the extra slots.
	}
	if (existsSync(keyDir)) {
		for (const name of readdirSync(keyDir).sort()) {
			if (name.startsWith(".")) continue;
			const key = readFileSync(join(keyDir, name), "utf8").trim();
			if (key.length > 0) keys.push({ label: name, key });
		}
	}
	return keys;
}

export async function fetchBalance(
	key: string,
	signal: AbortSignal = AbortSignal.timeout(15000),
): Promise<VeniceBalance> {
	const response = await fetch(RATE_LIMITS_URL, {
		// Opt out of the pool's Authorization rewriting: this key is the subject.
		headers: {
			Authorization: `Bearer ${key}`,
			Accept: "application/json",
			"x-acb-venice-solo": "1",
		},
		signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body = (await response.json()) as { data?: VeniceBalance };
	return body.data ?? {};
}

function money(value: number): string {
	return value.toFixed(value !== 0 && Math.abs(value) < 0.01 ? 6 : 2);
}

export function markActive(label: string, active: boolean): string {
	return active ? `${label} (in use)` : label;
}

/** A single chat line: balances, then whether the key could serve a request. */
export function formatBalance(label: string, data: VeniceBalance): { text: string; ok: boolean } {
	const balances = data.balances ?? {};
	const parts = Object.entries(balances)
		.filter(([, value]) => Number.isFinite(value))
		.map(([name, value]) => `${name} ${money(value)}`);
	const credits = ["DIEM", "BUNDLED_CREDITS"].some((name) => (balances[name] ?? 0) > 0);
	const usable = data.accessPermitted !== false && ((balances.USD ?? 0) > 0 || credits);
	const tier = data.apiTier?.id ? ` · ${data.apiTier.id}` : "";
	const reset = data.nextEpochBegins
		? ` · resets ${new Date(data.nextEpochBegins).toLocaleString("en-AU", {
				timeZone: "Australia/Brisbane",
				day: "2-digit",
				month: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			})}`
		: "";
	const status = usable ? "usable" : data.accessPermitted === false ? "blocked" : "exhausted";
	return {
		text: `${label}: ${parts.join(" · ") || "no balances"} · ${status}${tier}${reset}`,
		ok: usable,
	};
}
