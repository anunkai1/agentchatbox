import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
const allConsole = [];
const requests = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (msg) => allConsole.push(`[${msg.type()}] ${msg.text()}`));
page.on("request", (req) => requests.push(req.method() + " " + req.url()));

// Stub /api/stream to return success
await page.route("**/api/stream", async (route) => {
  console.log("[stub] /api/stream called");
  const ts = Date.now();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (text, usage) => ({
    role: "assistant", content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages", provider: "minimax", model: "MiniMax-M3",
    usage, stopReason: "stop", timestamp: ts,
  });
  const body = [
    `event: message\ndata: ${JSON.stringify({ type: "start", partial: assistant("", zero) })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "text_start", contentIndex: 0, partial: assistant("", zero) })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "text_delta", contentIndex: 0, delta: "Got it!", partial: assistant("Got it!", { ...zero, input: 10, output: 3, totalTokens: 13 }) })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "done", reason: "stop", message: assistant("Got it!", { ...zero, input: 10, output: 3, totalTokens: 13 }) })}\n\n`,
  ].join("");
  await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "Cache-Control": "no-cache" }, body });
});

await page.goto("http://127.0.0.1:3500/", { waitUntil: "networkidle", timeout: 10000 });
await page.waitForTimeout(2000);

// Check default model displayed in the top bar
const defaultModelShown = await page.evaluate(() => {
  // The model button shows the current model name
  const all = Array.from(document.querySelectorAll('button'));
  const modelBtn = all.find(b => {
    const t = b.innerText;
    return t && (t.includes('MiniMax') || t.includes('claude') || t.includes('gpt'));
  });
  return modelBtn?.innerText ?? "(no model button found)";
});
console.log("[step] default model in top bar:", defaultModelShown);

// Pre-seed a key in ProviderKeysStore so dialog doesn't appear
await page.evaluate(async () => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("agentchatbox");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("provider-keys", "readwrite");
      tx.objectStore("provider-keys").put("sk-test-minimax-key", "minimax");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
});
console.log("[step] pre-seeded 'minimax' key in ProviderKeysStore");

// Type into the textarea
const editor = page.locator('message-editor textarea').first();
await editor.click();
await page.keyboard.type("Hello M3");
console.log("[step] typed 'Hello M3'");

// Inspect editor state to confirm value
const editorValue = await editor.inputValue();
console.log("[step] editor value:", editorValue);

// Try pressing Enter to send
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);

console.log("=== ERRORS ===");
errors.forEach((e) => console.log(e));
console.log("=== /api/* REQUESTS ===");
requests.filter(r => r.includes("/api/")).forEach((r) => console.log(r));
console.log("=== APP TEXT (first 400) ===");
const appText = await page.evaluate(() => document.getElementById("app")?.innerText?.slice(0, 400) ?? "");
console.log(appText);

await browser.close();
