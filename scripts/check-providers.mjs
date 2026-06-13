import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE: " + msg.text()); });

await page.goto("http://127.0.0.1:3500/", { waitUntil: "networkidle", timeout: 10000 });
await page.waitForTimeout(1500); // give time for seedProviders() to write to IndexedDB

// Inspect IndexedDB
const providers = await page.evaluate(async () => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("agentchatbox");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const stores = Array.from(db.objectStoreNames);
      if (!stores.includes("custom-providers")) {
        db.close();
        resolve({ error: "no custom-providers store. Have: " + stores.join(",") });
        return;
      }
      const tx = db.transaction("custom-providers", "readonly");
      const store = tx.objectStore("custom-providers");
      const all = store.getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result);
      };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  });
});

console.log("=== ERRORS ===");
errors.forEach((e) => console.log(e));
console.log("=== CUSTOM PROVIDERS IN INDEXEDDB ===");
console.log(JSON.stringify(providers, null, 2));
console.log("=== M3 present? ===");
const minimax = Array.isArray(providers) ? providers.find((p) => p.id === "minimax") : null;
console.log(minimax ? "yes — provider id 'minimax' registered" : "no — not found");
if (minimax) {
  const m3 = minimax.models?.find((m) => m.id === "MiniMax-M3");
  console.log("MiniMax-M3 model:", m3 ? `yes (contextWindow: ${m3.contextWindow})` : "no");
}

await browser.close();
