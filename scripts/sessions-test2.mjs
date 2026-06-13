// Open sessions dialog via the header ≡ button, not via slash command.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
const consoleMsgs = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// First, send a prompt to populate a session
await page.click("#input");
await page.type("#input", "Reply with just OK.");
await page.click("#send-btn");
await page.waitForSelector(".row-assistant .text:not(.streaming)", { timeout: 30000 });
await page.waitForTimeout(1000);

// Test 1: click the ≡ button
console.log("=== Test 1: click ≡ button ===");
const sessionsBtn = await page.$$('button[title*="Sessions"]');
console.log(`found ${sessionsBtn.length} sessions button(s)`);
await sessionsBtn[0].click();
await page.waitForTimeout(500);
const result1 = await page.evaluate(() => {
	const rows = Array.from(document.querySelectorAll(".session-row")).map((r) => ({
		title: r.querySelector(".session-title")?.textContent,
		meta: r.querySelector(".session-meta")?.textContent,
	}));
	return { rows, hasOverlay: !!document.querySelector(".modal-overlay") };
});
console.log(JSON.stringify(result1, null, 2));

// Close dialog
const closeBtn = await page.$(".modal-overlay .btn");
if (closeBtn) await closeBtn.click();
await page.waitForTimeout(300);

// Test 2: type /sessions and press Enter
console.log("=== Test 2: type /sessions + Enter ===");
await page.click("#input");
await page.type("#input", "/sessions");
await page.press("#input", "Enter");
await page.waitForTimeout(500);
const result2 = await page.evaluate(() => {
	const rows = Array.from(document.querySelectorAll(".session-row")).map((r) => ({
		title: r.querySelector(".session-title")?.textContent,
		meta: r.querySelector(".session-meta")?.textContent,
	}));
	return { rows, hasOverlay: !!document.querySelector(".modal-overlay") };
});
console.log(JSON.stringify(result2, null, 2));

await page.screenshot({ path: "/tmp/sessions-test2.png", fullPage: true });
await browser.close();
errors.forEach(e => console.log("err:", e));
consoleMsgs.slice(-10).forEach(m => console.log(m));
