/**
 * venice-key-pool — pi extension
 *
 * Makes a second Venice account a transparent fallback instead of a manual
 * key swap. Two parts:
 *
 *  - `KeyPool` (pool.ts) remembers, in one small file shared by every pi
 *    process, which key Venice refused and until when. A refusal is held until
 *    the next 10:00 Brisbane reset, because that is when Venice's daily DIEM
 *    allowance is topped up again — the primary key is therefore preferred by
 *    default and returns by itself each morning.
 *  - a fetch wrapper (installed below) swaps the Authorization header on
 *    `api.venice.ai` requests and, when Venice answers 401/402/429, replays the
 *    identical request with the next key. Pi only ever sees the successful
 *    response, so a drained key costs nothing visible and no lost turn.
 *
 * `/venice-balance` (alias `/venice-usage`) reports live balances of every key;
 * `/venice-keys` reports the pool's own state (who is active, who is refused,
 * until when).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchBalance, formatBalance, markActive, readVeniceKeys } from "./keys.js";
import { formatPoolStatus, installVeniceFetch, KeyPool } from "./pool.js";

const NO_KEYS =
	"no Venice keys found: pi's `venice` credential is missing from " +
	"`~/.secrets/llm/pi-auth.json` and `~/.secrets/llm/venice-keys/` is empty.";

export default function registerVeniceKeyPool(pi: ExtensionAPI): void {
	const pool = new KeyPool();
	// Installed once per process; a /reload restores the previous fetch first.
	const restoreFetch = installVeniceFetch(pool);

	pi.on("session_shutdown", (event) => {
		if (event.reason === "reload") restoreFetch();
	});

	const note = (content: string) =>
		pi.sendMessage({ customType: "note", content, display: true }, { triggerTurn: false });

	/** `/venice-balance` and its `/venice-usage` alias share one handler. */
	const showBalances = (command: string) => async () => {
		const keys = readVeniceKeys();
		if (keys.length === 0) {
			note(`**💰 /${command}** — ${NO_KEYS}`);
			return;
		}
		const active = pool.candidates()[0]?.label;
		const lines = await Promise.all(
			keys.map(async (key) => {
				const label = markActive(key.label, key.label === active);
				try {
					return formatBalance(label, await fetchBalance(key.key));
				} catch (error) {
					return { text: `${label}: ${(error as Error).message}`, ok: false };
				}
			}),
		);
		const tail = lines.every((line) => line.ok)
			? ""
			: "\n\n_At least one key cannot serve requests._";
		note(`**💰 /${command}**\n\n${lines.map((line) => `- ${line.text}`).join("\n")}${tail}`);
	};

	pi.registerCommand("venice-balance", {
		description: "Show live Venice balance for every pooled key",
		handler: showBalances("venice-balance"),
	});

	// Same report under the allowance-command naming used by /gpt-usage and
	// /argon-usage, so the three providers are found the same way.
	pi.registerCommand("venice-usage", {
		description: "Alias of /venice-balance: Venice allowance for every pooled key",
		handler: showBalances("venice-usage"),
	});

	pi.registerCommand("venice-keys", {
		description: "Show which Venice key the pool is using and why",
		handler: async () => {
			const lines = formatPoolStatus(pool);
			if (lines.length === 0) {
				note(`**🔑 /venice-keys** — ${NO_KEYS}`);
				return;
			}
			note(`**🔑 /venice-keys**\n\n${lines.map((line) => `- ${line}`).join("\n")}`);
		},
	});
}
