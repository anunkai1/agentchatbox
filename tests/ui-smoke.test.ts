/**
 * Browser smoke test: the real client bundle in headless Chromium against the
 * real server, with a fake `pi` (jq-driven bash, like chat.test.ts).
 *
 * Covers the flows that server-only tests cannot see: send and render a reply,
 * keep sending after the WebSocket drops (the "Reconnect leaves the tab unable
 * to send" class of bug), and open a stored session from its /s/<id> link.
 *
 * The client is bundled in memory and served through Playwright routes, so the
 * test never rewrites the live public/ directory. Needs a browser once per
 * machine: `npx playwright-core install chromium-headless-shell`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { type Browser, chromium, type Page, type WebSocketRoute } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const SEEDED_ID = "seeded-session-001";
const SEEDED_IMAGE = "0f8e2a6c-1b3d-4e5f-8a9b-0c1d2e3f4a5b.png";
const MODELS = Array.from({ length: 12 }, (_, i) => ({
	id: i === 0 ? "glm-5.2" : `model-${i + 1}`,
	provider: "zai",
	name: `Model ${i + 1}`,
}));
// A 1x1 PNG, so the served upload passes the server's magic-byte check.
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

// Answers each prompt with "reply N"; resumes whatever --session it is given.
const FAKE_PI = `#!/usr/bin/env bash
session="live-session-001"
while [ $# -gt 0 ]; do
  if [ "$1" = "--session" ]; then session="$2"; shift; fi
  shift
done
n=0
while IFS= read -r line; do
  type="$(echo "$line" | jq -r '.type // ""')"
  case "$type" in
    "get_state")
      echo "{\\"type\\":\\"response\\",\\"command\\":\\"get_state\\",\\"success\\":true,\\"data\\":{\\"sessionId\\":\\"$session\\",\\"messageCount\\":0}}"
      ;;
    "get_available_models")
      echo '${JSON.stringify({ type: "response", command: "get_available_models", success: true, data: { models: MODELS } })}'
      ;;
    "prompt")
      n=$((n + 1))
      text="$(echo "$line" | jq -c '.message // ""')"
      user="{\\"role\\":\\"user\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":$text}],\\"timestamp\\":1}"
      reply="{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"reply $n\\"}],\\"api\\":\\"anthropic-messages\\",\\"provider\\":\\"zai\\",\\"model\\":\\"test\\",\\"stopReason\\":\\"stop\\",\\"timestamp\\":2}"
      echo '{"type":"response","command":"prompt","success":true}'
      echo '{"type":"agent_start"}'
      echo '{"type":"turn_start"}'
      echo "{\\"type\\":\\"message_start\\",\\"message\\":$user}"
      echo "{\\"type\\":\\"message_end\\",\\"message\\":$user}"
      echo "{\\"type\\":\\"message_start\\",\\"message\\":$reply}"
      echo "{\\"type\\":\\"message_update\\",\\"message\\":$reply}"
      echo "{\\"type\\":\\"message_end\\",\\"message\\":$reply}"
      echo "{\\"type\\":\\"turn_end\\",\\"message\\":$reply,\\"toolResults\\":[]}"
      echo '{"type":"agent_end","messages":[],"willRetry":false}'
      ;;
    "") ;;
    *)
      echo "{\\"type\\":\\"response\\",\\"command\\":\\"$type\\",\\"success\\":true}"
      ;;
  esac
done
`;

let tmp: string;
let server: ChildProcess | null = null;
let serverLog = "";
let browser: Browser | null = null;
let base: string;
let client: { html: string; js: string; css: string };

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
	const { port } = probe.address() as { port: number };
	await new Promise((done) => probe.close(done));
	return port;
}

async function bundleClient(): Promise<{ html: string; js: string; css: string }> {
	const out = await build({
		entryPoints: [join(root, "src/client/main.ts")],
		bundle: true,
		format: "esm",
		target: ["es2022"],
		platform: "browser",
		write: false,
		define: { "process.env.NODE_ENV": '"production"' },
		logLevel: "silent",
	});
	return {
		html: readFileSync(join(root, "index.html"), "utf8"),
		js: out.outputFiles[0].text,
		css: readFileSync(join(root, "src/client/styles.css"), "utf8"),
	};
}

/** Serve the in-memory client for page loads; API and WS go to the server. */
async function openPage(path: string): Promise<{ page: Page; sockets: WebSocketRoute[] }> {
	if (!browser) throw new Error("browser not started");
	const page = await browser.newPage();
	const sockets: WebSocketRoute[] = [];
	page.on("console", (msg) => {
		serverLog += `[browser ${msg.type()}] ${msg.text()}\n`;
	});
	page.on("pageerror", (error) => {
		serverLog += `[browser error] ${error.message}\n`;
	});
	await page.routeWebSocket(/\/api\/chat$/, (ws) => {
		ws.connectToServer();
		sockets.push(ws);
	});
	await page.route(
		(url) =>
			url.origin === base &&
			!url.pathname.startsWith("/api/") &&
			!url.pathname.startsWith("/uploads/"),
		(route) => {
			const { pathname } = new URL(route.request().url());
			if (pathname === "/app.js") {
				return route.fulfill({ body: client.js, contentType: "text/javascript" });
			}
			if (pathname === "/styles.css") {
				return route.fulfill({ body: client.css, contentType: "text/css" });
			}
			if (pathname === "/" || pathname.startsWith("/s/")) {
				return route.fulfill({ body: client.html, contentType: "text/html" });
			}
			return route.fulfill({ status: 404, body: "" });
		},
	);
	await page.goto(`${base}${path}`);
	return { page, sockets };
}

async function send(page: Page, text: string): Promise<void> {
	await page.locator("#input").fill(text);
	await page.locator("#send-btn").click();
}

const messages = (page: Page) => page.locator(".messages");

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), "acb-ui-"));
	const piCwd = join(tmp, "cwd");
	const sessions = join(tmp, "sessions");
	mkdirSync(piCwd);
	const sessionDir = join(sessions, `--${piCwd.slice(1).replace(/\//g, "-")}--`);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `2026-01-01T00-00-00-000Z_${SEEDED_ID}.jsonl`),
		[
			{
				type: "session",
				version: 3,
				id: SEEDED_ID,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: piCwd,
			},
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: `![image: photo.png](upload:${SEEDED_IMAGE})\nstored question`,
						},
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "stored answer" }],
					provider: "zai",
					model: "test",
					stopReason: "stop",
					timestamp: 2,
				},
			},
		]
			.map((line) => JSON.stringify(line))
			.join("\n")
			.concat("\n"),
	);
	mkdirSync(join(tmp, "uploads"));
	writeFileSync(join(tmp, "uploads", SEEDED_IMAGE), PNG_1X1);
	const fakePi = join(tmp, "pi");
	writeFileSync(fakePi, FAKE_PI, { mode: 0o755 });
	const authFile = join(tmp, "auth.json");
	writeFileSync(authFile, JSON.stringify({ zai: { key: "test-dummy" } }));

	const port = await freePort();
	base = `http://127.0.0.1:${port}`;
	const [bundled] = await Promise.all([bundleClient()]);
	client = bundled;
	server = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/server/index.ts")], {
		cwd: tmp,
		env: {
			PATH: process.env.PATH,
			HOME: tmp,
			NODE_ENV: "test",
			HOST: "127.0.0.1",
			PORT: String(port),
			PI_BIN: fakePi,
			PI_CWD: piCwd,
			PI_CODING_AGENT_SESSION_DIR: sessions,
			UPLOADS_DIR: join(tmp, "uploads"),
			AGENTCHATBOX_PI_AUTH_FILE: authFile,
			AGENTCHATBOX_PROJECTS_FILE: join(tmp, "projects.json"),
			AGENTCHATBOX_PINS_FILE: join(tmp, "pins.json"),
			AGENTCHATBOX_PI_SETTINGS_FILE: join(tmp, "settings.json"),
			AGENTCHATBOX_SESSION_CACHE_FILE: join(tmp, "session-cache.json"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout?.on("data", (chunk) => {
		serverLog += chunk;
	});
	server.stderr?.on("data", (chunk) => {
		serverLog += chunk;
	});
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			if ((await fetch(`${base}/api/health`)).ok) break;
		} catch {
			/* not listening yet */
		}
		if (server.exitCode !== null || Date.now() > deadline) {
			throw new Error(`test server did not start:\n${serverLog}`);
		}
		await new Promise((done) => setTimeout(done, 100));
	}
	// Route-fulfilled pages have no address space, so Chromium's Local Network
	// Access checks would treat them as public and block the loopback socket.
	browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks"] });
}, 60_000);

afterAll(async () => {
	await browser?.close();
	if (server && server.exitCode === null) {
		const exited = new Promise((done) => server?.once("exit", done));
		server.kill("SIGTERM");
		await exited;
	}
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach((ctx) => {
	ctx.onTestFailed(() => {
		console.error(`server log:\n${serverLog.slice(-4000)}`);
	});
});

describe("browser smoke", { timeout: 30_000 }, () => {
	it("sends a message, keeps sending after the socket drops", async () => {
		const { page, sockets } = await openPage("/");
		await send(page, "first question");
		await expect.poll(() => messages(page).innerText()).toContain("reply 1");
		expect(await messages(page).innerText()).toContain("first question");

		// Drop the connection the way a flaky network or a backgrounded phone does.
		const before = sockets.length;
		await sockets.at(-1)?.close({ code: 1001, reason: "test drop" });
		await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThan(before);

		await send(page, "second question");
		await expect.poll(() => messages(page).innerText()).toContain("reply 2");
		await page.close();
	});

	it("pins beyond five models even when saved pins are unavailable, and preserves them on reload", async () => {
		const { page } = await openPage("/");
		const pin = (model: { id: string; provider: string }) => ({
			id: model.id,
			provider: model.provider,
		});
		const unavailable = [
			{ id: "removed-model", provider: "zai" },
			{ id: "old-model", provider: "removed-provider" },
		];
		const initialPins = [...MODELS.slice(0, 3).map(pin), ...unavailable];
		await page.evaluate((pins) => {
			localStorage.setItem("acb-pinned-models-v1", JSON.stringify(pins));
		}, initialPins);
		await page.reload();
		await expect.poll(() => page.locator("#model-picker").innerText()).toContain("Model");
		await page.locator("#model-picker").click();
		const pinned = page.locator(".model-group-title-pinned");
		const pinnedGroup = page.locator(".model-group").filter({ has: pinned });
		const providerGroup = page.locator(".model-group").filter({
			has: page.getByRole("button", { name: "zai models", exact: true }),
		});
		await expect.poll(() => pinned.textContent()).toBe("♥ Pinned · 3");
		expect(await providerGroup.locator(".model-row").count()).toBe(MODELS.length);
		const filter = page.getByRole("searchbox", { name: "Filter models" });
		for (const [i, model] of MODELS.entries()) {
			if (i < 3) continue;
			await filter.fill(model.id);
			await page.getByRole("button", { name: `Pin ${model.name} to the top`, exact: true }).click();
			await expect.poll(() => pinned.textContent()).toBe(`♥ Pinned · ${i + 1}`);
			expect(await providerGroup.locator(".model-row").count()).toBe(MODELS.length);
			expect(
				await page.locator(`[data-model-id="${model.id}"] .model-pin-btn.is-pinned`).count(),
			).toBe(2);
		}
		const savedPins = () =>
			page.evaluate(() => JSON.parse(localStorage.getItem("acb-pinned-models-v1") ?? "[]"));
		const expectedPins = [...initialPins, ...MODELS.slice(3).map(pin)];
		expect(await savedPins()).toEqual(expectedPins);

		await page.reload();
		await expect.poll(() => page.locator("#model-picker").innerText()).toContain("Model");
		await page.locator("#model-picker").click();
		await expect.poll(() => pinned.textContent()).toBe(`♥ Pinned · ${MODELS.length}`);
		expect(await providerGroup.locator(".model-row").count()).toBe(MODELS.length);
		// Either copy can unpin a model without removing it from its provider list.
		const last = MODELS.at(-1)!;
		for (const group of [pinnedGroup, providerGroup]) {
			await filter.fill(last.id);
			await group.getByRole("button", { name: `Unpin ${last.name}`, exact: true }).click();
			await expect.poll(() => pinned.textContent()).toBe(`♥ Pinned · ${MODELS.length - 1}`);
			expect(await savedPins()).toEqual(expectedPins.slice(0, -1));
			expect(await providerGroup.locator(".model-row").count()).toBe(MODELS.length);
			await filter.fill(last.id);
			await providerGroup
				.getByRole("button", { name: `Pin ${last.name} to the top`, exact: true })
				.click();
			await expect.poll(() => pinned.textContent()).toBe(`♥ Pinned · ${MODELS.length}`);
			expect(await savedPins()).toEqual(expectedPins);
		}
		await page.close();
	});

	it("keeps recently touched old files below genuinely recent conversations", async () => {
		const piCwd = join(tmp, "cwd");
		const dir = join(tmp, "sessions", `--${piCwd.slice(1).replace(/\//g, "-")}--`);
		const files: string[] = [];
		for (const [id, timestamp] of [
			["old-touched", "2026-01-02T00:00:00.000Z"],
			["recent-chat", "2026-01-03T00:00:00.000Z"],
		]) {
			const file = join(dir, `${id}.jsonl`);
			files.push(file);
			writeFileSync(
				file,
				[
					{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: piCwd },
					{ type: "message", timestamp, message: { role: "user", content: id } },
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n"),
			);
		}
		// Simulate maintenance touching the older conversation most recently.
		utimesSync(files[1], new Date("2026-01-03"), new Date("2026-01-03"));
		utimesSync(files[0], new Date(), new Date());
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		try {
			const links = page.locator("#project-body-global .session-item-link");
			await expect.poll(() => links.count()).toBeGreaterThanOrEqual(3);
			const hrefs = await links.evaluateAll((rows) => rows.map((row) => row.getAttribute("href")));
			expect(hrefs.indexOf("/s/recent-chat")).toBeLessThan(hrefs.indexOf("/s/old-touched"));
			const meta = await page.locator('a[href="/s/old-touched"] .session-item-meta').innerText();
			expect(meta).toContain("Jan 2");
		} finally {
			await page.close();
			for (const file of files) rmSync(file);
		}
	});

	it("opens a stored session, with its attached picture, from its /s/<id> link", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		await expect.poll(() => messages(page).innerText()).toContain("stored answer");
		expect(await messages(page).innerText()).toContain("stored question");
		expect(new URL(page.url()).pathname).toBe(`/s/${SEEDED_ID}`);
		// The attached picture is replayed from its stored upload reference.
		const image = messages(page).locator(`img[src="/uploads/${SEEDED_IMAGE}"]`);
		await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
		await page.close();
	});
});
