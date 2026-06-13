import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.goto("http://127.0.0.1:3500/", { waitUntil: "networkidle", timeout: 10000 });
await page.waitForTimeout(1500);

// Inspect the input/send area
const inputHtml = await page.evaluate(() => {
  const ed = document.querySelector('message-editor');
  if (!ed) return "(no message-editor)";
  // Return the input/textarea + nearby buttons
  const all = ed.querySelectorAll('button, textarea, input, [role="button"]');
  return Array.from(all).map(el => ({
    tag: el.tagName,
    type: el.getAttribute('type'),
    text: (el.innerText || el.value || el.placeholder || '').slice(0, 60),
    classes: el.className?.slice(0, 80) ?? '',
    aria: el.getAttribute('aria-label'),
  }));
});
console.log(JSON.stringify(inputHtml, null, 2));

await browser.close();
