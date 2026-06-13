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

// Wait for the assistant response to finish streaming
await page.waitForSelector(".row-assistant .text:not(.streaming)", { timeout: 30000 });
await page.waitForTimeout(500);

const result = await page.evaluate(() => {
  const assistantRow = document.querySelector(".row-assistant");
  const thinkingBlocks = Array.from(document.querySelectorAll(".row-assistant .thinking")).map(b => ({
    visible: getComputedStyle(b).display !== "none",
    toggleText: b.querySelector(".thinking-toggle")?.textContent,
    bodyTextLen: b.querySelector(".thinking-body")?.textContent?.length ?? 0,
    bodySample: b.querySelector(".thinking-body")?.textContent?.slice(0, 100),
  }));
  return {
    thinkingBlocks,
    textSample: assistantRow?.querySelector(".text")?.textContent?.slice(0, 200),
  };
});

await page.screenshot({ path: "/tmp/thinking-test.png", fullPage: true });
await browser.close();
console.log(JSON.stringify(result, null, 2));
errors.forEach(e => console.log("err:", e));
