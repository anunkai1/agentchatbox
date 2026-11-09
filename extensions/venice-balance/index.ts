/**
 * venice-balance — pi extension
 *
 * `/venice-balance` asks Venice for the real remaining balance instead of
 * waiting for a 402 mid-conversation. `GET /api/v1/api_keys/rate_limits`
 * answers with `accessPermitted`, per-currency balances and the next epoch
 * reset; it costs no VCU.
 *
 * Keys come from pi's own `venice` credential plus, if they exist, extra
 * slots in `~/.secrets/llm/venice-keys/` (one key per file, filename used as
 * the label), so a future key pool shows every balance side by side. Keys are
 * only ever sent as an Authorization header — never printed, never argv.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RATE_LIMITS_URL = "https://api.venice.ai/api/v1/api_keys/rate_limits";
const AUTH_FILE = join(homedir(), ".secrets", "llm", "pi-auth.json");
const KEY_DIR = join(homedir(), ".secrets", "llm", "venice-keys");

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

const NO_KEYS =
	"**💰 /venice-balance** — no Venice keys found: pi's `venice` credential is missing from " +
	"`~/.secrets/llm/pi-auth.json` and `~/.secrets/llm/venice-keys/` is empty.";

/** pi's stored venice credential, then any extra key slots, in label order. */
export function readVeniceKeys(authFile = AUTH_FILE, keyDir = KEY_DIR): VeniceKey[] {
	const keys: VeniceKey[] = [];
	try {
		const stored = JSON.parse(readFileSync(authFile, "utf8")) as {
			venice?: { key?: unknown };
		};
		const key = stored.venice?.key;
		if (typeof key === "string" && key.length > 0 && !key.startsWith("!")) {
			keys.push({ label: "venice", key });
		}
	} catch {
		// Missing or locked auth.json: just report the extra slots.
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
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body = (await response.json()) as { data?: VeniceBalance };
	return body.data ?? {};
}

function money(value: number): string {
	return value.toFixed(value < 0.01 && value > -0.01 ? 6 : 2);
}

/** A single chat line: balances first, then the decision pi's failover would make. */
export function formatBalance(label: string, data: VeniceBalance): { text: string; ok: boolean } {
	const balances = data.balances ?? {};
	const parts = Object.entries(balances)
		.filter(([, value]) => Number.isFinite(value))
		.map(([name, value]) => `${name} ${money(value)}`);
	const credits = ["DIEM", "BUNDLED_CREDITS"].some((name) => (balances[name] ?? 0) > 0);
	const usd = balances.USD ?? 0;
	const usable = data.accessPermitted !== false && (usd > 0 || credits);
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

export default function registerVeniceBalance(pi: ExtensionAPI): void {
	pi.registerCommand("venice-balance", {
		description: "Show remaining Venice API balance for every configured key",
		handler: async () => {
			const keys = readVeniceKeys();
			// A display-only "note" message: rendered as its own transcript row
			// (markdown), never sent to the model and never starts a turn.
			const show = (content: string) => {
				pi.sendMessage({ customType: "note", content, display: true }, { triggerTurn: false });
			};
			if (keys.length === 0) {
				show(NO_KEYS);
				return;
			}
			const lines = await Promise.all(
				keys.map(async ({ label, key }) => {
					try {
						return formatBalance(label, await fetchBalance(key));
					} catch (error) {
						return { text: `${label}: ${(error as Error).message}`, ok: false };
					}
				}),
			);
			const tail = lines.every((line) => line.ok)
				? ""
				: "\n\n_At least one key cannot serve requests._";
			show(`**💰 /venice-balance**\n\n${lines.map((line) => `- ${line.text}`).join("\n")}${tail}`);
		},
	});
}
