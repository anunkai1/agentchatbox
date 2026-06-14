import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on("console", (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log("err:", e.message));
await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

await page.evaluate(() => { window.confirm = () => true; });
await page.click("#input");
await page.type("#input", "/resume");
console.log("input before Enter:", await page.$eval("#input", el => el.value));
await page.press("#input", "Enter");
await page.waitForTimeout(1500);
const r = await page.evaluate(() => ({
	hasModal: !!document.querySelector(".modal-overlay"),
	status: document.querySelector("#status-bar")?.textContent,
}));
console.log("result:", r);
await browser.close();
