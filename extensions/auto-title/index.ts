import { basename } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildTitlePrompt,
	cleanGeneratedTitle,
	collectTitleSeed,
	hasAutoTitleMarker,
	hasConversation,
} from "./lib.js";

const MARKER = "acb-auto-title-v1";
const DEFAULT_MODEL_ENV = "AUTO_TITLE_MODEL";

function configuredModel(ctx: ExtensionContext): NonNullable<ExtensionContext["model"]> | null {
	const override = process.env[DEFAULT_MODEL_ENV]?.trim();
	if (!override) return ctx.model ?? null;
	const slash = override.indexOf("/");
	if (slash <= 0 || slash === override.length - 1) {
		throw new Error(`${DEFAULT_MODEL_ENV} must be provider/modelId`);
	}
	const model = ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1));
	if (!model) throw new Error(`${DEFAULT_MODEL_ENV} model not found: ${override}`);
	return model;
}

async function generateTitle(
	ctx: ExtensionContext,
	user: string,
	assistant: string,
): Promise<string> {
	const model = configuredModel(ctx);
	if (!model) throw new Error("no model available");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildTitlePrompt({ user, assistant }, basename(ctx.cwd)),
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			temperature: 0.2,
			// Some inexpensive reasoning models spend their first few dozen tokens
			// internally before emitting the tiny visible title. A 256-token ceiling
			// stays cheap while avoiding an empty text response from that warm-up.
			maxTokens: 256,
			cacheRetention: "none",
			maxRetries: 0,
			timeoutMs: 15_000,
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `title model stopped: ${response.stopReason}`);
	}
	const raw = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const title = cleanGeneratedTitle(raw);
	if (!title) throw new Error("title model produced no usable text");
	return title;
}

/**
 * Generate one concise session name after the first successful answer.
 * The model call is agent logic owned by pi; ACB only renders pi's ordinary
 * session_info_changed event and refreshed session summary.
 */
export default function (pi: ExtensionAPI) {
	let eligible = false;
	let attempted = false;

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		attempted = hasAutoTitleMarker(entries, MARKER);
		// Existing/resumed/forked conversations retain their current first-message
		// fallback. Only a genuinely empty, unnamed session opts into auto-title.
		eligible = !pi.getSessionName() && !attempted && !hasConversation(entries);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!eligible || attempted || pi.getSessionName()) return;
		const seed = collectTitleSeed(ctx.sessionManager.getBranch());
		if (!seed) return; // first run failed/aborted; wait for a successful answer

		attempted = true;
		try {
			const title = await generateTitle(ctx, seed.user, seed.assistant);
			// A manual /name may have landed while the small background request ran.
			// It is always authoritative and must never be overwritten.
			if (pi.getSessionName()) {
				pi.appendEntry(MARKER, { status: "skipped-manual" });
				return;
			}
			pi.setSessionName(title);
			pi.appendEntry(MARKER, { status: "named", title });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[pi-auto-title] ${message}`);
			pi.appendEntry(MARKER, { status: "failed", error: message.slice(0, 300) });
		}
	});
}
