import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

let streamRequestBody = null;
page.on("request", (req) => {
  if (req.url().endsWith("/api/stream") && req.method() === "POST") {
    try { streamRequestBody = JSON.parse(req.postData() || "{}"); } catch {}
  }
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

// Stub the API stream
await page.route("**/api/stream", async (route) => {
  const ts = Date.now();
  const assistant = (content, usage) => ({
    role: "assistant", content, api: "anthropic-messages", provider: "minimax",
    model: "MiniMax-M3", usage, stopReason: "stop", timestamp: ts,
  });
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const body = [
    `event: message\ndata: ${JSON.stringify({ type: "start", partial: assistant([], zero) })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }], zero) })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "text_delta", contentIndex: 0, delta: "Hi back!", partial: assistant([{ type: "text", text: "Hi back!" }], { ...zero, input: 10, output: 3, totalTokens: 13 }) })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "Hi back!" }], { ...zero, input: 10, output: 3, totalTokens: 13 }) })}\n\n`,
  ].join("");
  await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "Cache-Control": "no-cache" }, body });
});

await page.goto("http://127.0.0.1:3500/", { waitUntil: "networkidle", timeout: 10000 });
await page.waitForTimeout(1500);

// Pre-seed: write a key to ProviderKeysStore for anthropic, then change default model
// Actually, let's just write a key for the DEFAULT provider (anthropic)
await page.evaluate(async () => {
  return new Promise((resolve) => {
    const req = indexedDB.open("agentchatbox");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("provider-keys", "readwrite");
      tx.objectStore("provider-keys").put("sk-test-from-browser-1234", "anthropic");
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  });
});
console.log("[test] wrote fake key 'sk-test-from-browser-1234' to ProviderKeysStore for 'anthropic'");

// Type message and press Enter
const editor = page.locator('message-editor textarea').first();
await editor.click();
await page.keyboard.type("Test message");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);

console.log("=== STREAM REQUEST MODEL ===", streamRequestBody?.model?.id);
console.log("=== STREAM REQUEST MODEL.provider ===", streamRequestBody?.model?.provider);
console.log("=== STREAM REQUEST OPTIONS ===", JSON.stringify(streamRequestBody?.options, null, 2));
console.log("=== STREAM REQUEST options.apiKey (first 20) ===", streamRequestBody?.options?.apiKey?.slice(0, 20));
console.log("=== KEY FROM STORE REACHED SERVER? ===", streamRequestBody?.options?.apiKey === "sk-test-from-browser-1234" ? "YES ✓" : "NO ✗");

const appText = await page.evaluate(() => document.getElementById("app")?.innerText?.slice(0, 600) ?? "");
console.log("=== APP TEXT ===");
console.log(appText);

await browser.close();
