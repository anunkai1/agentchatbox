/**
 * One-off script: call MiniMax M3 (anthropic-messages API at
 * https://api.minimax.io/anthropic) with a base64 image to analyze the
 * z.ai Android layout screenshot. We don't have multimodal input
 * ourselves, so we use the project's configured MiniMax key to do the
 * vision work and print the textual description to stdout.
 *
 * Usage: node scripts/analyze-screenshot.mjs <path-to-image>
 */
import { readFileSync } from "node:fs";

const KEY = process.env.MiniMax_API_KEY;
if (!KEY) {
	console.error("Missing MiniMax_API_KEY env var");
	process.exit(1);
}

const imgPath = process.argv[2] ?? "/tmp/zai_small.jpg";
const b64 = readFileSync(imgPath).toString("base64");

const prompt = `You are a UI/UX expert analyzing a screenshot of the z.ai chat app on Android (viewed in a browser). Describe the LAYOUT in precise detail so a developer can reimplement it. Cover:

1. TOP BAR: Is there a top header bar? What does it contain (hamburger/sidebar toggle, current model name / model selector chip, new-chat button, settings)? Describe exact placement (left/center/right), icons, and how the model is shown/selected at the top.
2. SIDE BAR: Is there a sidebar (drawer)? What does it contain (conversation history list, "new chat", account, settings, collapse toggle)? How is it opened/closed on mobile? Is it an overlay drawer or persistent?
3. MAIN CHAT AREA: empty state, centered prompt box, suggested prompts, spacing.
4. COMPOSER / INPUT BAR at the bottom: rounded pill shape, attach/upload button, mic/voice, send button, model/speed/thinking controls placement.
5. COLORS, spacing, typography, whether it looks clean/minimal, dark or light theme.
6. Any other distinctive UI elements.

Be specific about left/right placement and ordering. Output as a structured description.`;

const body = {
	model: "MiniMax-M3",
	max_tokens: 4096,
	thinking: { type: "disabled" },
	messages: [
		{
			role: "user",
			content: [
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
				{ type: "text", text: prompt },
			],
		},
	],
};

const res = await fetch("https://api.minimax.io/anthropic/v1/messages", {
	method: "POST",
	headers: {
		"content-type": "application/json",
		"x-api-key": KEY,
		anthropic_version: "1.7",
	},
	body: JSON.stringify(body),
});

if (!res.ok) {
	console.error("HTTP", res.status, await res.text());
	process.exit(1);
}

const data = await res.json();
for (const block of data.content ?? []) {
	if (block.type === "text") process.stdout.write(block.text);
}
console.log("\n\n--- usage ---");
console.log(JSON.stringify(data.usage));
