// Android smoke test — Android UA + mobile viewport, captures console errors and screenshot.
import { chromium } from "playwright";

const URL = process.env.URL || "http://192.168.0.148:3500/";
const VIEWPORT = { width: 390, height: 844 };
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: UA,
  viewport: VIEWPORT,
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

const errors = [];
const consoleMsgs = [];
page.on("console", (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack}`));
page.on("requestfailed", (r) => errors.push(`reqfail: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(URL, { waitUntil: "networkidle", timeout: 15000 }).catch((e) => errors.push(`goto: ${e.message}`));
await page.waitForTimeout(2500);

const visible = await page.evaluate(() => {
  const app = document.getElementById("app");
  const body = document.body;
  const html = document.documentElement;
  return {
    bodyBg: getComputedStyle(body).backgroundColor,
    htmlBg: getComputedStyle(html).backgroundColor,
    bodyChildren: body.childElementCount,
    appChildren: app?.childElementCount ?? "no #app",
    bodyText: body.innerText.slice(0, 300),
    bodyHTML: body.innerHTML.slice(0, 500),
  };
});

const path = "/tmp/android-smoke.png";
await page.screenshot({ path, fullPage: false });
await browser.close();

console.log("=== VISIBLE ===");
console.log(JSON.stringify(visible, null, 2));
console.log("=== CONSOLE ===");
consoleMsgs.forEach((m) => console.log(m));
console.log("=== ERRORS ===");
errors.forEach((e) => console.log(e));
console.log(`screenshot: ${path}`);
