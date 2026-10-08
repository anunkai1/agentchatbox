import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Venice prepends its own system prompt (the "I am <model>, running on
 * Venice" persona) unless `venice_parameters.include_venice_system_prompt`
 * is false. Turn it off so only Pi's prompt reaches the model.
 */
export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (ctx.model?.provider !== "venice") return;
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;

		const existing = (payload as { venice_parameters?: object }).venice_parameters;
		return { ...payload, venice_parameters: { ...existing, include_venice_system_prompt: false } };
	});
}
