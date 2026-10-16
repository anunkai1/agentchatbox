import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Keep only GPT-6 and later. This drops every older text model (GPT-4.x,
 * GPT-5.x, o-series) and the models a ChatGPT login is refused
 * (gpt-daybreak-*, gpt-realtime-*), while future gpt-7+ stay visible.
 */
export function keepOpenAIModel(id: string): boolean {
	const major = /^gpt-(\d+)/.exec(id)?.[1];
	return major !== undefined && Number(major) >= 6;
}

/**
 * models.json can only add or replace models; a provider registered with
 * `models` replaces the whole list. The list is read from the registry at
 * session start so newer catalogue entries still come from pi.
 */
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const all = ctx.modelRegistry.getModelsOfType("chat", "openai");
		const kept = all.filter((m) => keepOpenAIModel(m.id));
		if (kept.length === 0 || kept.length === all.length) return;
		pi.registerProvider("openai", { models: kept });
	});
}
