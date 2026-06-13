import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
const allConsole = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (msg) => allConsole.push(`[${msg.type()}] ${msg.text()}`));
page.on("requestfailed", (req) => errors.push("REQ FAIL: " + req.url() + " " + req.failure()?.errorText));

// Stub the API stream to return 401 (simulating no server key configured)
await page.route("**/api/stream", async (route) => {
  if (route.request().method() === "POST") {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: 'no API key configured on the server for provider "minimax"' }),
    });
  } else {
    await route.continue();
  }
});

await page.goto("http://127.0.0.1:3500/", { waitUntil: "networkidle", timeout: 10000 });
await page.waitForTimeout(1500);

// Type a message
const editor = await page.locator('message-editor').first();
await editor.click();
await page.keyboard.type("Hello M3");
await page.waitForTimeout(200);

// Click send
const sendBtn = await page.locator('message-editor button:has-text("Send")').first();
const sendBtnCount = await sendBtn.count();
console.log("send button count:", sendBtnCount);
if (sendBtnCount > 0) {
  await sendBtn.click();
  console.log("clicked send");
} else {
  console.log("no send button found");
}

await page.waitForTimeout(2000);

// Check what happened
const appState = await page.evaluate(() => {
  const app = document.getElementById("app");
  return app?.innerText?.slice(0, 800) ?? "(no app)";
});

console.log("=== ERRORS ===");
errors.forEach((e) => console.log(e));
console.log("=== CONSOLE (last 20) ===");
allConsole.slice(-20).forEach((m) => console.log(m));
console.log("=== APP TEXT (after send) ===");
console.log(appState);

await browser.close();
