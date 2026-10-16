import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FastModeStore {
	read(): boolean;
	write(enabled: boolean): void;
}

// Native OpenAI Responses models with Fast support. This list is independent
// of the optional Codex CLI cache, which can omit newer models such as GPT-6.1.
const FAST_OPENAI_MODELS = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);

/**
 * Models currently advertised by Codex's live catalogue with the Fast
 * (`priority`) service tier. Keep unsupported Codex models on the standard
 * tier rather than sending a request parameter the backend may reject.
 */
export const FAST_CODEX_MODELS = new Set([
	"codex-auto-review",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

export const DEFAULT_FAST_MODE_FILE = join(homedir(), ".config", "acb", "codex-fast");
export const DEFAULT_CODEX_MODEL_CACHE = join(homedir(), ".codex", "models_cache.json");

/** Read Codex's refreshed catalogue, falling back to the known current set. */
export function loadFastCodexModels(path = DEFAULT_CODEX_MODEL_CACHE): ReadonlySet<string> {
	try {
		const catalogue = JSON.parse(readFileSync(path, "utf8")) as {
			models?: Array<{ slug?: unknown; service_tiers?: Array<{ id?: unknown }> }>;
		};
		const models = new Set<string>();
		for (const model of catalogue.models ?? []) {
			if (
				typeof model.slug === "string" &&
				model.service_tiers?.some((tier) => tier.id === "priority")
			) {
				models.add(model.slug);
			}
		}
		if (models.size > 0) return models;
	} catch {
		// Codex CLI is optional; the bundled fallback keeps known models usable.
	}
	return FAST_CODEX_MODELS;
}

export class FileFastModeStore implements FastModeStore {
	private readonly path: string;

	constructor(path = DEFAULT_FAST_MODE_FILE) {
		this.path = path;
	}

	read(): boolean {
		try {
			return /^(1|on|true|fast|priority)$/i.test(readFileSync(this.path, "utf8").trim());
		} catch {
			return false;
		}
	}

	write(enabled: boolean): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, enabled ? "on\n" : "off\n", { encoding: "utf8", mode: 0o644 });
		renameSync(temporary, this.path);
	}
}

function isObjectPayload(payload: unknown): payload is Record<string, unknown> {
	return payload !== null && typeof payload === "object" && !Array.isArray(payload);
}

function currentOpenAIModel(ctx: { model?: { provider: string; id: string } }) {
	const model = ctx.model;
	return model?.provider === "openai" || model?.provider === "openai-codex" ? model : null;
}

/**
 * Register OpenAI fast mode with pi, including legacy Codex sign-ins. The
 * extension owns persistence and request rewriting; ACB only forwards `/fast`.
 * Keep the existing store path and status key so saved preferences survive.
 */
export function registerCodexFast(
	pi: ExtensionAPI,
	store: FastModeStore,
	supportedCodexModels: ReadonlySet<string> = loadFastCodexModels(),
): void {
	const supportsFast = (model: { provider: string; id: string }) =>
		(model.provider === "openai" ? FAST_OPENAI_MODELS : supportedCodexModels).has(model.id);

	pi.on("before_provider_request", (event, ctx) => {
		const model = currentOpenAIModel(ctx);
		if (!model || !supportsFast(model) || !store.read()) return;
		if (!isObjectPayload(event.payload) || event.payload.model !== model.id) return;

		// Both ChatGPT OAuth and the legacy Codex endpoint accept `priority`.
		// The current ChatGPT OAuth endpoint rejects the newer `fast` alias.
		return { ...event.payload, service_tier: "priority" };
	});

	pi.registerCommand("fast", {
		description: "toggle OpenAI fast mode (priority processing, increased usage)",
		handler: async (rawArgs, ctx) => {
			const command = rawArgs.trim().toLowerCase();
			const current = store.read();
			if (command === "report") {
				ctx.ui.setStatus("codex-fast", current ? "Enabled" : "Standard");
				return;
			}

			const model = currentOpenAIModel(ctx);
			if (!model) {
				ctx.ui.notify("/fast is available when an OpenAI model is selected.", "warning");
				return;
			}
			if (!supportsFast(model)) {
				ctx.ui.notify(`OpenAI fast mode is not available for ${model.id}.`, "warning");
				return;
			}

			if (command === "status") {
				ctx.ui.notify(`OpenAI fast mode is ${current ? "enabled" : "disabled"}.`, "info");
				return;
			}

			let enabled: boolean;
			if (command === "menu") {
				const fastOption = `${current ? "✓ " : ""}Fast — priority processing, increased usage`;
				const standardOption = `${current ? "" : "✓ "}Standard — normal speed and usage`;
				const selected = await ctx.ui.select("OpenAI response speed", [fastOption, standardOption]);
				if (!selected) return;
				enabled = selected === fastOption;
			} else if (!command || command === "toggle") enabled = !current;
			else if (["on", "enable", "enabled", "fast"].includes(command)) enabled = true;
			else if (["off", "disable", "disabled", "standard"].includes(command)) enabled = false;
			else {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			store.write(enabled);
			ctx.ui.setStatus("codex-fast", enabled ? "Enabled" : "Standard");
			ctx.ui.notify(
				enabled
					? "OpenAI fast mode enabled — priority processing, increased usage."
					: "OpenAI fast mode disabled — standard speed and usage.",
				"info",
			);
		},
	});
}

export default function codexFast(pi: ExtensionAPI): void {
	registerCodexFast(pi, new FileFastModeStore());
}
