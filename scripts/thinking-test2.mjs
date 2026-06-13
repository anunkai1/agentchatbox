import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

await page.click("#input");
await page.type("#input", "Think step by step about why the sky is blue, then answer in one sentence.");
await page.click("#send-btn");
await page.waitForSelector(".row-assistant .text:not(.streaming)", { timeout: 30000 });
await page.waitForTimeout(500);

// Click the thinking toggle to expand
const beforeExpand = await page.evaluate(() => {
  const body = document.querySelector(".row-assistant .thinking-body");
  return { hidden: body?.classList.contains("hidden"), display: getComputedStyle(body).display };
});
await page.click(".row-assistant .thinking-toggle");
await page.waitForTimeout(200);
const afterExpand = await page.evaluate(() => {
  const body = document.querySelector(".row-assistant .thinking-body");
  return { hidden: body?.classList.contains("hidden"), display: getComputedStyle(body).display };
});

// Reload page — should restore from IndexedDB and show thinking
await page.waitForTimeout(500);
const beforeReload = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".row-assistant .thinking")).map(b => ({
    visible: getComputedStyle(b).display !== "none",
    bodyHidden: b.querySelector(".thinking-body")?.classList.contains("hidden"),
    bodyLen: b.querySelector(".thinking-body")?.textContent?.length,
  }));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
const afterReload = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".row-assistant .thinking")).map(b => ({
    visible: getComputedStyle(b).display !== "none",
    bodyHidden: b.querySelector(".thinking-body")?.classList.contains("hidden"),
    bodyLen: b.querySelector(".thinking-body")?.textContent?.length,
  }));
});

await page.screenshot({ path: "/tmp/thinking-test2.png" });
await browser.close();
console.log("=== expand toggle ===");
console.log("before:", JSON.stringify(beforeExpand));
console.log("after :", JSON.stringify(afterExpand));
console.log("=== after live streaming ===");
console.log("blocks:", JSON.stringify(beforeReload));
console.log("=== after page reload (IndexedDB restore) ===");
console.log("blocks:", JSON.stringify(afterReload));
errors.forEach(e => console.log("err:", e));
