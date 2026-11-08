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
import {
	type Browser,
	chromium,
	type Page,
	type Route,
	type WebSocketRoute,
} from "playwright-core";
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
  if [[ "$type" == "prompt" || "$type" == "steer" ]]; then
    printf '%s\\n' "$line" >> "$ACB_TEST_PROMPT_LOG"
  fi
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
      echo "{\\"type\\":\\"agent_end\\",\\"messages\\":[$reply],\\"willRetry\\":false}"
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

async function bundleClient(vadAlias?: string): Promise<{ html: string; js: string; css: string }> {
	const out = await build({
		entryPoints: [join(root, "src/client/main.ts")],
		bundle: true,
		format: "esm",
		target: ["es2022"],
		platform: "browser",
		write: false,
		define: { "process.env.NODE_ENV": '"production"' },
		alias: vadAlias ? { "@ricky0123/vad-web": vadAlias } : undefined,
		logLevel: "silent",
	});
	return {
		html: readFileSync(join(root, "index.html"), "utf8"),
		js: out.outputFiles[0].text,
		css: readFileSync(join(root, "src/client/styles.css"), "utf8"),
	};
}

/** Serve the in-memory client for page loads; API and WS go to the server. */
async function openPage(
	path: string,
	script = client.js,
): Promise<{ page: Page; sockets: WebSocketRoute[] }> {
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
				return route.fulfill({ body: script, contentType: "text/javascript" });
			}
			if (pathname === "/styles.css") {
				return route.fulfill({ body: client.css, contentType: "text/css" });
			}
			if (pathname.startsWith("/voice-vad/")) {
				const name = pathname.split("/").at(-1)!;
				const allowed = [
					"silero_vad_v5.onnx",
					"vad.worklet.bundle.min.js",
					"ort-wasm-simd-threaded.mjs",
					"ort-wasm-simd-threaded.wasm",
				];
				if (!allowed.includes(name)) return route.fulfill({ status: 404, body: "" });
				const pkg = name.startsWith("ort-") ? "onnxruntime-web" : "@ricky0123/vad-web";
				return route.fulfill({
					body: readFileSync(join(root, "node_modules", pkg, "dist", name)),
					contentType: name.endsWith(".wasm")
						? "application/wasm"
						: name.endsWith(".onnx")
							? "application/octet-stream"
							: "text/javascript",
				});
			}
			if (pathname === "/" || pathname.startsWith("/s/")) {
				return route.fulfill({
					body: client.html,
					contentType: "text/html",
					headers: { "Content-Security-Policy": "script-src 'self' 'wasm-unsafe-eval'" },
				});
			}
			return route.fulfill({ status: 404, body: "" });
		},
	);
	await page.goto(`${base}${path}`);
	return { page, sockets };
}

async function mockMicrophone(page: Page): Promise<void> {
	await page.evaluate(() => {
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
		});
		Object.defineProperty(window, "AudioContext", {
			configurable: true,
			value: class {
				constructor() {
					throw new Error("no audio monitor in test");
				}
			},
		});
		Object.defineProperty(window, "MediaRecorder", {
			configurable: true,
			value: class {
				state = "inactive";
				ondataavailable?: (event: { data: Blob }) => void;
				onstop?: () => void;
				start() {
					this.state = "recording";
				}
				stop() {
					this.state = "inactive";
					this.ondataavailable?.({ data: new Blob(["saved-audio-marker"]) });
					this.onstop?.();
				}
			},
		});
	});
}

async function send(page: Page, text: string): Promise<void> {
	await page.locator("#input").fill(text);
	await page.locator("#send-btn").click();
}

const messages = (page: Page) => page.locator(".messages");

function lastPrompt(): { type: string; message: string; images?: unknown[] } {
	return JSON.parse(readFileSync(join(tmp, "prompts.jsonl"), "utf8").trim().split("\n").at(-1)!);
}

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
			ACB_TEST_PROMPT_LOG: join(tmp, "prompts.jsonl"),
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
	it("renders the header without Claude Code or GPT buttons", async () => {
		const { page } = await openPage("/");
		try {
			await page.locator("#header-voice").waitFor();
			expect(await page.locator("#cc-toggle, .header-cc, #fast-mode, .header-fast").count()).toBe(
				0,
			);
			expect(await page.locator("#model-picker").isVisible()).toBe(true);
			expect(
				await page.getByRole("button", { name: "Open settings", exact: true }).isVisible(),
			).toBe(true);
		} finally {
			await page.close();
		}
	});

	it("cycles voice mode in the header and Settings and preserves it on refresh", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			const toggle = page.locator("#header-voice");
			expect(await toggle.innerText()).toBe("Off");
			await toggle.click();
			expect(await toggle.innerText()).toBe("V");
			await page.reload();
			await expect.poll(() => toggle.innerText()).toBe("V");
			await page.getByRole("button", { name: "Open settings", exact: true }).click();
			const settingsVoice = page.locator(".settings-row").filter({ hasText: "Voice mode" });
			await settingsVoice.click();
			expect(await settingsVoice.locator(".overflow-value").innerText()).toBe("V+");
			expect(await toggle.innerText()).toBe("V+");
			await settingsVoice.click();
			expect(await toggle.innerText()).toBe("Off");
		} finally {
			await page.close();
		}
	});

	it.each([
		["Off", 0],
		["V", 1],
		["V+", 2],
	] as const)("%s recording has the correct auto-submit and read-back behaviour", async (mode, clicks) => {
		const { page } = await openPage("/");
		try {
			await page.waitForFunction(
				() => !document.querySelector("#send-btn")?.hasAttribute("disabled"),
			);
			await mockMicrophone(page);
			await page.route("**/api/transcribe", (route) =>
				route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({ text: `recorded in ${mode}` }),
				}),
			);
			for (let i = 0; i < clicks; i++) await page.locator("#header-voice").click();
			await page.locator("#voice-btn").click();
			await page.locator("#voice-btn").click();
			if (mode === "Off") {
				await expect.poll(() => page.locator("#input").inputValue()).toBe("recorded in Off");
				expect(await page.locator(".row-user").count()).toBe(0);
			} else {
				await expect.poll(() => messages(page).innerText()).toContain("reply 1");
				expect(await page.locator("#input").inputValue()).toBe("");
				await expect
					.poll(() => lastPrompt().message)
					.toBe(mode === "V+" ? "/voice-last long" : "recorded in V");
				// A second reply means the fake Pi received the automatic voice request.
				if (mode === "V+") await expect.poll(() => messages(page).innerText()).toContain("reply 2");
				else expect(await messages(page).innerText()).not.toContain("reply 2");
			}
		} finally {
			await page.close();
		}
	});

	it("retains a failed voice recording and retries the same audio on request", async () => {
		const { page } = await openPage("/");
		try {
			const bodies: Buffer[] = [];
			await page.route("**/api/transcribe", async (route) => {
				bodies.push(route.request().postDataBuffer()!);
				await route.fulfill({
					status: bodies.length === 1 ? 502 : 200,
					contentType: "application/json",
					body: JSON.stringify(
						bodies.length === 1 ? { error: "temporary failure" } : { text: "recovered voice note" },
					),
				});
			});
			await mockMicrophone(page);
			await page.locator("#input").fill("draft");
			await page.locator("#voice-btn").click();
			await page.locator("#voice-btn").click();
			const retry = page.getByRole("button", { name: "Retry transcription" });
			await retry.waitFor();
			expect(bodies).toHaveLength(1);
			await retry.click();
			await expect
				.poll(() => page.locator("#input").inputValue())
				.toBe("draft recovered voice note");
			expect(bodies).toHaveLength(2);
			for (const body of bodies) expect(body.toString()).toContain("saved-audio-marker");
			expect(await retry.count()).toBe(0);
		} finally {
			await page.close();
		}
	});
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

	it("keeps file and photo links out of the draft and sends both attachments once", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.locator("#input").fill("Please check these");
			await page.locator("#file-input").setInputFiles([
				{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("attached notes") },
				{ name: "photo.png", mimeType: "image/png", buffer: PNG_1X1 },
			]);
			const file = page.locator("#attachment-previews .attachment-uploaded");
			await expect.poll(() => file.count()).toBe(1);
			await expect.poll(() => page.locator("#attachment-previews img").count()).toBe(1);
			expect(await page.locator("#input").inputValue()).toBe("Please check these");
			const fileUrl = await file.getAttribute("data-url");
			await page.locator("#send-btn").click();
			await expect.poll(() => page.locator(".row-assistant").count()).toBe(2);
			await expect.poll(() => page.locator("#stop-btn").isVisible()).toBe(false);
			expect(await page.locator("#attachment-previews .attachment-preview").count()).toBe(0);
			expect(await page.locator("#input").inputValue()).toBe("");
			const prompt = lastPrompt();
			expect(prompt.type).toBe("prompt");
			expect(prompt.message).toContain(`[file: notes.txt](${join(tmp, fileUrl!)})`);
			expect(prompt.message.match(/\[file: notes.txt\]/g)).toHaveLength(1);
			expect(prompt.message).toContain("Please check these");
			expect(prompt.images).toEqual([
				{ type: "image", mimeType: "image/png", data: PNG_1X1.toString("base64") },
			]);
			expect(await messages(page).locator(".row-user").last().innerText()).toContain(
				"file: notes.txt",
			);
			await page.locator("#input").press("ArrowUp");
			expect(await page.locator("#input").inputValue()).toBe("Please check these");
			await send(page, "No attachments this time");
			await expect.poll(() => page.locator(".row-assistant").count()).toBe(3);
			expect(lastPrompt().message).toBe("No attachments this time");
			expect(lastPrompt().images).toBeUndefined();
		} finally {
			await page.close();
		}
	});

	it("removes file attachments without changing the draft and accepts a file-only prompt", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.locator("#input").fill("Leave this draft alone");
			await page.locator("#file-input").setInputFiles({
				name: "remove.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("remove me"),
			});
			await page.getByRole("button", { name: "Remove remove.txt", exact: true }).click();
			expect(await page.locator("#input").inputValue()).toBe("Leave this draft alone");
			await send(page, "No file attached");
			await expect.poll(() => page.locator(".row-assistant").count()).toBe(2);
			await expect.poll(() => page.locator("#stop-btn").isVisible()).toBe(false);
			expect(lastPrompt().message).toBe("No file attached");
			await page.locator("#file-input").setInputFiles({
				name: "only.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("file-only message"),
			});
			await page.getByRole("button", { name: "Remove only.txt", exact: true }).waitFor();
			expect(await page.locator("#input").inputValue()).toBe("");
			await page.locator("#send-btn").click();
			await expect.poll(() => page.locator(".row-assistant").count()).toBe(3);
			expect(lastPrompt().message).toMatch(/^\[file: only\.txt\]\([^)]+\.txt\)$/);
			expect(lastPrompt().images).toBeUndefined();
			expect(await page.locator("#attachment-previews .attachment-preview").count()).toBe(0);
		} finally {
			await page.close();
		}
	});

	it("queues a file-only attachment while the agent is running", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.locator("#file-input").setInputFiles({
				name: "steer.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("queued file"),
			});
			await page.getByRole("button", { name: "Remove steer.txt", exact: true }).waitFor();
			sockets.at(-1)!.send(JSON.stringify({ type: "event", event: { type: "agent_start" } }));
			await expect.poll(() => page.locator("#stop-btn").isVisible()).toBe(true);
			await page.locator("#send-btn").click();
			await expect.poll(() => lastPrompt().type).toBe("steer");
			expect(lastPrompt().message).toContain("[file: steer.txt]");
			expect(lastPrompt().images).toBeUndefined();
			expect(await page.locator(".row-steer").innerText()).toContain("file: steer.txt");
			expect(await page.locator("#attachment-previews .attachment-preview").count()).toBe(0);
		} finally {
			await page.close();
		}
	});

	it("restores queued steering after a transcript rebuild without duplicating or resending it", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			const socket = sockets.at(-1)!;
			socket.send(JSON.stringify({ type: "event", event: { type: "agent_start" } }));
			await expect.poll(() => page.locator("#stop-btn").isVisible()).toBe(true);
			await send(page, "queued course correction");
			await expect.poll(() => lastPrompt().message).toBe("queued course correction");
			expect(await page.locator(".row-steer").count()).toBe(1);
			const submitted = readFileSync(join(tmp, "prompts.jsonl"), "utf8");

			// A reconnect replaces the local optimistic steering bubble with the
			// on-disk transcript, which cannot contain an undelivered instruction.
			socket.send(JSON.stringify({ type: "transcript", sessionId: SEEDED_ID, messages: [] }));
			await expect.poll(() => page.locator(".row-steer").count()).toBe(0);
			const queue = (steering: string[]) =>
				socket.send(
					JSON.stringify({
						type: "event",
						event: { type: "queue_update", steering, followUp: [] },
					}),
				);
			queue(["queued course correction", "second instruction", "second instruction"]);
			await expect.poll(() => page.locator(".row-steer").count()).toBe(3);
			expect(await page.locator(".row-steer").allTextContents()).toEqual([
				expect.stringContaining("queued course correction"),
				expect.stringContaining("second instruction"),
				expect.stringContaining("second instruction"),
			]);
			queue(["queued course correction", "second instruction", "second instruction"]);
			queue(["second instruction"]);
			await expect.poll(() => page.locator(".steer-badge.delivered").count()).toBe(2);
			expect(await page.locator(".row-steer").count()).toBe(3);
			expect(await page.locator("#status-dynamic").innerText()).toContain("1 queued");
			queue([]);
			await expect.poll(() => page.locator(".steer-badge.delivered").count()).toBe(3);
			expect(readFileSync(join(tmp, "prompts.jsonl"), "utf8")).toBe(submitted);
		} finally {
			await page.close();
		}
	});

	it("retains file attachments after a blocked send and restores their cards on reconnect", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.locator("#input").fill("Draft with a file");
			await page.locator("#file-input").setInputFiles({
				name: "reconnect.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("retained file"),
			});
			await page.getByRole("button", { name: "Remove reconnect.txt", exact: true }).waitFor();
			await page.clock.install();
			await page.clock.pauseAt(new Date(Date.now() + 1000));
			const before = sockets.length;
			await sockets.at(-1)!.close({ code: 1001, reason: "test drop" });
			await expect.poll(() => page.locator("#status-dynamic").innerText()).toContain("closed");
			await page.locator("#send-btn").click();
			await page.getByRole("button", { name: "Reconnect", exact: true }).click();
			await expect.poll(() => sockets.length).toBeGreaterThan(before);
			await expect.poll(() => page.locator(".composer-notice-warning").count()).toBe(0);
			// Force the transcript-refresh path that replaces the composer DOM.
			sockets
				.at(-1)!
				.send(JSON.stringify({ type: "transcript", sessionId: SEEDED_ID, messages: [] }));
			await expect.poll(() => messages(page).innerText()).not.toContain("stored answer");
			expect(await page.locator("#input").inputValue()).toBe("Draft with a file");
			expect(await page.locator("#attachment-previews .attachment-uploaded").count()).toBe(1);
			await page.locator("#send-btn").click();
			await expect.poll(() => page.locator(".row-assistant").count()).toBe(1);
			expect(lastPrompt().message).toContain("[file: reconnect.txt]");
			expect(lastPrompt().message).toContain("Draft with a file");
			expect(await page.locator("#attachment-previews .attachment-preview").count()).toBe(0);
		} finally {
			await page.close();
		}
	});

	it("does not carry draft attachments into a new chat or past a composer slash command", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.locator("#file-input").setInputFiles({
				name: "previous.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("previous chat"),
			});
			await page.getByRole("button", { name: "Remove previous.txt", exact: true }).waitFor();
			await page.locator(".new-chat-btn").click();
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/live-session-001");
			expect(await page.locator("#attachment-previews .attachment-preview").count()).toBe(0);
			await page.locator("#file-input").setInputFiles({
				name: "discard.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("discard with command"),
			});
			await page.getByRole("button", { name: "Remove discard.txt", exact: true }).waitFor();
			await send(page, "/help");
			expect(await page.locator("#attachment-previews .attachment-preview").count()).toBe(0);
			await send(page, "A clean prompt");
			await expect.poll(() => lastPrompt().message).toBe("A clean prompt");
		} finally {
			await page.close();
		}
	});

	it("shows the completed file card if the composer is rebuilt during its upload", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
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
						url: "/uploads/refresh.txt",
						filename: "refresh.txt",
						mimeType: "text/plain",
						size: 5,
					},
				});
			});
			await page.locator("#input").fill("Keep this draft");
			await page.locator("#file-input").setInputFiles({
				name: "refresh.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("notes"),
			});
			await expect.poll(() => page.locator(".attachment-uploading").count()).toBe(1);
			sockets
				.at(-1)!
				.send(JSON.stringify({ type: "transcript", sessionId: SEEDED_ID, messages: [] }));
			await expect.poll(() => messages(page).innerText()).not.toContain("stored answer");
			releaseUpload();
			await page.getByRole("button", { name: "Remove refresh.txt", exact: true }).waitFor();
			expect(await page.locator("#input").inputValue()).toBe("Keep this draft");
			await page.getByRole("button", { name: "Remove refresh.txt", exact: true }).click();
			await page.locator("#send-btn").click();
			await expect.poll(() => lastPrompt().message).toBe("Keep this draft");
		} finally {
			releaseUpload();
			await page.close();
		}
	});

	it("queues a seven-photo batch, stays interactive, restores progress and avoids downloading originals for thumbnails", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		let releaseUpload = () => {};
		const ready = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		let attempts = 0;
		const downloads: string[] = [];
		const photo = Buffer.concat([PNG_1X1, Buffer.alloc(5 * 1024 * 1024 - PNG_1X1.length)]);
		try {
			await page.setViewportSize({ width: 393, height: 851 });
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			page.on("request", (request) => {
				if (new URL(request.url()).pathname.startsWith("/uploads/batch-"))
					downloads.push(request.url());
			});
			await page.route("**/api/upload", async (route) => {
				const index = ++attempts;
				await ready;
				await route.fulfill({
					json: {
						url: `/uploads/batch-${index}.png`,
						filename: `batch-${index}.png`,
						mimeType: "image/png",
						size: photo.length,
					},
				});
			});
			await page.locator("#file-input").setInputFiles(
				Array.from({ length: 7 }, (_, index) => ({
					name: `photo-${index}.png`,
					mimeType: "image/png",
					buffer: photo,
				})),
			);
			await expect.poll(() => attempts).toBe(2);
			expect(await page.locator(".attachment-uploading").count()).toBe(7);
			expect(await page.locator(".attachment-file-state", { hasText: "Queued" }).count()).toBe(5);
			await page.getByRole("button", { name: "Cancel upload of photo-6.png", exact: true }).click();
			await expect.poll(() => page.locator(".attachment-upload-cancelled").count()).toBe(1);
			await page.locator("#input").fill("Typing while photos upload");
			sockets
				.at(-1)!
				.send(JSON.stringify({ type: "transcript", sessionId: SEEDED_ID, messages: [] }));
			await expect.poll(() => messages(page).innerText()).not.toContain("stored answer");
			expect(await page.locator(".attachment-uploading").count()).toBe(6);
			expect(await page.locator("#input").inputValue()).toBe("Typing while photos upload");
			releaseUpload();
			await expect
				.poll(() => page.locator('#attachment-previews img[src^="data:image/png"]').count())
				.toBe(6);
			expect(attempts).toBe(6);
			expect(downloads).toEqual([]);
			expect(await page.locator(".attachment-uploading").count()).toBe(0);
		} finally {
			releaseUpload();
			await page.close();
		}
	});

	it("counts queued images towards the prompt limit before any upload finishes", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		let releaseUploads = () => {};
		const ready = new Promise<void>((resolve) => {
			releaseUploads = resolve;
		});
		let attempts = 0;
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.route("**/api/upload", async (route) => {
				const index = ++attempts;
				await ready;
				await route.fulfill({
					json: {
						url: `/uploads/limit-${index}.png`,
						filename: `limit-${index}.png`,
						mimeType: "image/png",
						size: PNG_1X1.length,
					},
				});
			});
			await page.locator("#file-input").setInputFiles(
				Array.from({ length: 21 }, (_, index) => ({
					name: `photo-${index}.png`,
					mimeType: "image/png",
					buffer: PNG_1X1,
				})),
			);
			await expect.poll(() => attempts).toBe(2);
			expect(await page.locator(".attachment-uploading").count()).toBe(20);
			await expect
				.poll(() => page.locator(".composer-notice-error").innerText())
				.toContain("at most 20 images");
			releaseUploads();
			await expect
				.poll(() => page.locator('#attachment-previews img[src^="data:image/png"]').count())
				.toBe(20);
			expect(attempts).toBe(20);
		} finally {
			releaseUploads();
			await page.close();
		}
	});

	it("keeps prompt image order when the second photo finishes uploading first", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		let releaseFirst = () => {};
		const ready = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let attempts = 0;
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.route("**/api/upload", async (route) => {
				const index = attempts++;
				const response = await route.fetch();
				if (index === 0) await ready;
				await route.fulfill({ response });
			});
			await page.locator("#file-input").setInputFiles(
				["first.png", "second.png"].map((name) => ({
					name,
					mimeType: "image/png",
					buffer: PNG_1X1,
				})),
			);
			await page.getByRole("button", { name: "Remove second.png", exact: true }).waitFor();
			expect(
				await page.getByRole("button", { name: "Remove first.png", exact: true }).count(),
			).toBe(0);
			releaseFirst();
			await page.getByRole("button", { name: "Remove first.png", exact: true }).waitFor();
			await send(page, "Compare these in selection order");
			await expect.poll(() => lastPrompt().message).toContain("Compare these in selection order");
			expect(lastPrompt().images).toHaveLength(2);
			expect(lastPrompt().message.indexOf("first.png")).toBeLessThan(
				lastPrompt().message.indexOf("second.png"),
			);
		} finally {
			releaseFirst();
			await page.close();
		}
	});

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

	it("keeps stop confirmations inline but still warns about unexpected time limits", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			const socket = sockets.at(-1)!;
			socket.send(
				JSON.stringify({
					type: "event",
					event: {
						type: "message_start",
						message: {
							role: "custom",
							customType: "note",
							content: "⏹ Stopped.",
							details: { source: "claude-delegate" },
						},
					},
				}),
			);
			const notify = (message: string) =>
				socket.send(
					JSON.stringify({
						type: "event",
						event: {
							type: "extension_ui_request",
							method: "notify",
							message,
							notifyType: "warning",
						},
					}),
				);
			notify("⏱ Stopped: the run hit the 3h time limit.");
			const warning = page.locator(".composer-notice-warning");
			await expect.poll(() => warning.count()).toBe(1);
			expect(await warning.innerText()).toContain("time limit");
			expect(await messages(page).innerText()).toContain("⏹ Stopped.");
			await warning.getByRole("button", { name: "Dismiss warning", exact: true }).click();
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
					page.locator(`#attachment-previews [data-url="/uploads/${SEEDED_IMAGE}"] img`).count(),
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

	it("keeps model errors inline for empty and partial responses without popups", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			const event = (event: Record<string, unknown>) =>
				sockets.at(-1)!.send(JSON.stringify({ type: "event", event }));
			const errorMessage = '402 "Insufficient USD or Diem balance to complete request."';
			const responses = [
				[],
				[{ type: "text", text: "Partial answer before failure" }],
				[{ type: "thinking", thinking: "Thinking before failure" }],
			];
			for (const [index, content] of responses.entries()) {
				const message = {
					role: "assistant",
					content,
					stopReason: "error",
					errorMessage,
					timestamp: Date.now(),
				};
				event({ type: "message_start", message });
				event({ type: "message_update", message });
				event({ type: "message_end", message });
				event({ type: "auto_retry_end", success: false, finalError: errorMessage });
				await expect.poll(() => page.locator(".row-error").count()).toBe(index + 1);
				expect(await page.locator(".row-error").last().innerText()).toContain(errorMessage);
				expect(await page.locator(".composer-notice-error").count()).toBe(0);
			}
			expect(await messages(page).innerText()).toContain("Partial answer before failure");
			expect(await page.locator("#composer-notices").isVisible()).toBe(false);
		} finally {
			await page.close();
		}
	});

	it("keeps automatic retry progress in the footer and final failures inline", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			const event = (event: Record<string, unknown>) =>
				sockets.at(-1)!.send(JSON.stringify({ type: "event", event }));
			event({ type: "auto_retry_end", success: false, finalError: "Provider unavailable" });
			await expect
				.poll(() => page.locator(".row-error").innerText())
				.toContain("Provider unavailable");
			expect(await page.locator(".composer-notice-error").count()).toBe(0);
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

	it("runs the voice-test UI on an isolated socket and saves a summary", async () => {
		const { page } = await openPage("/");
		await expect.poll(() => page.locator("#model-picker").innerText()).toContain("Model");
		const voiceCommands: string[] = [];
		await page.route("**/api/tts/stream", (route) =>
			route.fulfill({
				body: Buffer.from([0, 0, 0, 0, 0]),
				contentType: "application/octet-stream",
			}),
		);
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			const event = (details: Record<string, unknown>) =>
				ws.send(
					JSON.stringify({
						type: "event",
						event: {
							type: "message_end",
							message: { role: "custom", customType: "acb-voice-test", details },
						},
					}),
				);
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init") {
					ws.send(JSON.stringify({ type: "ready", sessionId: "voice-session-001" }));
				} else if (message.type === "getCapabilities") {
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "voicetest" }] }));
				} else if (message.type === "prompt") {
					voiceCommands.push(message.text);
					if (message.text === "/voicetest start")
						event({ kind: "ready", model: "venice/deepseek-v4-1-flash-1017" });
					else if (message.text.startsWith("/voicetest say ")) {
						const [, , turn, ...words] = message.text.split(" ");
						event({ kind: "user", turn, text: words.join(" ") });
						event({ kind: "sentence", turn, text: "Hello from the voice model.", firstTextMs: 42 });
						event({ kind: "done", turn, interrupted: false, elapsedMs: 50 });
					} else if (message.text === "/voicetest stop") {
						event({ kind: "summary", text: "A short test conversation." });
						event({ kind: "stopped" });
					}
				}
			});
		});
		try {
			await send(page, "/voicetest");
			const dialog = page.getByRole("dialog", { name: "Browser voice test" });
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			expect(await dialog.innerText()).toContain("venice/deepseek-v4-1-flash-1017");
			expect(await dialog.getByRole("link", { name: "Open saved transcript" }).count()).toBe(0);
			await dialog.getByRole("textbox", { name: "Voice test message" }).fill("Hello test");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();
			await expect
				.poll(() => dialog.getByRole("log").innerText())
				.toContain("Hello from the voice model.");
			expect(await dialog.getByRole("log").innerText()).toContain("You: Hello test");
			expect(
				await dialog.getByRole("link", { name: "Open saved transcript" }).getAttribute("href"),
			).toBe("/s/voice-session-001");
			await dialog.getByRole("button", { name: "Interrupt", exact: true }).click();
			// Real Silero/ONNX/AudioWorklet initialisation, with a synthetic silent
			// microphone: tests must never open the machine's actual microphone.
			await page.evaluate(() => {
				const context = new AudioContext();
				const destination = context.createMediaStreamDestination();
				const source = context.createConstantSource();
				source.offset.value = 0;
				source.connect(destination);
				source.start();
				void context.resume();
				(window as unknown as { __voiceTestStream: MediaStream }).__voiceTestStream =
					destination.stream;
				Object.defineProperty(navigator, "mediaDevices", {
					configurable: true,
					value: { getUserMedia: async () => destination.stream },
				});
			});
			await dialog.getByRole("button", { name: "Start microphone", exact: true }).click();
			await expect
				.poll(() => dialog.locator(".voice-test-status").innerText(), { timeout: 20_000 })
				.toBe("Listening…");
			await dialog.getByRole("button", { name: "Stop microphone", exact: true }).click();
			expect(
				await page.evaluate(() =>
					(window as unknown as { __voiceTestStream: MediaStream }).__voiceTestStream
						.getTracks()
						.every((track: MediaStreamTrack) => track.readyState === "ended"),
				),
			).toBe(true);
			await dialog.getByRole("button", { name: "End test & summarise" }).click();
			await expect.poll(() => dialog.innerText()).toContain("Test ended; transcript saved");
			expect(await dialog.getByRole("log").innerText()).toContain("A short test conversation.");
			expect(voiceCommands).toContain("/voicetest interrupt");
			await dialog.getByRole("button", { name: "Close Browser voice test" }).click();
			await send(page, "normal chat still works");
			await expect.poll(() => messages(page).innerText()).toContain("reply 1");
		} finally {
			await page.close();
		}
	});

	it("never sends a voice prompt if the Pi extension is absent", async () => {
		const { page } = await openPage("/");
		await expect.poll(() => page.locator("#model-picker").innerText()).toContain("Model");
		const prompts: string[] = [];
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init") {
					ws.send(JSON.stringify({ type: "ready", sessionId: "not-a-voice-session" }));
				} else if (message.type === "getCapabilities") {
					ws.send(JSON.stringify({ type: "capabilities", commands: [] }));
				} else if (message.type === "prompt") prompts.push(message.text);
			});
		});
		try {
			await send(page, "/voicetest");
			const dialog = page.getByRole("dialog", { name: "Browser voice test" });
			await expect.poll(() => dialog.innerText()).toContain("not installed");
			expect(prompts).toEqual([]);
			expect(await dialog.getByRole("button", { name: "Start microphone" }).isDisabled()).toBe(
				true,
			);
		} finally {
			await page.close();
		}
	});

	it("resumes legacy Relay without replaying speech or work, and only explicitly cancels the job", async () => {
		const { page } = await openPage("/");
		await page.evaluate(() => localStorage.setItem("acb-relay-voice-engine", "legacy"));
		await expect.poll(() => page.locator("#model-picker").innerText()).toContain("Model");
		const inits: Array<Record<string, unknown>> = [];
		const prompts: string[] = [];
		let cancelled = false;
		await page.route("**/api/tts/stream", (route) =>
			route.fulfill({
				body: Buffer.from([0, 0, 0, 0, 0]),
				contentType: "application/octet-stream",
			}),
		);
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			const native = (event: Record<string, unknown>) =>
				ws.send(JSON.stringify({ type: "event", event }));
			const custom = (details: Record<string, unknown>) =>
				native({
					type: "message_end",
					message: { role: "custom", customType: "acb-relay", details },
				});
			const job = () =>
				custom({
					kind: "job",
					uncertain: false,
					job: {
						id: "relay-worker-1",
						title: "Read-only fixture",
						status: cancelled ? "stopped" : "needs_input",
						updatedAt: "2026-11-05T00:00:00Z",
						summary: cancelled ? "Cancelled" : "Which option?",
					},
				});
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init") {
					inits.push(message);
					ws.send(JSON.stringify({ type: "ready", sessionId: "relay-session-1" }));
					if (message.sessionId)
						ws.send(
							JSON.stringify({
								type: "transcript",
								messages: [
									{ role: "user", content: "Inspect the fixture" },
									{ role: "assistant", content: [{ type: "text", text: "Your saved answer." }] },
								],
							}),
						);
				} else if (message.type === "getCapabilities")
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "relay" }] }));
				else if (message.type === "prompt") {
					prompts.push(message.text);
					if (message.text.startsWith("/relay start")) {
						custom({
							kind: "ready",
							model: "venice/deepseek-v4-1-flash-1017",
							workerModel: { provider: "openai", modelId: "work-model", thinkingLevel: "high" },
						});
						if (message.sessionId || inits.length > 1) job();
					} else if (message.text.startsWith("/relay say ")) {
						native({
							type: "message_end",
							message: { role: "user", content: message.text.split(" ").slice(3).join(" ") },
						});
						native({ type: "message_start", message: { role: "assistant" } });
						native({
							type: "message_update",
							assistantMessageEvent: {
								type: "text_delta",
								delta: "The worker needs your choice. ",
							},
						});
						native({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "The worker needs your choice." }],
							},
						});
						job();
					} else if (message.text === "/relay cancel") {
						cancelled = true;
						job();
					}
				}
			});
		});
		try {
			await page.setViewportSize({ width: 390, height: 844 });
			const relayButton = page.getByRole("button", { name: "Open Relay", exact: true });
			expect(await relayButton.isVisible()).toBe(true);
			expect(await relayButton.innerText()).toBe("R");
			expect(await page.locator("#header-relay + #header-voice").count()).toBe(1);
			const relayBounds = await relayButton.boundingBox();
			const voiceBounds = await page.locator("#header-voice").boundingBox();
			expect(relayBounds!.x + relayBounds!.width).toBeLessThanOrEqual(voiceBounds!.x);
			await relayButton.click();
			let dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect.poll(() => dialog.innerText()).toContain("worker: openai/work-model (high)");
			await dialog.getByRole("textbox", { name: "Relay message" }).fill("Inspect the fixture");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();
			await expect
				.poll(() => dialog.getByRole("log").innerText())
				.toContain("The worker needs your choice.");
			expect(await dialog.locator(".relay-job").innerText()).toContain("Not live progress");
			await dialog.getByRole("button", { name: "Interrupt", exact: true }).click();
			await dialog.getByRole("button", { name: "Close Relay", exact: true }).click();
			expect(cancelled).toBe(false);
			await send(page, "/relay");
			dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect.poll(() => dialog.getByRole("log").innerText()).toContain("Your saved answer.");
			expect(inits.at(-1)?.sessionId).toBe("relay-session-1");
			expect(prompts.filter((p) => p.startsWith("/relay say "))).toHaveLength(1);
			await dialog.getByRole("button", { name: "Cancel work job", exact: true }).click();
			await expect
				.poll(() => dialog.locator(".relay-job").innerText())
				.toContain("Recorded: stopped");
			expect(cancelled).toBe(true);
			await dialog.getByRole("button", { name: "New Relay conversation" }).click();
			await expect.poll(() => inits.length).toBe(3);
			expect(inits.at(-1)?.sessionId).toBeUndefined();
			await page.getByRole("button", { name: "Close Relay", exact: true }).click();
		} finally {
			await page.close();
		}
	});

	it("renders legacy Kokoro Relay Markdown before speaking and never replays restored answers", async () => {
		const { page } = await openPage("/");
		const tts: string[] = [];
		let native: (event: object) => void = () => {};
		const first = "### Status\n\n**The first sentence is ready. More";
		const rest =
			" detail.**\n\n1. Read [the guide](https://example.com/private).\n2. Keep `sensor_home`.\n";
		const markdown = first + rest;
		await page.evaluate(() => {
			localStorage.setItem("acb-relay-voice-engine", "legacy");
			localStorage.removeItem("acb-relay-session");
		});
		await page.route("**/api/tts/stream", (route) => {
			tts.push(route.request().postDataJSON().text);
			return route.fulfill({
				body: Buffer.alloc(5),
				contentType: "application/octet-stream",
			});
		});
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			native = (event) => ws.send(JSON.stringify({ type: "event", event }));
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init") {
					ws.send(JSON.stringify({ type: "ready", sessionId: "legacy-markdown-session" }));
					if (message.sessionId)
						ws.send(
							JSON.stringify({
								type: "transcript",
								messages: [{ role: "assistant", content: markdown }],
							}),
						);
				} else if (message.type === "getCapabilities")
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "relay" }] }));
				else if (message.type === "prompt" && message.text.startsWith("/relay start"))
					native({
						type: "message_end",
						message: {
							role: "custom",
							customType: "acb-relay",
							details: {
								kind: "ready",
								model: "venice/deepseek-v4-1-flash-1017",
								workerModel: { provider: "venice", modelId: "fixture", thinkingLevel: "off" },
							},
						},
					});
				else if (message.type === "prompt" && message.text.startsWith("/relay say ")) {
					native({ type: "message_start", message: { role: "assistant" } });
					native({
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: first },
					});
				}
			});
		});
		try {
			await send(page, "/relay legacy");
			let dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			await dialog.getByRole("textbox", { name: "Relay message" }).fill("Read the fixture");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();
			await expect
				.poll(() => dialog.getByRole("log").innerText())
				.toContain("The first sentence is ready.");
			expect(tts).toEqual([]); // Unclosed bold must not leak markers to TTS.
			native({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: rest },
			});
			await expect.poll(() => tts.length).toBe(4); // Before message_end.
			expect(tts).toEqual([
				"Status The first sentence is ready.",
				"More detail.",
				"Read the guide.",
				"Keep sensor_home.",
			]);
			expect(await dialog.locator(".markdown h3").innerText()).toBe("Status");
			expect(await dialog.locator(".markdown strong").innerText()).toBe(
				"The first sentence is ready. More detail.",
			);
			expect(await dialog.locator(".markdown ol li").count()).toBe(2);
			native({ type: "message_end", message: { role: "assistant", content: markdown } });
			await dialog.getByRole("button", { name: "Close Relay", exact: true }).click();
			await send(page, "/relay legacy");
			dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect.poll(() => dialog.locator(".markdown h3").innerText()).toBe("Status");
			expect(tts).toHaveLength(4);
			await dialog.getByRole("button", { name: "Close Relay", exact: true }).click();
		} finally {
			await page.close();
		}
	});

	it("cleans streamed Markdown before splitting speech, including split formatting and list markers", async () => {
		const { page } = await openPage("/");
		try {
			const bundle = await build({
				stdin: {
					contents:
						'import { SpokenMarkdown } from "./src/client/spoken-markdown.ts"; globalThis.TestSpokenMarkdown = SpokenMarkdown;',
					resolveDir: root,
				},
				bundle: true,
				write: false,
				format: "iife",
				platform: "browser",
			});
			await page.route("**/__test-spoken-markdown.js", (route) =>
				route.fulfill({
					contentType: "text/javascript",
					body: bundle.outputFiles[0].text,
				}),
			);
			await page.addScriptTag({ url: "/__test-spoken-markdown.js" });
			const render = (source: string) =>
				page.evaluate(`(() => {
				const speech = new TestSpokenMarkdown(), chunks = [];
				for (const character of ${JSON.stringify(source)}) chunks.push(...speech.push(character));
				chunks.push(...speech.push("", true));
				return chunks;
			})()`);
			expect(await render("**Hello. World.** ")).toEqual(["Hello.", "World."]);
			expect(
				await render(
					"# Status\n\n1. **Ready.**\n2. [Read the guide](https://example.com/private). ",
				),
			).toEqual(["Status Ready.", "Read the guide."]);
			expect(await render("- First.\n- Second. ")).toEqual(["First.", "Second."]);
			expect(await render("```text\n" + "not spoken.\n".repeat(10) + "```\nDone. ")).toEqual([
				"[code block] Done.",
			]);
			expect(await render("Use `sensor_home` and compute 5 * 3 = 15. ")).toEqual([
				"Use sensor_home and compute 5 * 3 = 15.",
			]);
			expect(
				await render("Read [the guide][ref].\n\n[ref]: https://example.com/private\n"),
			).toEqual(["Read the guide."]);
			expect(await render("---\n\n![A diagram](https://example.com/image.png) ")).toEqual([
				"A diagram",
			]);
		} finally {
			await page.close();
		}
	});

	it("trials streaming Pi speech before turn completion without cancelling work or changing production Relay", async () => {
		const { page } = await openPage("/");
		const prompts: string[] = [],
			controls: string[] = [],
			tts: string[] = [];
		const inits: Record<string, unknown>[] = [];
		const contexts = new Map<string, string>();
		let native: (event: object) => void = () => {};
		// Real Web Audio decoding/playback, synthetic tone only; never a microphone.
		const wav = Buffer.alloc(44 + 24000 * 2 * 2);
		wav.write("RIFF");
		wav.writeUInt32LE(wav.length - 8, 4);
		wav.write("WAVEfmt ", 8);
		wav.writeUInt32LE(16, 16);
		wav.writeUInt16LE(1, 20);
		wav.writeUInt16LE(1, 22);
		wav.writeUInt32LE(24000, 24);
		wav.writeUInt32LE(48000, 28);
		wav.writeUInt16LE(2, 32);
		wav.writeUInt16LE(16, 34);
		wav.write("data", 36);
		wav.writeUInt32LE(wav.length - 44, 40);
		for (let i = 0; i < 48000; i++)
			wav.writeInt16LE(Math.round(8000 * Math.sin(i * 0.1)), 44 + i * 2);
		const frame = Buffer.alloc(5);
		frame[0] = 1;
		frame.writeUInt32LE(wav.length, 1);
		await page.route("**/api/tts/stream", async (route) => {
			tts.push(route.request().postDataJSON().text);
			await route.fulfill({
				body: Buffer.concat([frame, wav, Buffer.alloc(5)]),
				contentType: "application/octet-stream",
			});
		});
		await page.evaluate(() => {
			localStorage.setItem("acb-relay-session", "keep-production-session");
			localStorage.setItem("acb-relay-voice-engine", "server4");
		});
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			native = (event) => ws.send(JSON.stringify({ type: "event", event }));
			const custom = (details: object) =>
				native({
					type: "message_end",
					message: { role: "custom", customType: "acb-relay", details },
				});
			ws.onMessage((raw) => {
				const m = JSON.parse(String(raw));
				if (m.type === "init") {
					inits.push(m);
					ws.send(JSON.stringify({ type: "ready", sessionId: "stream-trial-session" }));
					if (m.sessionId)
						ws.send(
							JSON.stringify({
								type: "transcript",
								messages: [{ role: "assistant", content: "Saved, not replayed." }],
							}),
						);
				} else if (m.type === "getCapabilities")
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "relay" }] }));
				else if (m.type === "prompt") {
					prompts.push(m.text);
					if (m.text.startsWith("/relay start"))
						custom({
							kind: "ready",
							model: "venice/deepseek-v4-1-flash-1017",
							workerModel: { provider: "venice", modelId: "fixture", thinkingLevel: "off" },
						});
					const [, action, id, encoded] = m.text.split(" ");
					if (action === "voice-context")
						contexts.set(id, JSON.parse(Buffer.from(encoded, "base64url").toString()).text);
					if (action === "voice-request") {
						native({ type: "message_end", message: { role: "user", content: contexts.get(id) } });
						native({ type: "message_start", message: { role: "assistant" } });
						native({
							type: "message_update",
							assistantMessageEvent: {
								type: "text_delta",
								delta: "### Greeting\n\n**The first streamed sentence is ready.** ",
							},
						});
					}
				} else controls.push(m.type);
			});
		});
		try {
			await send(page, "/relaytrial");
			let dialog = page.getByRole("dialog", { name: "Trial A — streaming Pi voice", exact: true });
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			expect(inits[0].sessionId).toBeUndefined();
			expect(await dialog.locator("iframe").count()).toBe(0);
			await dialog.getByRole("textbox", { name: "Relay message" }).fill("Read a harmless fixture");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();
			await expect.poll(() => tts.length).toBe(1); // No message_end or agent_settled was sent.
			await expect
				.poll(() => dialog.locator(".voice-test-status").innerText())
				.toContain("Speaking");
			await dialog.getByRole("button", { name: "Interrupt", exact: true }).click();
			await expect.poll(() => prompts.some((p) => p.startsWith("/relay voice-heard "))).toBe(true);
			const heard = prompts.find((p) => p.startsWith("/relay voice-heard "))!;
			expect(JSON.parse(Buffer.from(heard.split(" ")[3], "base64url").toString()).text).toContain(
				"exact words unknown",
			);
			native({ type: "message_start", message: { role: "assistant" } });
			native({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "This old tool reply must remain silent. ",
				},
			});
			native({
				type: "message_end",
				message: { role: "assistant", content: "This old tool reply must remain silent." },
			});
			expect(controls).not.toContain("abort");
			await dialog.getByRole("button", { name: "Stop current Pi turn", exact: true }).click();
			await expect.poll(() => controls.filter((c) => c === "abort").length).toBe(1);
			await dialog.getByRole("textbox", { name: "Relay message" }).fill("Another harmless fixture");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();
			await expect
				.poll(() =>
					prompts.some((p) => {
						if (!p.startsWith("/relay voice-heard ")) return false;
						const text = JSON.parse(Buffer.from(p.split(" ")[3], "base64url").toString()).text;
						return (
							text.includes("Greeting The first streamed sentence is ready.") &&
							!text.includes("**") &&
							!text.includes("exact words unknown")
						);
					}),
				)
				.toBe(true);
			await dialog
				.getByRole("button", { name: "Close Trial A — streaming Pi voice", exact: true })
				.click();
			expect(tts).toEqual([
				"Greeting The first streamed sentence is ready.",
				"Greeting The first streamed sentence is ready.",
			]);
			expect(prompts).not.toContain("/relay cancel");
			await send(page, "/relaytrial");
			dialog = page.getByRole("dialog", { name: "Trial A — streaming Pi voice", exact: true });
			await expect
				.poll(() => dialog.getByRole("log").innerText())
				.toContain("Saved, not replayed.");
			expect(inits.at(-1)?.sessionId).toBe("stream-trial-session");
			expect(tts).toHaveLength(2);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-session"))).toBe(
				"keep-production-session",
			);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-voice-engine"))).toBe(
				"server4",
			);
			await dialog
				.getByRole("button", { name: "Close Trial A — streaming Pi voice", exact: true })
				.click();
		} finally {
			await page.close();
		}
	});

	it("stages Pi + Server4 LFM speech-only TTS in /relaytrial with Markdown rendering and speech-only interruption", async () => {
		const { page } = await openPage("/");
		const prompts: string[] = [],
			controls: string[] = [],
			ttsWsReceived: Array<Record<string, unknown>> = [],
			contexts = new Map<string, string>();
		let kokoroCalls = 0;
		let native: (event: object) => void = () => {};
		const makePcmFrame = (epoch: number, sampleCount: number): Buffer => {
			const buf = Buffer.alloc(4 + sampleCount * 2);
			buf.writeUInt32BE(epoch, 0);
			for (let i = 0; i < sampleCount; i++) {
				buf.writeInt16LE(Math.round(6000 * Math.sin(i * 0.08)), 4 + i * 2);
			}
			return buf;
		};
		await page.route("**/api/tts/**", (route) => {
			kokoroCalls++;
			return route.abort();
		});
		await page.evaluate(() => {
			localStorage.setItem("acb-relay-session", "keep-production-session");
			localStorage.setItem("acb-relay-voice-engine", "server4");
		});
		await page.routeWebSocket(/\/experiments\/lfm-voice\/ws\?tts=1$/, (ws) => {
			ws.send(JSON.stringify({ type: "starting" }));
			ws.send(
				JSON.stringify({
					type: "ready",
					protocol: 3,
					tts: 1,
					outputRate: 24000,
					loadMs: 740,
				}),
			);
			ws.onMessage((raw) => {
				const m = JSON.parse(String(raw)) as Record<string, unknown>;
				ttsWsReceived.push(m);
				if (m.type === "speak" && m.seq === 0) {
					const epoch = Number(m.epoch);
					ws.send(JSON.stringify({ type: "first_pcm", epoch, seq: 0, ttsFirstPcmMs: 58 }));
					ws.send(makePcmFrame(epoch, 24000)); // 1.0s progressive 24 kHz PCM (> 240ms preroll)
					ws.send(makePcmFrame(epoch, 24000)); // another 1.0s
				} else if (m.type === "end") {
					ws.send(
						JSON.stringify({
							type: "utterance_done",
							epoch: m.epoch,
							utterance: m.utterance,
							truncated: false,
						}),
					);
				} else if (m.type === "cancel") {
					ws.send(
						JSON.stringify({
							type: "played_prefix",
							epoch: m.epoch,
							utterance: m.utterance,
							playedMs: m.played_ms,
							text: "Deployment Check First",
							complete: false,
							uncertain: false,
						}),
					);
				} else if (m.type === "played") {
					ws.send(
						JSON.stringify({
							type: "played_prefix",
							epoch: m.epoch,
							utterance: m.utterance,
							playedMs: m.played_ms,
							text: "Confirmed amber forty two.",
							complete: true,
							uncertain: false,
						}),
					);
				}
			});
		});
		let turnCount = 0;
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			native = (event) => ws.send(JSON.stringify({ type: "event", event }));
			const custom = (details: object) =>
				native({
					type: "message_end",
					message: { role: "custom", customType: "acb-relay", details },
				});
			ws.onMessage((raw) => {
				const m = JSON.parse(String(raw));
				if (m.type === "init") {
					ws.send(JSON.stringify({ type: "ready", sessionId: "lfm-trial-session" }));
				} else if (m.type === "getCapabilities") {
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "relay" }] }));
				} else if (m.type === "prompt") {
					prompts.push(m.text);
					if (m.text.startsWith("/relay start")) {
						custom({
							kind: "ready",
							model: "venice/deepseek-v4-1-flash-1017",
							workerModel: { provider: "venice", modelId: "fixture", thinkingLevel: "off" },
						});
					}
					const [, action, id, encoded] = m.text.split(" ");
					if (action === "voice-context") {
						const text = JSON.parse(Buffer.from(encoded, "base64url").toString()).text;
						contexts.set(id, text);
						custom({ kind: "voice_context", id, user: text });
					}
					if (action === "voice-heard") {
						const text = JSON.parse(Buffer.from(encoded, "base64url").toString()).text;
						custom({ kind: "voice_context", id, heard: text });
					}
					if (action === "voice-request") {
						turnCount++;
						native({ type: "message_end", message: { role: "user", content: contexts.get(id) } });
						native({ type: "message_start", message: { role: "assistant" } });
						if (turnCount === 1) {
							// Stream Markdown WITHOUT message_end yet to prove progressive sentence streaming!
							native({
								type: "message_update",
								assistantMessageEvent: {
									type: "text_delta",
									delta:
										"### Deployment Check\n\n**First sentence plays immediately.**\n\n- Bullet item stays formatted in chat. ",
								},
							});
						} else {
							native({
								type: "message_update",
								assistantMessageEvent: {
									type: "text_delta",
									delta: "Confirmed amber forty two.",
								},
							});
							native({
								type: "message_end",
								message: { role: "assistant", content: "Confirmed amber forty two." },
							});
						}
					}
				} else controls.push(m.type);
			});
		});
		try {
			await send(page, "/relaytrial");
			let dialog = page.getByRole("dialog", { name: "Trial A — streaming Pi voice", exact: true });
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			await dialog.getByRole("button", { name: "Use LFM TTS (speech-only)", exact: true }).click();
			dialog = page.getByRole("dialog", { name: "Trial A — streaming Pi voice", exact: true });
			await expect.poll(() => dialog.innerText()).toContain("Pi + Server4 LFM TTS (speech-only)");
			expect(await dialog.locator("iframe").count()).toBe(0);

			await dialog.getByRole("textbox", { name: "Relay message" }).fill("Check status");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();

			// Progressive sentence sent to /ws?tts=1 with stripped Markdown while HTML heading/bold/list render in log:
			await expect
				.poll(() => ttsWsReceived.filter((m) => m.type === "speak").length)
				.toBeGreaterThanOrEqual(1);
			expect(ttsWsReceived.find((m) => m.type === "speak")?.text).toBe(
				"Deployment Check First sentence plays immediately.",
			);
			await expect
				.poll(() => dialog.locator(".voice-test-transcript .markdown h3").innerText())
				.toBe("Deployment Check");
			expect(await dialog.locator(".voice-test-transcript .markdown ul li").count()).toBe(1);
			await expect
				.poll(() => dialog.locator(".voice-test-status").innerText())
				.toContain("Speaking");
			await expect
				.poll(() => dialog.locator(".voice-test-metrics").innerText())
				.toContain("Server4 native 58 ms");
			await page.waitForTimeout(120);

			// Interrupt mid-speech: stops speech only, sends cancel, records unhinted played prefix, never aborts Pi!
			await dialog.getByRole("button", { name: "Interrupt", exact: true }).click();
			await expect.poll(() => ttsWsReceived.some((m) => m.type === "cancel")).toBe(true);
			expect(Number(ttsWsReceived.find((m) => m.type === "cancel")?.played_ms)).toBeGreaterThan(0);
			await expect.poll(() => prompts.some((p) => p.startsWith("/relay voice-heard "))).toBe(true);
			const heardCmd = prompts.find((p) => p.startsWith("/relay voice-heard "))!;
			const heardText = JSON.parse(
				Buffer.from(heardCmd.split(" ")[3], "base64url").toString(),
			).text;
			expect(heardText).toContain("Deployment Check First");
			expect(heardText).toContain("Remaining generated text in chat was NOT played.");
			expect(controls).not.toContain("abort");
			expect(prompts).not.toContain("/relay cancel");
			expect(kokoroCalls).toBe(0);

			// Follow-up utterance runs on epoch 2 cleanly and production Relay preferences remain untouched:
			await dialog.getByRole("textbox", { name: "Relay message" }).fill("Confirm amber 42");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();
			await expect
				.poll(() => ttsWsReceived.some((m) => m.type === "speak" && m.epoch === 2))
				.toBe(true);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-session"))).toBe(
				"keep-production-session",
			);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-voice-engine"))).toBe(
				"server4",
			);
			await dialog
				.getByRole("button", { name: "Close Trial A — streaming Pi voice", exact: true })
				.click();
		} finally {
			await page.close();
		}
	});

	it("connects Server4 voice to Relay without aborting work or trusting other windows", async () => {
		const { page } = await openPage("/");
		const prompts: string[] = [],
			controls: string[] = [],
			inits: Record<string, unknown>[] = [];
		let ttsCalls = 0;
		await page.route("**/api/tts/**", (route) => {
			ttsCalls++;
			return route.abort();
		});
		await page.route("**/experiments/lfm-voice/**", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><body>Local voice fixture<script>
		window.received=[];window.addEventListener('message',e=>{if(e.source!==parent||e.origin!==location.origin)return;received.push(e.data);if(e.data.type==='configure')document.body.dataset.ready='yes';});
		parent.postMessage({source:'lfm-relay',type:'loaded'},location.origin);
		</script>`,
			}),
		);
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			const native = (event: object) => ws.send(JSON.stringify({ type: "event", event }));
			const custom = (details: object) =>
				native({
					type: "message_end",
					message: { role: "custom", customType: "acb-relay", details },
				});
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init") {
					inits.push(message);
					ws.send(JSON.stringify({ type: "ready", sessionId: "local-relay-session" }));
				} else if (message.type === "getCapabilities")
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "relay" }] }));
				else if (message.type === "prompt") {
					prompts.push(message.text);
					if (message.text.startsWith("/relay start"))
						custom({
							kind: "ready",
							model: "venice/deepseek-v4-1-flash-1017",
							workerModel: { provider: "openai", modelId: "fixture", thinkingLevel: "high" },
							voice: { protocol: 1, instructions: "Fixture", tools: [] },
						});
					if (message.text.startsWith("/relay voice-config "))
						custom({
							kind: "voice_config",
							config: { protocol: 1, instructions: "Refreshed", tools: [] },
						});
					if (message.text.startsWith("/relay voice-context "))
						custom({ kind: "voice_context", id: "voice-one", user: "Inspect the fixture." });
					if (message.text.startsWith("/relay voice-request ")) {
						native({ type: "message_start", message: { role: "assistant" } });
						native({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", delta: "The fixture says amber." },
						});
						native({
							type: "message_end",
							message: { role: "assistant", content: "The fixture says amber." },
						});
						custom({ kind: "voice_result", id: "voice-one", text: "The fixture says amber." });
					}
				} else controls.push(message.type);
			});
		});
		try {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByRole("button", { name: "Open Relay", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			const frame = page.frameLocator('iframe[title="Server4 Relay voice"]');
			await expect.poll(() => frame.locator("body").getAttribute("data-ready")).toBe("yes");
			expect(await dialog.evaluate((node) => document.activeElement === node)).toBe(true);
			await frame
				.locator("body")
				.evaluate(() =>
					parent.postMessage({ source: "lfm-relay", type: "refresh" }, location.origin),
				);
			await expect
				.poll(() =>
					frame
						.locator("body")
						.evaluate(() => (window as any).received.at(-1)?.config?.instructions),
				)
				.toBe("Refreshed");
			await page.evaluate(() =>
				window.postMessage(
					{ source: "lfm-relay", type: "relay_request", id: "forged" },
					location.origin,
				),
			);
			await frame.locator("body").evaluate(() => {
				parent.postMessage(
					{
						source: "lfm-relay",
						type: "relay_context",
						id: "voice-one",
						text: "Inspect the fixture.",
					},
					location.origin,
				);
				parent.postMessage(
					{ source: "lfm-relay", type: "relay_request", id: "voice-one" },
					location.origin,
				);
			});
			await expect
				.poll(() => dialog.getByRole("log").innerText())
				.toContain("The fixture says amber");
			await expect
				.poll(() =>
					frame
						.locator("body")
						.evaluate(
							() => (window as any).received.filter((m: any) => m.type === "result").length,
						),
				)
				.toBe(1);
			expect(prompts.some((p) => p.includes("forged"))).toBe(false);
			expect(prompts.filter((p) => p.startsWith("/relay voice-request "))).toHaveLength(1);
			await dialog.getByRole("button", { name: "Interrupt", exact: true }).click();
			await expect
				.poll(() =>
					frame
						.locator("body")
						.evaluate(() => (window as any).received.some((m: any) => m.type === "interrupt")),
				)
				.toBe(true);
			expect(controls).not.toContain("abort");
			expect(ttsCalls).toBe(0);
			await dialog.getByRole("button", { name: "Stop current Pi turn", exact: true }).click();
			await expect.poll(() => controls).toEqual(["abort"]);
			expect(await dialog.locator(".voice-test-status").innerText()).toContain(
				"Explicit stop requested for the current Pi turn",
			);
			await dialog.getByRole("button", { name: "Close Relay", exact: true }).click();
			await page.getByRole("button", { name: "Open Relay", exact: true }).click();
			await expect.poll(() => inits.length).toBe(2);
			expect(inits[1].sessionId).toBe("local-relay-session");
			expect(prompts.filter((p) => p.startsWith("/relay voice-request "))).toHaveLength(1);
			await page.getByRole("button", { name: "Use legacy STT/Kokoro", exact: true }).click();
			await expect.poll(() => inits.length).toBe(3);
			expect(await page.locator(".relay-local-voice").count()).toBe(0);
			expect(await page.getByRole("button", { name: "Stop current Pi turn" }).count()).toBe(0);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-voice-engine"))).toBe(
				"legacy",
			);
			expect(prompts).not.toContain("/relay cancel");
			await page.getByRole("button", { name: "Close Relay", exact: true }).click();
		} finally {
			await page.close();
		}
	});

	it("exposes Pi + LFM TTS (speech-only) in regular Relay without migrating saved sessions or overflowing mobile", async () => {
		const { page } = await openPage("/");
		const inits: Array<Record<string, unknown>> = [],
			prompts: string[] = [],
			ttsWs: Array<Record<string, unknown>> = [];
		await page.evaluate(() => {
			localStorage.setItem("acb-relay-session", "saved-relay-session");
			localStorage.setItem("acb-relay-voice-engine", "server4");
		});
		await page.route("**/experiments/lfm-voice/**", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><body>Server4 bridge fixture</body>",
			}),
		);
		await page.routeWebSocket(/\/experiments\/lfm-voice\/ws\?tts=1$/, (ws) => {
			ws.send(
				JSON.stringify({
					type: "ready",
					protocol: 3,
					tts: 1,
					outputRate: 24000,
					loadMs: 0,
				}),
			);
			ws.onMessage((raw) => {
				const m = JSON.parse(String(raw)) as Record<string, unknown>;
				ttsWs.push(m);
				if (m.type === "speak") {
					const epoch = Number(m.epoch);
					const buf = Buffer.alloc(4 + 4800 * 2);
					buf.writeUInt32BE(epoch, 0);
					ws.send(JSON.stringify({ type: "first_pcm", epoch, seq: m.seq, ttsFirstPcmMs: 52 }));
					ws.send(buf);
				} else if (m.type === "end") {
					ws.send(
						JSON.stringify({
							type: "utterance_done",
							epoch: m.epoch,
							utterance: m.utterance,
							truncated: false,
						}),
					);
				} else if (m.type === "played") {
					ws.send(
						JSON.stringify({
							type: "played_prefix",
							epoch: m.epoch,
							utterance: m.utterance,
							playedMs: m.played_ms,
							text: "Ready on mobile.",
							complete: true,
							uncertain: false,
						}),
					);
				}
			});
		});
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			const native = (event: object) => ws.send(JSON.stringify({ type: "event", event }));
			const custom = (details: object) =>
				native({
					type: "message_end",
					message: { role: "custom", customType: "acb-relay", details },
				});
			ws.onMessage((raw) => {
				const m = JSON.parse(String(raw));
				if (m.type === "init") {
					inits.push(m);
					ws.send(JSON.stringify({ type: "ready", sessionId: m.sessionId ?? "fresh" }));
					if (m.sessionId) {
						ws.send(
							JSON.stringify({
								type: "transcript",
								messages: [{ role: "assistant", content: "**Saved history** stays silent." }],
							}),
						);
					}
				} else if (m.type === "getCapabilities") {
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "relay" }] }));
				} else if (m.type === "prompt") {
					prompts.push(m.text);
					if (m.text.startsWith("/relay start")) {
						custom({
							kind: "ready",
							model: "venice/deepseek-v4-1-flash-1017",
							workerModel: { provider: "venice", modelId: "fixture", thinkingLevel: "off" },
							voice: { protocol: 1, instructions: "Fixture", tools: [] },
						});
					} else if (m.text.startsWith("/relay voice-request ")) {
						native({ type: "message_end", message: { role: "user", content: "Ping" } });
						native({ type: "message_start", message: { role: "assistant" } });
						native({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", delta: "**Ready on mobile.**" },
						});
						native({
							type: "message_end",
							message: { role: "assistant", content: "**Ready on mobile.**" },
						});
					}
				}
			});
		});
		try {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByRole("button", { name: "Open Relay", exact: true }).click();
			let dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect.poll(() => inits.length).toBe(1);
			// Default saved "server4" preference is respected, not silently migrated:
			expect(await dialog.locator('iframe[title="Server4 Relay voice"]').count()).toBe(1);
			expect(ttsWs).toHaveLength(0);

			// Explicitly choose Pi + LFM TTS (speech-only); saved session ID is preserved, history is not spoken:
			await dialog
				.getByRole("button", { name: "Use Pi + LFM TTS (speech-only)", exact: true })
				.click();
			dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect.poll(() => inits.length).toBe(2);
			expect(inits[1].sessionId).toBe("saved-relay-session");
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-voice-engine"))).toBe(
				"lfm-tts",
			);
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			expect(await dialog.locator("iframe").count()).toBe(0);
			expect(ttsWs).toHaveLength(0); // Saved history is never replayed to Server4 TTS!
			expect(
				await dialog
					.getByRole("button", { name: "Use Server4 LFM voice", exact: true })
					.isVisible(),
			).toBe(true);
			expect(
				await dialog
					.getByRole("button", { name: "Use legacy STT/Kokoro", exact: true })
					.isVisible(),
			).toBe(true);
			expect(
				await dialog.getByRole("button", { name: "Stop current Pi turn", exact: true }).isVisible(),
			).toBe(true);
			const noOverflow = await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
			expect(noOverflow).toBe(true);

			await dialog.getByRole("textbox", { name: "Relay message" }).fill("Ping");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();
			await expect.poll(() => ttsWs.some((m) => m.type === "speak")).toBe(true);
			expect(ttsWs.find((m) => m.type === "speak")?.text).toBe("Ready on mobile.");
			await expect
				.poll(() =>
					prompts.some((p) => {
						if (!p.startsWith("/relay voice-heard ")) return false;
						const decoded = JSON.parse(Buffer.from(p.split(" ")[3], "base64url").toString()).text;
						return decoded.includes("playback completed") && decoded.includes("Ready on mobile.");
					}),
				)
				.toBe(true);
			await dialog.getByRole("button", { name: "Close Relay", exact: true }).click();
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

	it("retains all paused speech and does not cancel ASR when only speech output is interrupted", async () => {
		// Deterministic VAD onsets + delayed ASR exercise the actual UI input race.
		// This fixture is test-bundle-only; the existing smoke also starts real Silero.
		const vadFixture = join(tmp, "synthetic-vad.ts");
		writeFileSync(
			vadFixture,
			`
			export const MicVAD = { new: async (options) => {
				window.__inputRaceVad = options;
				return { start: async () => {}, destroy: async () => {} };
			}};
			export const utils = { encodeWAV: (samples) =>
				new TextEncoder().encode(JSON.stringify(Array.from(samples))).buffer };
		`,
		);
		const synthetic = await bundleClient(vadFixture);
		const { page } = await openPage("/", synthetic.js);
		const requests: Route[] = [];
		const contexts: string[] = [];
		const controls: string[] = [];
		await page.route("**/api/transcribe", (route) => {
			requests.push(route);
		});
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			const custom = (details: object) =>
				ws.send(
					JSON.stringify({
						type: "event",
						event: {
							type: "message_end",
							message: { role: "custom", customType: "acb-relay", details },
						},
					}),
				);
			ws.onMessage((raw) => {
				const m = JSON.parse(String(raw));
				if (m.type === "init")
					ws.send(JSON.stringify({ type: "ready", sessionId: "paused-speech-test" }));
				else if (m.type === "getCapabilities")
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "relay" }] }));
				else if (m.type === "abort") controls.push("abort");
				else if (m.type === "prompt") {
					controls.push(m.text);
					if (m.text.startsWith("/relay start"))
						custom({
							kind: "ready",
							model: "fixture",
							workerModel: { provider: "venice", modelId: "fixture", thinkingLevel: "off" },
						});
					const [, action, id, encoded] = m.text.split(" ");
					if (action === "voice-context") {
						const text = JSON.parse(Buffer.from(encoded, "base64url").toString()).text;
						contexts.push(text);
						custom({ kind: "voice_context", id, user: text });
					}
				}
			});
		});
		const onset = () =>
			page.evaluate(() => {
				const vad = (
					window as unknown as {
						__inputRaceVad: { onSpeechStart(): void; onSpeechRealStart(): void };
					}
				).__inputRaceVad;
				vad.onSpeechStart();
				vad.onSpeechRealStart();
			});
		const end = (samples: number[]) =>
			page.evaluate((data) => {
				(
					window as unknown as { __inputRaceVad: { onSpeechEnd(audio: Float32Array): void } }
				).__inputRaceVad.onSpeechEnd(Float32Array.from(data));
			}, samples);
		const answer = async (index: number, text: string) => {
			const response = page.waitForResponse((r) => r.url().endsWith("/api/transcribe"));
			await requests[index].fulfill({ json: { text } });
			await response;
			await page.evaluate(
				() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
			);
		};
		try {
			await send(page, "/relaytrial");
			const dialog = page.getByRole("dialog", { name: "Trial A — streaming Pi voice" });
			await expect.poll(() => dialog.locator(".voice-test-status").innerText()).toContain("Ready");
			await page.evaluate(() =>
				Object.defineProperty(navigator, "mediaDevices", {
					configurable: true,
					value: {
						getUserMedia: async () => ({ getTracks: () => [{ stop() {}, addEventListener() {} }] }),
					},
				}),
			);
			await page.clock.install();
			await dialog.getByRole("button", { name: "Start microphone", exact: true }).click();
			await onset();
			await page.clock.fastForward(31_000);
			expect(await dialog.getByRole("button", { name: "Stop microphone", exact: true }).isVisible()).toBe(
				true,
			);
			await end([0.125, 0.25]);
			await expect.poll(() => requests.length).toBe(1);
			await onset(); // resumed before recognition of the beginning finishes
			await answer(0, "First sentence.");
			expect(contexts).toEqual([]);
			await end([0.375]); // filler
			await expect.poll(() => requests.length).toBe(2);
			expect(
				requests[1].request().postDataBuffer()!.includes(Buffer.from("[0.125,0.25,0.375]")),
			).toBe(true);
			await onset();
			await answer(1, "First sentence, um.");
			expect(contexts).toEqual([]);
			await end([0.5]);
			await expect.poll(() => requests.length).toBe(3);
			expect(
				requests[2].request().postDataBuffer()!.includes(Buffer.from("[0.125,0.25,0.375,0.5]")),
			).toBe(true);
			await dialog.getByRole("button", { name: "Interrupt", exact: true }).click();
			await answer(2, "First sentence, um, final sentence.");
			await expect.poll(() => contexts).toEqual(["First sentence, um, final sentence."]);
			expect(controls.filter((s) => s.startsWith("/relay voice-request "))).toHaveLength(1);
			expect(controls).not.toContain("abort");
			await dialog
				.getByRole("button", { name: "Close voice — keep work running", exact: true })
				.click();
		} finally {
			await page.close();
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
