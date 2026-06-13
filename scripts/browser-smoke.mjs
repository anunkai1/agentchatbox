// Headless browser test for the agentchatbox UI.
// Opens the page, verifies the renderer loads, sends a prompt that triggers
// a tool call, and prints the final DOM state.
import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
	headless: true,
	executablePath: "/home/hermes/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
	args: ["--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
const consoleLines = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));

await page.goto("http://127.0.0.1:3500/", { waitUntil: "load", timeout: 10000 });
await page.waitForSelector("#input", { timeout: 10000 });

// Wait a moment for WS to connect and the "ready" event to land.
await page.waitForFunction(
	() => {
		const sb = document.querySelector("#status-bar");
		return sb && /M3|model/i.test(sb.textContent || "");
	},
	{ timeout: 10000 },
);

// Check that the dark monospace theme is applied (background should be dark).
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
console.log("body bg:", bg);
console.log("body font:", font);
console.log("status-bar:", await page.locator("#status-bar").textContent());

// Send a real prompt that triggers bash.
await page.locator("#input").fill("Run `bash` with command `echo BROWSER_TEST_OK`. Show me the result.");
await page.keyboard.press("Enter");

// Wait for the tool row to appear.
const toolRow = page.locator(".row-tool").first();
await toolRow.waitFor({ timeout: 30000 });
console.log("\n--- tool row appeared ---");
const toolName = await toolRow.locator(".tool-name").textContent();
const toolResult = await toolRow.locator(".tool-result").textContent({ timeout: 20000 });
console.log("tool name:", toolName);
console.log("tool result:", toolResult?.slice(0, 200));

// Wait for the agent to finish (no streaming cursor).
await page.waitForFunction(
	() => document.querySelectorAll(".text.streaming").length === 0,
	{ timeout: 30000 },
);

console.log("\n--- final DOM state ---");
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
console.log("\n--- console (last 10) ---");
for (const l of consoleLines.slice(-10)) console.log("  " + l);

// Screenshot for visual verification.
await page.screenshot({ path: "/tmp/agentchatbox-screenshot.png", fullPage: true });
console.log("\nscreenshot: /tmp/agentchatbox-screenshot.png");

await browser.close();
console.log("\ndone");
