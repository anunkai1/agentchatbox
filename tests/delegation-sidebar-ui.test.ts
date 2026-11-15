/** Real sidebar renderer + CSS in Chromium; no agent process or live files. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/shared/protocol.js";

let browser: Browser;
let script: string;
const root = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(root, "src/client/styles.css"), "utf8");
const parent: SessionSummary = {
	id: "parent",
	title: "Parent task",
	cwd: "/repo/parent",
	projectId: "global",
	createdAt: "2026-01-01T00:00:00Z",
	modifiedAt: "2026-01-01T00:00:00Z",
	messageCount: 2,
};
const child: SessionSummary = {
	...parent,
	id: "child",
	title: "Fix the API",
	cwd: "/workspace/backend",
	projectId: "backend",
	delegation: { parentSessionId: "parent", status: "needs_input" },
};
beforeAll(async () => {
	const bundle = await build({
		stdin: {
			resolveDir: root,
			contents: `
			import { renderSidebarSessions, registerShellHandlers } from './src/client/render.ts';
			import { state } from './src/client/state.ts';
			state.projects = [
				{ id: 'global', name: 'Global', cwd: '/repo/parent', icon: '' },
				{ id: 'backend', name: 'Backend', cwd: '/workspace/backend', icon: '' }
			];
			registerShellHandlers({handleSlash: (cmd) => { window.lastCommand = cmd; }});
			window.render = (sessions, active = null) => {
				state.sessionId = active;
				renderSidebarSessions(sessions);
			};
		`,
		},
		bundle: true,
		format: "esm",
		platform: "browser",
		write: false,
	});
	script = bundle.outputFiles[0].text;
	browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
	await browser?.close();
});

async function open(width = 1280): Promise<Page> {
	const page = await browser.newPage({ viewport: { width, height: 900 } });
	await page.route("https://acb.test/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><style>${css}</style>
		<div id="app"><aside class="sidebar" id="sidebar"><div id="sidebar-sessions" class="sidebar-sessions">
		<div id="sidebar-projects-pane" class="sidebar-pane sidebar-projects-pane"></div>
		<div id="sidebar-sessions-pane" class="sidebar-pane sidebar-sessions-pane"></div>
		</div></aside></div><script type="module">${script}</script>`,
		}),
	);
	await page.goto("https://acb.test/");
	await page.waitForFunction(() => typeof (window as any).render === "function");
	return page;
}
async function render(page: Page, sessions: SessionSummary[], active: string | null = null) {
	await page.evaluate(({ sessions, active }) => (window as any).render(sessions, active), {
		sessions,
		active,
	});
}

describe("delegation sidebar browser", { timeout: 30_000 }, () => {
	for (const width of [1280, 390, 320]) {
		it(`nests cross-project workers and shows folder at ${width}px`, async () => {
			const page = await open(width);
			try {
				await page.clock.setFixedTime(new Date("2026-01-01T04:00:00Z"));
				await render(page, [parent, child]);
				const rows = page.locator("#project-body-global .session-item");
				await expect.poll(() => rows.count()).toBe(2);
				expect(await rows.nth(1).getAttribute("data-depth")).toBe("1");
				expect(await page.locator('#project-body-backend a[href="/s/child"]').count()).toBe(0);
				const folder = rows.nth(1).locator(".session-worker-folder");
				expect(await folder.innerText()).toBe("backend");
				expect(await folder.getAttribute("title")).toContain(child.cwd);
				expect(await rows.first().locator(".session-worker-count").innerText()).toContain(
					"1 needs input",
				);
				expect(await rows.first().locator(".session-item-meta").innerText()).toBe(
					"1 worker · 1 needs input · 4h ago",
				);
				const titleBounds = await rows.nth(1).locator(".session-item-title").boundingBox();
				expect(titleBounds!.width).toBeGreaterThan(80);
				const bounds = await folder.boundingBox();
				expect(bounds!.width).toBeGreaterThan(45);
				await page.getByRole("button", { name: "Collapse workers for Parent task" }).click();
				await expect.poll(() => page.locator('a[href="/s/child"]').count()).toBe(0);
				expect(await rows.first().locator(".session-item-meta").innerText()).toBe(
					"1 worker · 1 needs input · 4h ago",
				);
				await render(page, [parent, child]);
				expect(await page.locator('a[href="/s/child"]').count()).toBe(0);
				await page.getByRole("button", { name: "Expand workers for Parent task" }).click();
				await expect.poll(() => rows.count()).toBe(2);
				await rows.nth(1).locator("a").click();
				expect(await page.evaluate(() => (window as any).lastCommand)).toBe("resume child");
			} finally {
				await page.close();
			}
		});
	}
	it("reveals a direct worker link even when its family and project were collapsed", async () => {
		const page = await open();
		try {
			await page.evaluate(() => {
				localStorage.setItem("acb-project-collapse", JSON.stringify(["global"]));
				localStorage.setItem("acb-worker-collapse", JSON.stringify(["parent"]));
			});
			await render(page, [parent, child], "child");
			await expect.poll(() => page.locator('a[href="/s/child"]').isVisible()).toBe(true);
			expect(await page.locator('a[href="/s/child"]').getAttribute("aria-current")).toBe("page");
		} finally {
			await page.close();
		}
	});
	it("scrolls an off-screen active worker into the virtualised viewport", async () => {
		const page = await open();
		try {
			const others = Array.from({ length: 70 }, (_, i) => ({
				...parent,
				id: `other-${i}`,
				modifiedAt: "2026-02-01T00:00:00Z",
			}));
			await render(page, [...others, parent, child], "child");
			await expect.poll(() => page.locator('a[href="/s/child"]').isVisible()).toBe(true);
			const row = await page.locator('a[href="/s/child"]').boundingBox();
			const pane = await page.locator("#sidebar-sessions-pane").boundingBox();
			expect(row!.y).toBeGreaterThanOrEqual(pane!.y);
			expect(row!.y + row!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
		} finally {
			await page.close();
		}
	});
	it("reveals ancestry when fresh metadata replaces an older sidebar cache", async () => {
		const page = await open();
		try {
			await render(page, [parent, { ...child, delegation: undefined }], "child");
			await page.evaluate(() =>
				localStorage.setItem("acb-worker-collapse", JSON.stringify(["parent"])),
			);
			await render(page, [parent, child], "child");
			await expect
				.poll(() => page.locator('#project-body-global a[href="/s/child"]').isVisible())
				.toBe(true);
		} finally {
			await page.close();
		}
	});
	it("pages root families together, reveals workers on later pages and preserves the page", async () => {
		const page = await open();
		try {
			const others = Array.from({ length: 100 }, (_, i) => ({
				...parent,
				id: `other-${i}`,
				modifiedAt: "2026-02-01T00:00:00Z",
			}));
			const sessions = [...others, parent, child];
			await render(page, sessions, "child");
			await expect.poll(() => page.locator('a[href="/s/child"]').isVisible()).toBe(true);
			expect(await page.locator("#project-body-global .sidebar-pagination-label").innerText()).toBe(
				"Page 2 of 2",
			);
			await page.getByRole("button", { name: "Collapse workers for Parent task" }).click();
			expect(await page.locator("#project-body-global .sidebar-pagination-label").innerText()).toBe(
				"Page 2 of 2",
			);
			await page.getByRole("button", { name: "Expand workers for Parent task" }).click();
			await expect.poll(() => page.locator('a[href="/s/child"]').isVisible()).toBe(true);
			// Removing only the parent promotes its surviving worker, with cwd intact.
			await render(page, [child]);
			await expect
				.poll(() => page.locator('#project-body-backend a[href="/s/child"]').isVisible())
				.toBe(true);
		} finally {
			await page.close();
		}
	});
	it("groups sidebar sessions into Pinned, recent days, and monthly sections and toggles collapse", async () => {
		const page = await open();
		try {
			await page.clock.setFixedTime(new Date("2026-11-16T00:37:00+10:00"));
			const sample = [
				{ ...parent, id: "pin", title: "Pinned item", pinned: true, modifiedAt: "2026-03-01T10:00:00+10:00" },
				{ ...parent, id: "s-today", title: "Today item", modifiedAt: "2026-11-16T00:10:00+10:00" },
				{ ...parent, id: "s-yest", title: "Yesterday item", modifiedAt: "2026-11-15T12:00:00+10:00" },
				{ ...parent, id: "s-week", title: "Week item", modifiedAt: "2026-11-12T12:00:00+10:00" },
				{ ...parent, id: "s-oct", title: "October item", modifiedAt: "2026-10-15T12:00:00+10:00" },
				{ ...parent, id: "s-apr", title: "April item", modifiedAt: "2026-04-08T12:00:00+10:00" },
			];
			await render(page, sample);
			const labels = page.locator("#project-body-global .group-label-text");
			await expect.poll(() => labels.count()).toBe(6);
			expect(await labels.allInnerTexts()).toEqual([
				"PINNED",
				"TODAY",
				"YESTERDAY",
				"LAST 7 DAYS",
				"OCTOBER 2026",
				"APRIL 2026",
			]);
			const firstHeader = await page.locator("#project-body-global .group-label").first().boundingBox();
			const firstRow = await page.locator("#project-body-global .session-item").first().boundingBox();
			expect(firstHeader!.y + firstHeader!.height).toBeLessThanOrEqual(firstRow!.y);

			// Collapse Today and Yesterday; their session rows disappear while headers remain.
			await page.getByRole("button", { name: "Collapse Today" }).click();
			await page.getByRole("button", { name: "Collapse Yesterday" }).click();
			await expect.poll(() => page.locator('#project-body-global a[href="/s/s-today"]').count()).toBe(0);
			await expect.poll(() => page.locator('#project-body-global a[href="/s/s-yest"]').count()).toBe(0);
			expect(
				await page.getByRole("button", { name: "Expand Today" }).getAttribute("aria-expanded"),
			).toBe("false");

			// Collapse state persists across re-renders, and expanding restores the chat.
			await render(page, sample);
			await expect.poll(() => page.locator('#project-body-global a[href="/s/s-today"]').count()).toBe(0);
			await page.getByRole("button", { name: "Expand Today" }).click();
			await expect.poll(() => page.locator('#project-body-global a[href="/s/s-today"]').isVisible()).toBe(true);

			// Opening an active session inside a collapsed group auto-expands it.
			await render(page, sample, "s-yest");
			await expect.poll(() => page.locator('#project-body-global a[href="/s/s-yest"]').isVisible()).toBe(true);
		} finally {
			await page.close();
		}
	});
});
