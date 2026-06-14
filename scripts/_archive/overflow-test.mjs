// Test that the overflow menu opens and lists all 4 settings on mobile viewport.
import { chromium } from "playwright";

const URL = process.env.URL || "http://192.168.0.148:3500/";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
	viewport: { width: 390, height: 1080 },
	isMobile: true,
	hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// Click the overflow menu
await page.click("#overflow-menu");
await page.waitForTimeout(300);

// Read the menu contents
const rows = await page.$$eval(".overflow-row", (els) =>
	els.map((e) => ({
		label: e.querySelector(".overflow-label")?.textContent ?? "?",
		value: e.querySelector(".overflow-value")?.textContent ?? "?",
	})),
);

const path = "/tmp/overflow-menu.png";
await page.screenshot({ path });
await browser.close();

console.log("=== overflow rows ===");
console.log(JSON.stringify(rows, null, 2));
console.log("=== errors ===");
errors.forEach((e) => console.log(e));
console.log(`screenshot: ${path}`);
