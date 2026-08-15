import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FastModeStore {
	read(): boolean;
	write(enabled: boolean): void;
}

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

function currentCodexModel(ctx: { model?: { provider: string; id: string } }): string | null {
	return ctx.model?.provider === "openai-codex" ? ctx.model.id : null;
}

/**
 * Register Codex fast mode with pi. The extension owns the setting and request
 * rewrite; AgentChatBox only forwards `/fast` through pi RPC.
 */
export function registerCodexFast(
	pi: ExtensionAPI,
	store: FastModeStore,
	supportedModels: ReadonlySet<string> = loadFastCodexModels(),
): void {
	pi.on("before_provider_request", (event, ctx) => {
		const modelId = currentCodexModel(ctx);
		if (!modelId || !supportedModels.has(modelId) || !store.read()) return;
		if (!isObjectPayload(event.payload) || event.payload.model !== modelId) return;

		// Codex labels the user-facing choice "fast", while its catalogue maps
		// that choice to the Responses API's `priority` service-tier id.
		return { ...event.payload, service_tier: "priority" };
	});

	pi.registerCommand("fast", {
		description: "toggle Codex fast mode (1.5x speed, increased usage)",
		handler: async (rawArgs, ctx) => {
			const command = rawArgs.trim().toLowerCase();
			const current = store.read();
			if (command === "report") {
				ctx.ui.setStatus("codex-fast", current ? "Enabled" : "Standard");
				return;
			}

			const modelId = currentCodexModel(ctx);
			if (!modelId) {
				ctx.ui.notify("/fast is available when an OpenAI Codex model is selected.", "warning");
				return;
			}
			if (!supportedModels.has(modelId)) {
				ctx.ui.notify(`Codex fast mode is not available for ${modelId}.`, "warning");
				return;
			}

			if (command === "status") {
				ctx.ui.notify(`Codex fast mode is ${current ? "enabled" : "disabled"}.`, "info");
				return;
			}

			let enabled: boolean;
			if (command === "menu") {
				const fastOption = `${current ? "✓ " : ""}Fast — 1.5× speed, increased usage`;
				const standardOption = `${current ? "" : "✓ "}Standard — normal speed and usage`;
				const selected = await ctx.ui.select("Codex response speed", [fastOption, standardOption]);
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
					? "Codex fast mode enabled — 1.5x speed, increased usage."
					: "Codex fast mode disabled — standard speed and usage.",
				"info",
			);
		},
	});
}

export default function codexFast(pi: ExtensionAPI): void {
	registerCodexFast(pi, new FileFastModeStore());
}
