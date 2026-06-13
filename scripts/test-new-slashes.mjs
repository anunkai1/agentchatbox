// End-to-end test of all 8 new slash commands.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// Populate one assistant message so /copy and /export and /session have something to chew on.
await page.click("#input");
await page.type("#input", "Reply with just OK.");
await page.click("#send-btn");
await page.waitForSelector(".row-assistant .text:not(.streaming)", { timeout: 30000 });
await page.waitForTimeout(1500);

async function runSlash(slash, expectSubstr) {
	await page.evaluate(() => { window.confirm = () => true; });
	await page.click("#input");
	await page.type("#input", slash);
	await page.press("#input", "Enter");
	await page.waitForTimeout(800);
	// dismiss any open modal
	await page.evaluate(() => {
		const ov = document.querySelector(".modal-overlay");
		if (ov) ov.click();
	});
	await page.waitForTimeout(150);
	const result = await page.evaluate(() => {
		const helps = Array.from(document.querySelectorAll(".help"));
		return {
			helpTexts: helps.map(h => h.textContent),
			hasModal: !!document.querySelector(".modal-overlay"),
			modalTitle: document.querySelector(".modal-box h3")?.textContent ?? null,
			statusBar: document.querySelector("#status-bar")?.textContent?.slice(0, 100) ?? null,
		};
	});
	return result;
}

const tests = [
	["/help", "Slash commands"],
	["/hotkeys", "Keyboard shortcuts"],
	["/session", "Session info"],
	["/cost", "Session totals"],
	["/new", null],   // will prompt confirm → cancel via test
	["/resume", "Sessions"],
	["/copy", "Copied"],
	["/changelog", "Recent commits"],
	["/reload", null], // would reload
];

for (const [slash, expect] of tests) {
	const r = await runSlash(slash, expect);
	const found = expect ? r.helpTexts.some(t => t.includes(expect)) || r.modalTitle?.includes(expect) || r.statusBar?.includes(expect) : true;
	console.log(`${slash} →`, found ? "✓" : "✗", JSON.stringify({ hasModal: r.hasModal, modalTitle: r.modalTitle, helpTexts: r.helpTexts.map(t => t.slice(0, 60)), status: r.statusBar }));
}

// Test /name
const r1 = await runSlash("/name MyCustomName", "MyCustomName");
const titleAfter = await page.$eval("#title", el => el.textContent);
console.log("/name → title=", JSON.stringify(titleAfter), titleAfter === "MyCustomName" ? "✓" : "✗");

// Test /export — check that it triggered a download
const downloadPromise = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
await runSlash("/export", null);
const dl = await downloadPromise;
if (dl) {
	const path = await dl.path();
	console.log("/export → ✓ downloaded:", dl.suggestedFilename(), "to", path);
} else {
	console.log("/export → ✗ no download triggered");
}

await browser.close();
errors.forEach(e => console.log("err:", e));
