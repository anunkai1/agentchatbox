import { describe, expect, it, vi } from "vitest";
import {
	FAST_CODEX_MODELS,
	type FastModeStore,
	registerCodexFast,
} from "../extensions/codex-fast/index.js";

type Context = {
	model?: { provider: string; id: string };
	ui: {
		notify(message: string, level: string): void;
		select(title: string, options: string[]): Promise<string | undefined>;
		setStatus(key: string, text: string | undefined): void;
	};
};
type CommandHandler = (args: string, ctx: Context) => Promise<void>;
type ProviderRequestHandler = (event: { payload: unknown }, ctx: Context) => unknown;

function harness(initial = false) {
	let enabled = initial;
	const store: FastModeStore = {
		read: () => enabled,
		write: (next) => {
			enabled = next;
		},
	};
	let commandHandler: CommandHandler | undefined;
	let providerRequestHandler: ProviderRequestHandler | undefined;
	const notify = vi.fn();
	const select = vi.fn(async (_title: string, options: string[]) => options[0]);
	const setStatus = vi.fn();
	registerCodexFast(
		{
			registerCommand(_name: string, options: { handler: CommandHandler }) {
				commandHandler = options.handler;
			},
			on(event: string, handler: ProviderRequestHandler) {
				if (event === "before_provider_request") providerRequestHandler = handler;
			},
		} as never,
		store,
		FAST_CODEX_MODELS,
	);
	return {
		get enabled() {
			return enabled;
		},
		command: commandHandler!,
		providerRequest: providerRequestHandler!,
		notify,
		select,
		setStatus,
		codexCtx: {
			model: { provider: "openai-codex", id: "gpt-5.6-terra" },
			ui: { notify, select, setStatus },
		},
	};
}

describe("OpenAI fast pi extension", () => {
	it.each([
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-6.1-sol",
	])("supports %s on the current OpenAI provider without relying on the legacy Codex catalogue", async (id) => {
		const h = harness(false);
		const ctx = { ...h.codexCtx, model: { provider: "openai", id } };
		await h.command("on", ctx);
		expect(h.enabled).toBe(true);
		expect(h.providerRequest({ payload: { model: id, stream: true } }, ctx)).toEqual({
			model: id,
			stream: true,
			service_tier: "priority",
		});
	});

	it("leaves standard mode requests unchanged on the current OpenAI provider", () => {
		const h = harness(false);
		expect(
			h.providerRequest(
				{ payload: { model: "gpt-6.1-sol" } },
				{ ...h.codexCtx, model: { provider: "openai", id: "gpt-6.1-sol" } },
			),
		).toBeUndefined();
	});

	it("does not assume every OpenAI model supports Fast", async () => {
		const h = harness(true);
		const ctx = { ...h.codexCtx, model: { provider: "openai", id: "gpt-4o" } };
		await h.command("on", ctx);
		expect(h.enabled).toBe(true);
		expect(h.notify).toHaveBeenLastCalledWith(
			"OpenAI fast mode is not available for gpt-4o.",
			"warning",
		);
		expect(h.providerRequest({ payload: { model: "gpt-4o" } }, ctx)).toBeUndefined();
	});

	it("tracks the Codex models whose live catalogue advertises Fast", () => {
		expect(FAST_CODEX_MODELS.has("gpt-5.6-terra")).toBe(true);
		expect(FAST_CODEX_MODELS.has("gpt-5.4-mini")).toBe(false);
	});

	it("maps enabled Fast mode to the priority wire service tier", () => {
		const h = harness(true);
		expect(
			h.providerRequest({ payload: { model: "gpt-5.6-terra", stream: true } }, h.codexCtx),
		).toEqual({ model: "gpt-5.6-terra", stream: true, service_tier: "priority" });
	});

	it("does not rewrite another model or provider request", () => {
		const h = harness(true);
		expect(h.providerRequest({ payload: { model: "gpt-5.6-luna" } }, h.codexCtx)).toBeUndefined();
		expect(
			h.providerRequest(
				{ payload: { model: "gpt-5.6-terra" } },
				{ ...h.codexCtx, model: { provider: "openrouter", id: "gpt-5.6-terra" } },
			),
		).toBeUndefined();
	});

	it("toggles and persists fast mode through the extension-owned store", async () => {
		const h = harness(false);
		await h.command("", h.codexCtx);
		expect(h.enabled).toBe(true);
		expect(h.notify).toHaveBeenLastCalledWith(
			"OpenAI fast mode enabled — priority processing, increased usage.",
			"info",
		);

		await h.command("off", h.codexCtx);
		expect(h.enabled).toBe(false);
	});

	it("reports status without changing the setting", async () => {
		const h = harness(true);
		await h.command("status", h.codexCtx);
		expect(h.enabled).toBe(true);
		expect(h.notify).toHaveBeenLastCalledWith("OpenAI fast mode is enabled.", "info");
	});

	it("publishes the current GUI label through the generic extension status relay", async () => {
		const h = harness(true);
		await h.command("report", {
			...h.codexCtx,
			model: { provider: "openrouter", id: "gpt-5.6-terra" },
		});
		expect(h.setStatus).toHaveBeenCalledWith("codex-fast", "Enabled");
		expect(h.notify).not.toHaveBeenCalled();
	});

	it.each([
		{ provider: "openai", id: "gpt-6.1-sol" },
		{ provider: "openai-codex", id: "gpt-5.6-terra" },
	])("opens the speed picker for $provider/$id", async (model) => {
		const h = harness(true);
		h.select.mockImplementationOnce(async (_title, options) => options[1]);
		await h.command("menu", { ...h.codexCtx, model });

		expect(h.select).toHaveBeenCalledWith("OpenAI response speed", [
			"✓ Fast — priority processing, increased usage",
			"Standard — normal speed and usage",
		]);
		expect(h.enabled).toBe(false);
		expect(h.setStatus).toHaveBeenLastCalledWith("codex-fast", "Standard");
		expect(h.notify).toHaveBeenLastCalledWith(
			"OpenAI fast mode disabled — standard speed and usage.",
			"info",
		);
	});

	it("rejects unsupported Codex models and other providers", async () => {
		const h = harness(false);
		await h.command("on", {
			...h.codexCtx,
			model: { provider: "openai-codex", id: "gpt-5.4-mini" },
		});
		expect(h.enabled).toBe(false);
		expect(h.notify).toHaveBeenLastCalledWith(
			"OpenAI fast mode is not available for gpt-5.4-mini.",
			"warning",
		);

		await h.command("on", {
			...h.codexCtx,
			model: { provider: "openrouter", id: "gpt-5.6-terra" },
		});
		expect(h.enabled).toBe(false);
	});
});
