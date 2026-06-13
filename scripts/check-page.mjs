import { chromium } from "/home/architect/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const errors = [];
const consoleMsgs = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message + (e.stack ? "\n" + e.stack : "")));
page.on("console", (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
page.on("requestfailed", (req) => errors.push("REQ FAIL: " + req.url() + " " + req.failure()?.errorText));

try {
  await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle", timeout: 10000 });
} catch (e) {
  errors.push("GOTO: " + e.message);
}
await page.waitForTimeout(1500);

const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500));
const appState = await page.evaluate(() => {
  const app = document.getElementById("app");
  if (!app) return "(no #app element)";
  return "#app has " + app.children.length + " children, innerText: " + (app.innerText || "(empty)").slice(0, 300);
});

console.log("=== CONSOLE ===");
consoleMsgs.forEach((m) => console.log(m));
console.log("=== ERRORS ===");
errors.forEach((m) => console.log(m));
console.log("=== body text ===");
console.log(bodyText);
console.log("=== #app state ===");
console.log(appState);

await browser.close();
