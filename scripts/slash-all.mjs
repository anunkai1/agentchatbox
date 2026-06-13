import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

async function runSlash(slash) {
  await page.click("#input");
  await page.type("#input", slash);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const dismiss = async () => {
      // Close any open modal/confirm
      const overlay = document.querySelector(".modal-overlay");
      if (overlay) overlay.click();
      window.onbeforeunload = null;
      // Cancel any confirm by overriding window.confirm
    };
    return {
      hasModal: !!document.querySelector(".modal-overlay"),
      modalTitle: document.querySelector(".modal-box h3")?.textContent ?? null,
      hasHelp: !!document.querySelector(".help"),
      helpText: document.querySelector(".help")?.textContent?.slice(0, 100) ?? null,
      statusBar: document.querySelector("#status-bar")?.textContent?.slice(0, 100) ?? null,
    };
  });
  // dismiss any modal
  await page.evaluate(() => {
    const overlay = document.querySelector(".modal-overlay");
    if (overlay) overlay.click();
  });
  await page.waitForTimeout(150);
  return r;
}

const tests = [
  ["/help", "help"],
  ["/cost", "help"],        // cost renders as a help-styled block
  ["/think high", "status"], // status bar should show "think: high"
  ["/think low", "status"],
  ["/sessions", "modal"],    // opens sessions modal
  ["/unknown_cmd", "none"],  // should NOT trigger — sent as prompt
];

for (const [slash, expected] of tests) {
  // Override confirm() to return true
  await page.evaluate(() => { window.confirm = () => true; });
  const r = await runSlash(slash);
  console.log(`${slash} →`, JSON.stringify(r));
}
await browser.close();
errors.forEach(e => console.log("err:", e));
