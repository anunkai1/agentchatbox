/** Unit + real Chromium tests for rearranging projects in the sidebar. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	computeDropIndex,
	moveProjectInOrder,
	reorderProjectIds,
} from "../src/client/project-reorder.js";
import type { ProjectSummary } from "../src/shared/protocol.js";

describe("project reorder helpers", () => {
	it("moves a project up or down by one slot and ignores out-of-bounds moves", () => {
		expect(moveProjectInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
		expect(moveProjectInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
		expect(moveProjectInOrder(["a", "b", "c"], "a", -1)).toBeNull();
		expect(moveProjectInOrder(["a", "b", "c"], "c", 1)).toBeNull();
		expect(moveProjectInOrder(["a", "b", "c"], "missing", 1)).toBeNull();
	});

	it("computes insertion slot among remaining midpoints", () => {
		expect(computeDropIndex(10, [50, 100, 150])).toBe(0);
		expect(computeDropIndex(75, [50, 100, 150])).toBe(1);
		expect(computeDropIndex(125, [50, 100, 150])).toBe(2);
		expect(computeDropIndex(200, [50, 100, 150])).toBe(3);
	});

	it("inserts dragged project at target slot and returns null for no-op", () => {
		expect(reorderProjectIds(["a", "b", "c"], "a", 0)).toBeNull();
		expect(reorderProjectIds(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
		expect(reorderProjectIds(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
		expect(reorderProjectIds(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
		expect(reorderProjectIds(["a", "b", "c"], "c", 1)).toEqual(["a", "c", "b"]);
		expect(reorderProjectIds(["a", "b", "c"], "c", 2)).toBeNull();
	});
});

let browser: Browser;
let script: string;
const root = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(root, "src/client/styles.css"), "utf8");

const defaultProjects: ProjectSummary[] = [
	{ id: "global", name: "Global", cwd: "/repo", icon: "🌐" },
	{ id: "alpha", name: "Alpha", cwd: "/repo/.projects/alpha", icon: "📁" },
	{ id: "beta", name: "Beta", cwd: "/repo/.projects/beta", icon: "📁" },
	{ id: "gamma", name: "Gamma", cwd: "/repo/.projects/gamma", icon: "📁" },
];

beforeAll(async () => {
	const bundle = await build({
		stdin: {
			resolveDir: root,
			contents: `
			import { renderSidebarSessions, registerShellHandlers } from './src/client/render.ts';
			import { state } from './src/client/state.ts';
			window.reorderedCalls = [];
			registerShellHandlers({
				reorderProjects: (order) => { window.reorderedCalls.push(order); },
				newSessionInProject: () => {},
			});
			window.renderProjects = (projects) => {
				state.projects = projects;
				renderSidebarSessions([]);
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

async function open(width = 1280, projects = defaultProjects): Promise<Page> {
	const page = await browser.newPage({ viewport: { width, height: 900 } });
	await page.route("https://acb.test/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><style>${css}</style>
		<div id="app"><aside class="sidebar" id="sidebar"><div id="sidebar-sessions" class="sidebar-sessions">
		<div id="sidebar-projects-pane" class="sidebar-pane sidebar-projects-pane" style="height: 360px"></div>
		<div id="sidebar-sessions-pane" class="sidebar-pane sidebar-sessions-pane"></div>
		</div></aside></div><script type="module">${script}</script>`,
		}),
	);
	await page.goto("https://acb.test/");
	await page.waitForFunction(() => typeof (window as any).renderProjects === "function");
	await page.evaluate((p) => (window as any).renderProjects(p), projects);
	return page;
}

async function visibleProjectIds(page: Page): Promise<string[]> {
	return page
		.locator("#projects-container-body > .project-folder")
		.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.projectId ?? ""));
}

describe("sidebar project reordering browser", { timeout: 30_000 }, () => {
	it("hides reorder toggle with fewer than two user projects", async () => {
		const page = await open(1280, defaultProjects.slice(0, 2));
		try {
			expect(await page.locator(".projects-reorder-action").count()).toBe(0);
		} finally {
			await page.close();
		}
	});

	it("reorders with up/down buttons in reorder mode and preserves focus", async () => {
		const page = await open(1280);
		try {
			await page.locator(".projects-reorder-action").click();
			expect(await page.locator(".projects-container.reordering").count()).toBe(1);
			expect(await page.locator(".projects-reorder-action").innerText()).toBe("Done");
			expect(await page.locator(".projects-add-action").count()).toBe(0);

			// Boundary buttons disabled.
			expect(
				await page
					.locator('.project-folder[data-project-id="alpha"] .project-move-up')
					.isDisabled(),
			).toBe(true);
			expect(
				await page
					.locator('.project-folder[data-project-id="gamma"] .project-move-down')
					.isDisabled(),
			).toBe(true);

			// Move Gamma up once -> [alpha, gamma, beta]
			await page.locator('.project-folder[data-project-id="gamma"] .project-move-up').click();
			expect(await visibleProjectIds(page)).toEqual(["alpha", "gamma", "beta"]);
			// Focus stays on Gamma's Move up button.
			expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
				"Move Gamma up",
			);

			// Move Gamma up again to top -> [gamma, alpha, beta]; focus falls back to Move down.
			await page.keyboard.press("Enter");
			expect(await visibleProjectIds(page)).toEqual(["gamma", "alpha", "beta"]);
			expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
				"Move Gamma down",
			);

			const calls = await page.evaluate(() => (window as any).reorderedCalls);
			expect(calls).toEqual([
				["global", "alpha", "gamma", "beta"],
				["global", "gamma", "alpha", "beta"],
			]);

			// Escape exits reorder mode and returns focus to the reorder toggle.
			await page.keyboard.press("Escape");
			expect(await page.locator(".projects-container.reordering").count()).toBe(0);
			expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
				"Reorder projects",
			);
		} finally {
			await page.close();
		}
	});

	it("supports direct mouse drag-and-drop in normal mode without toggling collapse", async () => {
		const page = await open(1280);
		try {
			const alphaToggle = page.locator(
				'.project-folder[data-project-id="alpha"] .project-folder-toggle',
			);
			const gammaHeader = page.locator(
				'.project-folder[data-project-id="gamma"] .project-folder-header',
			);
			const initialExpanded = await alphaToggle.getAttribute("aria-expanded");

			const fromBox = (await alphaToggle.boundingBox())!;
			const toBox = (await gammaHeader.boundingBox())!;

			await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
			await page.mouse.down();
			await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height - 2, { steps: 8 });
			await page.mouse.up();

			expect(await visibleProjectIds(page)).toEqual(["beta", "gamma", "alpha"]);
			expect(
				await page
					.locator('.project-folder[data-project-id="alpha"] .project-folder-toggle')
					.getAttribute("aria-expanded"),
			).toBe(initialExpanded);
			const calls = await page.evaluate(() => (window as any).reorderedCalls);
			expect(calls).toEqual([["global", "beta", "gamma", "alpha"]]);

			// A plain click still toggles collapse normally.
			await page.locator('.project-folder[data-project-id="alpha"] .project-folder-toggle').click();
			expect(
				await page
					.locator('.project-folder[data-project-id="alpha"] .project-folder-toggle')
					.getAttribute("aria-expanded"),
			).toBe(initialExpanded === "true" ? "false" : "true");
		} finally {
			await page.close();
		}
	});

	it("supports Alt+Arrow keyboard reordering in normal mode", async () => {
		const page = await open(1280);
		try {
			await page.locator('.project-folder[data-project-id="alpha"] .project-folder-toggle').focus();
			await page.keyboard.press("Alt+ArrowDown");
			expect(await visibleProjectIds(page)).toEqual(["beta", "alpha", "gamma"]);
			expect(
				await page.evaluate(
					() => document.activeElement?.closest<HTMLElement>(".project-folder")?.dataset.projectId,
				),
			).toBe("alpha");
		} finally {
			await page.close();
		}
	});

	it("supports dragging via the grip handle in reorder mode on narrow mobile viewports", async () => {
		const page = await open(390);
		try {
			await page.locator(".projects-reorder-action").click();
			const overflow = await page.locator("#sidebar-projects-pane").evaluate((el) => ({
				scrollWidth: el.scrollWidth,
				clientWidth: el.clientWidth,
			}));
			expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

			const handle = page.locator('.project-folder[data-project-id="gamma"] .project-drag-handle');
			const alphaHeader = page.locator(
				'.project-folder[data-project-id="alpha"] .project-folder-header',
			);
			const fromBox = (await handle.boundingBox())!;
			const toBox = (await alphaHeader.boundingBox())!;

			await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
			await page.mouse.down();
			await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + 4, { steps: 8 });
			await page.mouse.up();

			expect(await visibleProjectIds(page)).toEqual(["gamma", "alpha", "beta"]);
			const calls = await page.evaluate(() => (window as any).reorderedCalls);
			expect(calls).toEqual([["global", "gamma", "alpha", "beta"]]);
		} finally {
			await page.close();
		}
	});

	it("cancels an active drag on Escape without committing a reorder", async () => {
		const page = await open(1280);
		try {
			const alphaToggle = page.locator(
				'.project-folder[data-project-id="alpha"] .project-folder-toggle',
			);
			const gammaHeader = page.locator(
				'.project-folder[data-project-id="gamma"] .project-folder-header',
			);
			const fromBox = (await alphaToggle.boundingBox())!;
			const toBox = (await gammaHeader.boundingBox())!;

			await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
			await page.mouse.down();
			await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height - 2, { steps: 6 });
			expect(await page.locator(".project-drag-ghost").count()).toBe(1);
			await page.keyboard.press("Escape");
			await page.mouse.up();

			expect(await page.locator(".project-drag-ghost").count()).toBe(0);
			expect(await visibleProjectIds(page)).toEqual(["alpha", "beta", "gamma"]);
			expect(await page.evaluate(() => (window as any).reorderedCalls)).toEqual([]);
		} finally {
			await page.close();
		}
	});
});
