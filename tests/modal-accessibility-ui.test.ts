/** Shared modal, rename and extension-confirm regressions; no live app or agent. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(root, "src/client/styles.css"), "utf8");
let browser: Browser;
let script: string;

beforeAll(async () => {
	const bundle = await build({
		stdin: {
			resolveDir: root,
			contents: `
				import { el, mountModal } from './src/client/dom.ts';
				import { handleExtensionUiRequest } from './src/client/extension-ui.ts';
				import { renderSidebarSessions, registerShellHandlers } from './src/client/render.ts';
				import { state } from './src/client/state.ts';
				window.modals = {};
				window.dismissals = [];
				window.openModal = (id) => {
					const overlay = el('div', {id});
					const box = el('div', {class: 'modal-box'}, el('h3', {text: id}),
						el('button', {id: id + '-first', text: 'First'}),
						el('button', {id: id + '-last', text: 'Last'}));
					window.modals[id] = mountModal(overlay, box, {
						onDismiss: () => window.dismissals.push(id)
					});
				};
				window.responses = [];
				window.confirmQuestion = () => handleExtensionUiRequest({
					id: 'question', method: 'confirm', title: 'Continue?', message: 'Test question'
				}, (id, response) => window.responses.push({id, ...response}));
				window.renames = [];
				registerShellHandlers({renameSessionById: (id, name) => window.renames.push({id, name})});
				state.projects = [{id: 'global', name: 'Global', cwd: '/repo', icon: ''}];
				renderSidebarSessions([{
					id: 'session', title: 'Original', cwd: '/repo', projectId: 'global',
					createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z', messageCount: 1
				}]);
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

async function open(legacy = false): Promise<Page> {
	const page = await browser.newPage();
	await page.route("https://acb.test/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><style>${css}</style>
				<div id="app"><button id="trigger">Open</button><button id="background">Background</button>
				<aside id="sidebar" class="sidebar"><div id="sidebar-sessions" class="sidebar-sessions">
				<div id="sidebar-projects-pane" class="sidebar-pane sidebar-projects-pane"></div><div id="sidebar-sessions-pane" class="sidebar-pane sidebar-sessions-pane"></div>
				</div></aside></div>
				<div id="already-inert" inert="existing" aria-hidden="true"></div>
				<div id="already-labelled" aria-hidden="false"></div>
				<script type="module">${legacy ? "delete HTMLElement.prototype.inert;" : ""}${script}</script>`,
		}),
	);
	await page.goto("https://acb.test/");
	await page.waitForFunction(() => typeof (window as any).openModal === "function");
	return page;
}
async function openModal(page: Page, id: string) {
	await page.evaluate((id) => (window as any).openModal(id), id);
	await expect
		.poll(() => page.locator(`#${id}-first`).evaluate((x) => x === document.activeElement))
		.toBe(true);
}
async function closeModal(page: Page, id: string) {
	await page.evaluate((id) => (window as any).modals[id].close(), id);
	await expect.poll(() => page.locator(`#${id}`).count()).toBe(0);
}
async function focused(page: Page) {
	return page.evaluate(() => document.activeElement?.id);
}

describe("modal and form accessibility", { timeout: 30_000 }, () => {
	it("makes background inert, contains focus and restores exact prior state on Escape", async () => {
		const page = await open();
		try {
			await page.locator("#trigger").focus();
			await openModal(page, "one");
			expect(await page.locator("#app").getAttribute("inert")).toBe("");
			expect(await page.locator("#one").getAttribute("inert")).toBeNull();
			await page.locator("#background").evaluate((x: HTMLElement) => x.focus());
			expect(await focused(page)).toBe("one-first");
			await page.keyboard.press("Shift+Tab");
			expect(
				await page.locator("#one .modal-close-btn").evaluate((x) => x === document.activeElement),
			).toBe(true);
			await page.keyboard.press("Tab");
			expect(await focused(page)).toBe("one-first");
			await page.evaluate(() => {
				const node = document.createElement("button");
				node.id = "late-background";
				document.body.append(node);
			});
			await expect.poll(() => page.locator("#late-background").getAttribute("inert")).toBe("");
			await page.keyboard.press("Escape");
			await expect.poll(() => focused(page)).toBe("trigger");
			expect(await page.locator("#app").getAttribute("inert")).toBeNull();
			expect(await page.locator("#late-background").getAttribute("inert")).toBeNull();
			expect(await page.locator("#already-inert").getAttribute("inert")).toBe("existing");
			expect(await page.locator("#already-inert").getAttribute("aria-hidden")).toBe("true");
			expect(await page.locator("#already-labelled").getAttribute("aria-hidden")).toBe("false");
			expect(await page.evaluate(() => (window as any).dismissals)).toEqual(["one"]);
		} finally {
			await page.close();
		}
	});

	it("only activates the top stacked dialog and restores focus through both closes", async () => {
		const page = await open();
		try {
			await page.locator("#trigger").focus();
			await openModal(page, "lower");
			await openModal(page, "upper");
			expect(await page.locator("#lower").getAttribute("inert")).toBe("");
			expect(await page.locator("#upper").getAttribute("inert")).toBeNull();
			await page.locator("#lower-first").evaluate((x: HTMLElement) => x.focus());
			expect(await focused(page)).toBe("upper-first");
			await closeModal(page, "upper");
			await expect.poll(() => focused(page)).toBe("lower-first");
			expect(await page.locator("#lower").getAttribute("inert")).toBeNull();
			expect(await page.locator("#app").getAttribute("inert")).toBe("");
			await closeModal(page, "lower");
			await expect.poll(() => focused(page)).toBe("trigger");
			expect(await page.locator("#app").getAttribute("inert")).toBeNull();
		} finally {
			await page.close();
		}
	});

	it("restores the original opener after synchronously replacing a dialog", async () => {
		const page = await open();
		try {
			await page.locator("#trigger").focus();
			await openModal(page, "first");
			await page.evaluate(() => {
				document.getElementById("first")!.remove();
				(window as any).openModal("replacement");
			});
			await expect.poll(() => focused(page)).toBe("replacement-first");
			await page.keyboard.press("Escape");
			await expect.poll(() => focused(page)).toBe("trigger");
			expect(await page.locator("#app").getAttribute("inert")).toBeNull();
		} finally {
			await page.close();
		}
	});

	it("does not steal focus or unlock the page when a lower dialog is removed first", async () => {
		const page = await open();
		try {
			await openModal(page, "lower");
			await openModal(page, "upper");
			await closeModal(page, "lower");
			expect(await focused(page)).toBe("upper-first");
			expect(await page.locator("#app").getAttribute("inert")).toBe("");
			await closeModal(page, "upper");
			expect(await page.locator("#app").getAttribute("inert")).toBeNull();
		} finally {
			await page.close();
		}
	});

	it("keeps the focus guard and restores aria-hidden when inert is unavailable", async () => {
		const page = await open(true);
		try {
			await openModal(page, "legacy");
			expect(await page.locator("#app").getAttribute("aria-hidden")).toBe("true");
			// Chromium still implements the attribute after deleting its JS property.
			// Remove it temporarily to exercise the non-native focus guard too.
			await page.evaluate(() => {
				document.getElementById("app")!.removeAttribute("inert");
				document.getElementById("background")!.focus();
			});
			expect(
				await page.locator("#legacy").evaluate((x) => x.contains(document.activeElement)),
			).toBe(true);
			await closeModal(page, "legacy");
			expect(await page.locator("#app").getAttribute("aria-hidden")).toBeNull();
			expect(await page.locator("#already-labelled").getAttribute("aria-hidden")).toBe("false");
		} finally {
			await page.close();
		}
	});

	it("preserves named close and backdrop dismissal", async () => {
		const page = await open();
		try {
			await openModal(page, "named");
			await page.getByRole("button", { name: "Close named" }).click();
			await expect.poll(() => page.locator("#app").getAttribute("inert")).toBeNull();
			await openModal(page, "backdrop");
			await page.locator("#backdrop").click({ position: { x: 2, y: 2 } });
			await expect.poll(() => page.locator("#app").getAttribute("inert")).toBeNull();
			expect(await page.evaluate(() => (window as any).dismissals)).toEqual(["named", "backdrop"]);
		} finally {
			await page.close();
		}
	});

	it("names the rename field and preserves Escape cancellation and Enter submission", async () => {
		const page = await open();
		try {
			const rename = page.getByRole("button", { name: "Rename Original", exact: true });
			await page.locator(".session-item").hover();
			await rename.click();
			const input = page.getByRole("textbox", { name: "Conversation name", exact: true });
			expect(await input.inputValue()).toBe("Original");
			await input.fill("Do not save");
			await input.press("Escape");
			expect(await page.evaluate(() => (window as any).renames)).toEqual([]);
			await page.locator(".session-item").hover();
			await rename.click();
			await input.fill("Renamed");
			await input.press("Enter");
			expect(await page.evaluate(() => (window as any).renames)).toEqual([
				{ id: "session", name: "Renamed" },
			]);
			expect(await input.count()).toBe(0);
		} finally {
			await page.close();
		}
	});

	it("defaults extension confirmation to No but still allows explicit Yes", async () => {
		const page = await open();
		try {
			await page.evaluate(() => (window as any).confirmQuestion());
			await expect
				.poll(() =>
					page
						.getByRole("button", { name: "No", exact: true })
						.evaluate((x) => x === document.activeElement),
				)
				.toBe(true);
			await page.keyboard.press("Enter");
			expect(await page.evaluate(() => (window as any).responses)).toEqual([
				{ id: "question", confirmed: false },
			]);
			await page.evaluate(() => (window as any).confirmQuestion());
			await page.getByRole("button", { name: "Yes", exact: true }).click();
			expect(await page.evaluate(() => (window as any).responses)).toEqual([
				{ id: "question", confirmed: false },
				{ id: "question", confirmed: true },
			]);
		} finally {
			await page.close();
		}
	});
});
