import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
const allConsole = [];
const requests = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message + (e.stack ? "\n  " + e.stack.split("\n")[1] : "")));
page.on("console", (msg) => allConsole.push(`[${msg.type()}] ${msg.text()}`));
page.on("request", (req) => requests.push(req.method() + " " + req.url()));
page.on("requestfailed", (req) => errors.push("REQ FAIL: " + req.url() + " " + req.failure()?.errorText));
page.on("response", (res) => {
  if (res.url().includes("/api/")) console.log("[resp]", res.status(), res.url());
});

await page.goto("http://127.0.0.1:3500/", { waitUntil: "networkidle", timeout: 10000 });
await page.waitForTimeout(2000);

console.log("=== ALL CONSOLE (incl. log) ===");
allConsole.forEach((m) => console.log(m));
console.log("=== PAGE ERRORS ===");
errors.forEach((e) => console.log(e));
console.log("=== ALL REQUESTS ===");
requests.forEach((r) => console.log(r));

await browser.close();
