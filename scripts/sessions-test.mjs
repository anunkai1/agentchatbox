// Dump what's in IndexedDB after a real session.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => console.log(`[${m.type()}] ${m.text()}`));
await page.goto("http://192.168.0.148:3500/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// Send a quick prompt so we generate a session
await page.click("#input");
await page.type("#input", "Reply with just OK.");
await page.click("#send-btn");
await page.waitForSelector(".row-assistant .text:not(.streaming)", { timeout: 30000 });
await page.waitForTimeout(1000);

// Send a second prompt (so we have a title that's not "New chat")
await page.click("#input");
await page.type("#input", "And now say DONE.");
await page.click("#send-btn");
await page.waitForTimeout(8000);

// Open /sessions
await page.click("#input");
await page.type("#input", "/sessions");
await page.press("#input", "Enter");
await page.waitForTimeout(500);

// Dump what's in the dialog
const dialog = await page.evaluate(() => {
	const rows = Array.from(document.querySelectorAll(".session-row")).map((r) => ({
		title: r.querySelector(".session-title")?.textContent,
		meta: r.querySelector(".session-meta")?.textContent,
	}));
	return { rows, hasOverlay: !!document.querySelector(".modal-overlay") };
});
console.log("=== /sessions dialog ===");
console.log(JSON.stringify(dialog, null, 2));

// Also dump raw IndexedDB content
const raw = await page.evaluate(async () => {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open("agentchatbox", 2);
		req.onerror = () => reject(req.error);
		req.onsuccess = () => {
			const db = req.result;
			const tx = db.transaction("sessions", "readonly");
			const getReq = tx.objectStore("sessions").getAll();
			getReq.onsuccess = () => {
				const sessions = getReq.result.map((s) => ({
					id: s.id.slice(0, 8),
					title: s.title,
					nMessages: s.messages?.length,
					firstMsg: s.messages?.[0]?.text?.slice(0, 50),
					lastMsg: s.messages?.[s.messages.length - 1]?.text?.slice(0, 50),
					lastModified: s.lastModified,
				}));
				resolve({ count: sessions.length, sessions });
			};
			getReq.onerror = () => reject(getReq.error);
		};
	});
});
console.log("=== IndexedDB sessions ===");
console.log(JSON.stringify(raw, null, 2));

await page.screenshot({ path: "/tmp/sessions-test.png" });
await browser.close();
errors.forEach(e => console.log("err:", e));
