// Test new slash commands — order doesn't matter, dismiss only after the snapshot.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

await page.evaluate(() => { window.confirm = () => true; });

// Populate one assistant message first.
await page.click("#input");
await page.type("#input", "Reply with just OK.");
await page.click("#send-btn");
await page.waitForSelector(".row-assistant .text:not(.streaming)", { timeout: 30000 });
await page.waitForTimeout(1500);

async function runSlash(slash) {
	await page.click("#input");
	await page.type("#input", slash);
	await page.press("#input", "Enter");
	await page.waitForTimeout(600);
	// capture state WITHOUT dismissing first
	const result = await page.evaluate(() => {
		const helps = Array.from(document.querySelectorAll(".help")).map(h => h.textContent);
		const title = document.querySelector(".modal-box h3")?.textContent ?? null;
		return {
			hasModal: !!document.querySelector(".modal-overlay"),
			modalTitle: title,
			helpTexts: helps,
			status: document.querySelector("#status-bar")?.textContent ?? null,
		};
	});
	// dismiss
	await page.evaluate(() => {
		const ov = document.querySelector(".modal-overlay");
		if (ov) ov.click();
	});
	await page.waitForTimeout(100);
	return result;
}

const tests = [
	["/help", "Slash commands"],
	["/hotkeys", "Keyboard shortcuts"],
	["/session", "Session info"],
	["/cost", "Session totals"],
	["/resume", "Sessions"],
	["/changelog", "Recent commits"],
];

let allPass = true;
for (const [slash, expect] of tests) {
	const r = await runSlash(slash);
	const found = r.helpTexts.some(t => t.includes(expect)) || r.modalTitle?.includes(expect) || r.status?.includes(expect);
	if (!found) allPass = false;
	console.log(`${found ? "✓" : "✗"} ${slash} → modal=${r.modalTitle} helpLen=${r.helpTexts.length} status=${r.status?.slice(0, 50)}`);
}

console.log(allPass ? "ALL PASS" : "SOME FAILED");
await browser.close();
errors.forEach(e => console.log("err:", e));
