// Trace what happens on /sessions
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

// Populate one session
await page.click("#input");
await page.type("#input", "Reply with just OK.");
await page.click("#send-btn");
await page.waitForSelector(".row-assistant .text:not(.streaming)", { timeout: 30000 });
await page.waitForTimeout(1500);

console.log("--- typing /sessions ---");
await page.click("#input");
await page.type("#input", "/sessions");
const inputValueBefore = await page.$eval("#input", el => el.value);
console.log("input value before Enter:", JSON.stringify(inputValueBefore));

await page.press("#input", "Enter");

// Check IMMEDIATELY
await page.waitForTimeout(50);
const r1 = await page.evaluate(() => ({
  hasOverlay: !!document.querySelector(".modal-overlay"),
  inputValue: document.querySelector("#input")?.value,
}));
console.log("50ms after Enter:", r1);

await page.waitForTimeout(450);
const r2 = await page.evaluate(() => ({
  hasOverlay: !!document.querySelector(".modal-overlay"),
  inputValue: document.querySelector("#input")?.value,
  sessions: document.querySelectorAll(".session-row").length,
}));
console.log("500ms after Enter:", r2);

await page.waitForTimeout(2000);
const r3 = await page.evaluate(() => ({
  hasOverlay: !!document.querySelector(".modal-overlay"),
  inputValue: document.querySelector("#input")?.value,
  sessions: document.querySelectorAll(".session-row").length,
}));
console.log("2.5s after Enter:", r3);

await page.screenshot({ path: "/tmp/sessions-test3.png" });
await browser.close();
errors.forEach(e => console.log("err:", e));
consoleMsgs.slice(-15).forEach(m => console.log(m));
