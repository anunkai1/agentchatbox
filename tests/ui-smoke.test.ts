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
	for (const viewport of [
		{ width: 1280, height: 900 },
		{ width: 390, height: 844 },
		{ width: 320, height: 700 },
	]) {
		it(`puts routine notices and voice preparation in the footer at ${viewport.width}px`, async () => {
			const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
			try {
				await page.setViewportSize(viewport);
				await expect.poll(() => messages(page).innerText()).toContain("stored answer");
				await page.clock.install();
				const layout = () =>
					page.evaluate(() => {
						const bar = document.querySelector("#status-bar")!.getBoundingClientRect();
						return {
							height: bar.height,
							y: bar.y,
							composerY: document.querySelector("#input")!.getBoundingClientRect().y,
						};
					});
				const idleLayout = await layout();
				expect(idleLayout.height).toBe(viewport.width > 700 ? 44 : 36);
				expect(await page.locator("#status-bar > #status-activity").count()).toBe(1);
				expect(await page.locator("#status-activity").evaluate((entry) => entry.offsetHeight)).toBe(
					0,
				);
				const core = await page.locator("#status-core").innerText();
				const notify = (message: string, notifyType = "info") =>
					sockets.at(-1)!.send(
						JSON.stringify({
							type: "event",
							event: {
								type: "extension_ui_request",
								id: "notice",
								method: "notify",
								message,
								notifyType,
							},
						}),
					);
				const notice = page.locator("#status-notice");
				notify("imggen: still working (20s elapsed)…");
				await expect.poll(() => notice.innerText()).toContain("20s elapsed");
				expect(await layout()).toEqual(idleLayout);
				expect(await page.locator(".toast").count()).toBe(0);
				expect(await page.locator("#status-core").innerText()).toBe(core);
				const bounds = await page.locator("#status-activity").boundingBox();
				const bar = await page.locator("#status-bar").boundingBox();
				const composer = await page.locator("#input").boundingBox();
				expect(bar!.y).toBeGreaterThanOrEqual(composer!.y + composer!.height);
				expect(bounds!.y).toBeGreaterThanOrEqual(bar!.y);
				expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
				expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
				const styles = await notice.evaluate((entry) => {
					const activity = getComputedStyle(entry);
					const core = getComputedStyle(document.querySelector("#status-core")!);
					const keys = ["fontSize", "fontFamily", "lineHeight", "color", "letterSpacing"] as const;
					return keys.map((key) => [key, activity[key], core[key]]);
				});
				for (const [name, activityStyle, coreStyle] of styles) {
					expect(activityStyle, name).toBe(coreStyle);
				}
				const longStatus =
					"imggen: preparing image generation on the local GPU, still working. ".repeat(4);
				notify(longStatus);
				await expect.poll(() => notice.textContent()).toBe(longStatus);
				const wrapping = await notice.evaluate((entry) => ({
					whiteSpace: getComputedStyle(entry).whiteSpace,
					textOverflow: getComputedStyle(entry).textOverflow,
					height: entry.getBoundingClientRect().height,
					lineHeight: Number.parseFloat(getComputedStyle(entry).lineHeight),
				}));
				expect(wrapping.whiteSpace).toBe("nowrap");
				expect(wrapping.textOverflow).toBe("ellipsis");
				expect(wrapping.height).toBeLessThanOrEqual(wrapping.lineHeight + 1);
				expect(await layout()).toEqual(idleLayout);

				const detail =
					"Vision processing complete.\n<b>This stays literal</b>\n" + "Full details. ".repeat(40);
				notify(detail);
				await expect.poll(() => notice.textContent()).toBe(detail);
				expect(await page.locator("#status-notice").count()).toBe(1);
				await notice.click();
				const dialog = page.getByRole("dialog", { name: "Status details" });
				expect(await dialog.locator(".status-detail-text").textContent()).toBe(detail);
				expect(await dialog.locator("b").count()).toBe(0);
				await page.getByRole("button", { name: "Close Status details", exact: true }).click();
				expect(await layout()).toEqual(idleLayout);
				await page.clock.fastForward(8000);
				expect(await page.locator("#status-activity").isVisible()).toBe(false);
				expect(await page.locator("#status-activity").evaluate((entry) => entry.offsetHeight)).toBe(
					0,
				);
				expect(
					await page.locator("#status-bar").evaluate((entry) => getComputedStyle(entry).display),
				).toBe("block");
				expect(await layout()).toEqual(idleLayout);

				// A warning cannot be hidden by info or by cancelling voice preparation.
				notify("A warning needs attention.", "warning");
				await expect.poll(() => page.locator(".composer-notice-warning").isVisible()).toBe(true);
				await page.locator('[data-voice-variant="long"]').last().click();
				await expect
					.poll(() => page.locator("#status-voice-detail").innerText())
					.toContain("generating spoken text");
				notify("Image model changed.");
				await expect.poll(() => notice.innerText()).toBe("Image model changed.");
				expect(await page.locator("#status-voice-detail").isVisible()).toBe(true);
				const withVoice = await layout();
				expect(withVoice.height).toBe(idleLayout.height);
				for (const id of ["#status-voice-detail", "#status-notice"]) {
					const entryBounds = await page.locator(id).boundingBox();
					expect(entryBounds!.width).toBeGreaterThan(0);
					expect(entryBounds!.y).toBeGreaterThanOrEqual(withVoice.y);
					expect(entryBounds!.y + entryBounds!.height).toBeLessThanOrEqual(
						withVoice.y + withVoice.height,
					);
				}
				const stopBounds = await page.locator("#status-bar [data-stop-voice]").boundingBox();
				expect(stopBounds!.x + stopBounds!.width).toBeLessThanOrEqual(viewport.width);
				expect(stopBounds!.y + stopBounds!.height).toBeLessThanOrEqual(
					withVoice.y + withVoice.height,
				);
				await page.locator("#status-bar [data-stop-voice]").click();
				expect(await layout()).toEqual(withVoice);
				await expect.poll(() => page.locator("#status-voice-detail").isVisible()).toBe(false);
				expect(await notice.isVisible()).toBe(true);
				expect(await page.locator(".composer-notice-warning").isVisible()).toBe(true);
				notify("Image generation failed.", "error");
				const error = page.locator(".composer-notice-error");
				await expect.poll(() => error.innerText()).toContain("Image generation failed.");
				notify("Image generation failed.", "error");
				await expect.poll(() => error.innerText()).toContain("2 occurrences");
				expect(await error.count()).toBe(1);
				await page.clock.fastForward(30_000);
				expect(await error.isVisible()).toBe(true);
				expect(await page.locator(".composer-notice-warning").isVisible()).toBe(true);
				const errorBounds = await error.boundingBox();
				const inputBounds = await page.locator("#input").boundingBox();
				expect(errorBounds!.y).toBeLessThan(inputBounds!.y);
				expect(errorBounds!.x + errorBounds!.width).toBeLessThanOrEqual(viewport.width);
				await error.getByRole("button", { name: "Dismiss error", exact: true }).click();
				expect(await error.count()).toBe(0);
				await page.getByRole("button", { name: "Dismiss warning", exact: true }).click();
				expect(await page.locator("#composer-notices").isVisible()).toBe(false);
			} finally {
				await page.close();
			}
		});
	}

	it("clears an upload blocker when the upload finishes without losing the draft", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		let releaseUpload = () => {};
		const uploadReady = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.route("**/api/upload", async (route) => {
				await uploadReady;
				await route.fulfill({
					json: {
						url: `/uploads/${SEEDED_IMAGE}`,
						filename: "photo.png",
						mimeType: "image/png",
						size: PNG_1X1.length,
					},
				});
			});
			await page
				.locator("#file-input")
				.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG_1X1 });
			await send(page, "keep this draft");
			const blocker = page.locator(".composer-notice-warning");
			await expect.poll(() => blocker.innerText()).toContain("Upload in progress");
			expect(await page.locator("#input").inputValue()).toBe("keep this draft");
			releaseUpload();
			await expect.poll(() => blocker.count()).toBe(0);
			expect(await page.locator("#input").inputValue()).toBe("keep this draft");
		} finally {
			releaseUpload();
			await page.close();
		}
	});

	it("keeps tool failures inspectable inline without raising error notices", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.getByTitle("Settings", { exact: true }).click();
			await page.getByRole("button", { name: /Tool calls/ }).click();
			await page.getByRole("button", { name: "Done", exact: true }).click();
			const socket = sockets.at(-1)!;
			for (const [toolName, text] of [
				["bash", "grep: no match\n\nCommand exited with code 1"],
				["edit", "Could not find edits[2]. The oldText must match exactly."],
				["read", "ENOENT: no such file or directory"],
			]) {
				const toolCallId = `call-${toolName}`;
				socket.send(
					JSON.stringify({
						type: "event",
						event: { type: "tool_execution_start", toolName, toolCallId, args: {} },
					}),
				);
				socket.send(
					JSON.stringify({
						type: "event",
						event: {
							type: "message_start",
							message: {
								role: "toolResult",
								toolCallId,
								toolName,
								content: [{ type: "text", text }],
								isError: true,
							},
						},
					}),
				);
				const row = page.locator(`[data-tool-call-id="${toolCallId}"]`);
				await expect.poll(() => row.locator(".tool-status-error").count()).toBe(1);
				expect(await row.locator(".tool-result.tool-error").textContent()).toBe(text);
				expect(await row.locator(".tool-result").isVisible()).toBe(false);
				await row.locator(".tool-head").click();
				expect(await row.locator(".tool-result").isVisible()).toBe(true);
				expect(await page.locator(".composer-notice-error").count()).toBe(0);
			}
			expect(await page.locator("#composer-notices").isVisible()).toBe(false);
		} finally {
			await page.close();
		}
	});

	it("retries a failed upload only when its retry action is pressed", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		let attempts = 0;
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.route("**/api/upload", (route) => {
				attempts++;
				return attempts === 1
					? route.fulfill({ status: 503, json: { error: "Upload service unavailable" } })
					: route.fulfill({
							json: {
								url: `/uploads/${SEEDED_IMAGE}`,
								filename: "retry.png",
								mimeType: "image/png",
								size: PNG_1X1.length,
							},
						});
			});
			await page
				.locator("#file-input")
				.setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: PNG_1X1 });
			await expect
				.poll(() => page.locator(".composer-notice-error").innerText())
				.toContain("Could not upload retry.png");
			expect(attempts).toBe(1);
			await page.getByRole("button", { name: "Retry upload", exact: true }).click();
			await expect.poll(() => page.locator(".composer-notice-error").count()).toBe(0);
			await expect
				.poll(() =>
					page.locator(`#attachment-previews img[src="/uploads/${SEEDED_IMAGE}"]`).count(),
				)
				.toBe(1);
			expect(attempts).toBe(2);
		} finally {
			await page.close();
		}
	});

	it("offers reconnect for a blocked send and retains unrelated errors across reconnect", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			sockets.at(-1)!.send(
				JSON.stringify({
					type: "event",
					event: {
						type: "extension_ui_request",
						method: "notify",
						message: "Earlier failure",
						notifyType: "error",
					},
				}),
			);
			await expect
				.poll(() => page.locator(".composer-notice-error").innerText())
				.toContain("Earlier failure");
			await page.clock.install();
			await page.clock.pauseAt(new Date(Date.now() + 1000));
			const before = sockets.length;
			await sockets.at(-1)!.close({ code: 1001, reason: "test drop" });
			await expect.poll(() => page.locator("#status-dynamic").innerText()).toContain("closed");
			await send(page, "draft for reconnect");
			await expect
				.poll(() => page.locator(".composer-notice-warning").innerText())
				.toContain("draft was kept");
			expect(await page.locator("#input").inputValue()).toBe("draft for reconnect");
			await page.getByRole("button", { name: "Reconnect", exact: true }).click();
			await expect.poll(() => sockets.length).toBeGreaterThan(before);
			await expect.poll(() => page.locator(".composer-notice-warning").count()).toBe(0);
			expect(await page.locator(".composer-notice-error").innerText()).toContain("Earlier failure");
			expect(await page.locator("#input").inputValue()).toBe("draft for reconnect");
		} finally {
			await page.close();
		}
	});

	it("drops the previous chat's notices when an empty new chat becomes ready", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			sockets.at(-1)!.send(
				JSON.stringify({
					type: "event",
					event: {
						type: "extension_ui_request",
						method: "notify",
						message: "Failure in the old chat",
						notifyType: "error",
					},
				}),
			);
			await expect
				.poll(() => page.locator(".composer-notice-error").innerText())
				.toContain("Failure in the old chat");
			await page.locator(".new-chat-btn").click();
			// The empty replacement session sends `ready` but no transcript.
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/live-session-001");
			expect(await page.locator(".composer-notice-error").count()).toBe(0);
		} finally {
			await page.close();
		}
	});

	it("keeps automatic retry progress in the footer instead of retaining a failure card", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			const event = (event: Record<string, unknown>) =>
				sockets.at(-1)!.send(JSON.stringify({ type: "event", event }));
			event({ type: "auto_retry_end", success: false, finalError: "Provider unavailable" });
			await expect
				.poll(() => page.locator(".composer-notice-error").innerText())
				.toContain("Provider unavailable");
			event({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 10000,
				errorMessage: "Provider unavailable",
			});
			await expect.poll(() => page.locator(".composer-notice-error").count()).toBe(0);
			expect(await page.locator("#status-dynamic").innerText()).toContain("Retrying");
			event({ type: "auto_retry_end", success: true });
			await expect
				.poll(() => page.locator("#status-dynamic").innerText())
				.not.toContain("Retrying");
		} finally {
			await page.close();
		}
	});

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
