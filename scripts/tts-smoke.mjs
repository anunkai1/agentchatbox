// Headless browser smoke test for the agentchatbox UI — TTS edition.
// Verifies auto-speak triggers on assistant message_end and that the
// shared <audio> element receives a playable source.
import { chromium } from "/home/hermes/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
	headless: true,
	executablePath: "/home/hermes/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
	args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (msg) => {
	if (msg.type() === "error" || msg.type() === "warning") {
		console.log(`[console.${msg.type()}] ${msg.text()}`);
	}
});

await page.goto("http://127.0.0.1:3500/", { waitUntil: "load", timeout: 10000 });
await page.waitForSelector("#input", { timeout: 10000 });
await page.waitForFunction(
	() => /M3/.test(document.querySelector("#status-bar")?.textContent || ""),
	{ timeout: 10000 },
);

// Toggle auto-speak on.
await page.click("#tts-toggle");
console.log("auto-speak on. button text:", await page.locator("#tts-toggle").textContent());

// Send a short prompt and wait for assistant response + TTS fetch.
await page.locator("#input").fill("Reply with exactly: SHOUT IT BACK");
await page.keyboard.press("Enter");

// Wait for streaming to end.
await page.waitForFunction(
	() => document.querySelectorAll(".text.streaming").length === 0,
	{ timeout: 30000 },
);
console.log("assistant message done");

// Wait for the TTS fetch (look for the ● tts or ♪ playing indicator, or
// the <audio> src changing).
const ttsHappened = await page.waitForFunction(
	() => {
		const sb = document.querySelector("#status-bar")?.textContent || "";
		const audio = document.querySelector("#tts-audio");
		return /tts|playing/.test(sb) || (audio && audio.src && audio.src.startsWith("blob:"));
	},
	{ timeout: 20000 },
);
console.log("TTS triggered. status-bar:", await page.locator("#status-bar").textContent());
console.log("audio src starts with blob:", (await page.locator("#tts-audio").getAttribute("src") || "").startsWith("blob:"));

// Click the per-message speak button on the same assistant message to verify
// manual replay also works.
await page.locator(".speak-btn").first().click();
console.log("clicked per-message speak. status-bar:", await page.locator("#status-bar").textContent());

// Final state.
console.log("\n--- final DOM ---");
const finalDom = await page.evaluate(() => {
	const rows = document.querySelectorAll(".row");
	return Array.from(rows).map((r) => {
		const role = r.querySelector(".role")?.textContent ?? "?";
		const text = r.querySelector(".body, .tool-name, .tool-result")?.textContent?.slice(0, 200) ?? "";
		return `${role} ${text}`;
	});
});
for (const line of finalDom) console.log("  " + line);

console.log("\n--- errors ---");
for (const e of errors) console.log("  " + e);

await page.screenshot({ path: "/tmp/agentchatbox-tts.png", fullPage: true });
console.log("\nscreenshot: /tmp/agentchatbox-tts.png");

await browser.close();
console.log("done");
