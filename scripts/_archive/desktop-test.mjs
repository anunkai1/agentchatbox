import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const visible = await page.evaluate(() => {
  const pills = Array.from(document.querySelectorAll(".picker-btn")).map((b) => ({
    id: b.id,
    text: b.textContent,
    visible: getComputedStyle(b).display !== "none",
  }));
  const menu = document.getElementById("overflow-menu");
  return {
    pills,
    menuVisible: menu ? getComputedStyle(menu).display !== "none" : false,
    bodyText: document.body.innerText.slice(0, 200),
  };
});
await page.screenshot({ path: "/tmp/desktop-test.png" });
await browser.close();
console.log(JSON.stringify(visible, null, 2));
errors.forEach(e => console.log("err:", e));
