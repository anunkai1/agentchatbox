import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE: " + msg.text()); });

await page.route("**/api/stream", async (route) => {
  const ts = Date.now();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (text, usage) => ({
    role: "assistant", content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages", provider: "minimax", model: "MiniMax-M3",
    usage, stopReason: "stop", timestamp: ts,
  });
  const events = [
    { type: "start", partial: assistant("", zero) },
    { type: "text_start", contentIndex: 0, partial: assistant("", zero) },
    { type: "text_delta", contentIndex: 0, delta: "Hi from M3", partial: assistant("Hi from M3", { ...zero, input: 8, output: 4, totalTokens: 12 }) },
    { type: "done", reason: "stop", message: assistant("Hi from M3", { ...zero, input: 8, output: 4, totalTokens: 12 }) },
  ];
  const sse = events.map(e => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join("");
  await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse });
});

await page.goto("http://127.0.0.1:3500/", { waitUntil: "load", timeout: 10000 });
await page.waitForSelector("#input", { timeout: 10000 });

// Pre-seed key
await page.evaluate(async () => {
  return new Promise((resolve) => {
    const req = indexedDB.open("agentchatbox");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("provider-keys", "readwrite");
      tx.objectStore("provider-keys").put("sk-test-key", "minimax");
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  });
});

const editor = page.locator('#input');
await editor.fill("Hello");
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);

const state = await page.evaluate(() => {
  const msgs = Array.from(document.querySelectorAll('.msg')).map(m => ({
    role: m.dataset.role,
    text: m.querySelector('.msg-body')?.textContent?.slice(0, 200),
  }));
  return { msgs, appText: document.getElementById("app")?.innerText?.slice(0, 600) };
});

console.log("=== ERRORS ===");
errors.forEach((e) => console.log(e));
console.log("=== MESSAGES ===");
console.log(JSON.stringify(state.msgs, null, 2));
console.log("=== APP TEXT ===");
console.log(state.appText);

await browser.close();
