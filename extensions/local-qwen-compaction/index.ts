import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LOCAL_PROVIDER = "local";
const LOCAL_MODEL_ID = "qwen3.8-27b-ud-q3";

// Pi's standard compactor budgets up to 80% of reserveTokens. The global
// reserve is 8,192, which permitted a local Qwen summary to generate 6,553
// tokens (and take several minutes on the single GPU slot). 2,560 yields a
// 2,048-token cap: enough for the structured checkpoint, without making the
// context cleanup look like a stuck chat.
const SUMMARY_RESERVE_TOKENS = 2_560;

function appendFileLists(summary: string, fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): {
	summary: string;
	details: { readFiles: string[]; modifiedFiles: string[] };
} {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	const readFiles = [...fileOps.read].filter((path) => !modified.has(path)).sort();
	const modifiedFiles = [...modified].sort();
	let suffix = "";
	if (readFiles.length > 0) suffix += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
	if (modifiedFiles.length > 0) suffix += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
	return { summary: `${summary.trimEnd()}${suffix}`, details: { readFiles, modifiedFiles } };
}

/**
 * Qwen shares one GPU serving slot, so default 6.5k-token, reasoning-enabled
 * compaction is visibly indistinguishable from a hung chat. Keep pi's native
 * cut point and checkpoint format, but generate a bounded 2k non-reasoning
 * checkpoint for this provider only. Other models retain pi's defaults.
 */
export default function registerLocalQwenCompaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== LOCAL_PROVIDER || model.id !== LOCAL_MODEL_ID) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			console.warn(`[local-qwen-compaction] could not resolve auth: ${auth.error}`);
			return;
		}

		// A split turn otherwise makes pi issue two summaries. One bounded
		// checkpoint covers both its history and prefix while retaining the same
		// first-kept boundary, so the current suffix remains untouched.
		const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
		if (messages.length === 0) return;

		try {
			const instructions = [
				event.customInstructions,
				"Be concise: fit the entire checkpoint in 2,048 tokens or fewer. Preserve exact paths, commands, decisions, blockers, and next steps.",
			]
				.filter(Boolean)
				.join("\n\n");
			const result = await generateSummaryWithUsage(
				messages,
				model,
				SUMMARY_RESERVE_TOKENS,
				auth.apiKey,
				auth.headers,
				event.signal,
				instructions,
				event.preparation.previousSummary,
				"off",
				undefined,
				auth.env,
			);
			if (event.signal.aborted || !result.text.trim()) return;

			const checkpoint = appendFileLists(result.text, event.preparation.fileOps);
			return {
				compaction: {
					summary: checkpoint.summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: result.usage,
					details: checkpoint.details,
				},
			};
		} catch (error) {
			if (!event.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`[local-qwen-compaction] compact checkpoint failed: ${message}`);
			}
			// Pi falls back to its standard compactor, which is safer than losing
			// the session checkpoint if the local server is unavailable.
			return;
		}
	});
}
