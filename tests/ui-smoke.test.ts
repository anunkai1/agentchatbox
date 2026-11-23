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
	reasoning: true,
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
      echo "$line" | jq -c '{type:"response",command:"prompt",success:true,id:.id,data:{disposition:"started"}}'
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
    "steer")
      echo "$line" | jq -c '{type:"response",command:"steer",success:true,id:.id,data:{disposition:"queued"}}'
      ;;
    "set_model")
      echo "$line" | jq -c '{type:"response",command:"set_model",success:true,data:{provider:.provider,id:.modelId}}'
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

function zonosSpeechFixture(text: string, samples = 8820) {
	const frame = (type: number, payload: Buffer) => {
		const header = Buffer.alloc(5);
		header[0] = type;
		header.writeUInt32LE(payload.length, 1);
		return Buffer.concat([header, payload]);
	};
	const tokens = text.split(" ");
	const step = Math.floor(samples / tokens.length);
	const words = tokens.map((word, i) => ({
		text: word,
		whitespace: i < tokens.length - 1 ? " " : "",
		startSample: i * step,
		endSample: (i + 1) * step,
	}));
	const meta = {
		alignment: "zonos3-probe-v1",
		sampleRate: 44100,
		submittedText: text,
		text,
		startSample: 0,
		endSample: samples,
		alignmentComplete: true,
		unalignedTokens: [],
		words,
	};
	return {
		headers: { "X-Zonos-Alignment": "zonos3-probe-v1" },
		body: Buffer.concat([
			frame(2, Buffer.from(JSON.stringify(meta))),
			frame(1, Buffer.alloc(samples * 2)),
			frame(0, Buffer.alloc(0)),
		]),
	};
}

// Keep the existing speech fixtures while exercising the new single-socket
// view-open protocol. The initial socket belongs to the source chat; subsequent
// view changes are asserted non-destructive and handed to each fixture's setup.
async function relayChatFixture(
	page: Page,
	configure: (ws: Pick<WebSocketRoute, "send" | "onMessage">) => void,
	allowReconnect = false,
): Promise<void> {
	let connections = 0;
	await page.routeWebSocket(/\/api\/chat$/, (socket) => {
		connections++;
		if (!allowReconnect) expect(connections).toBe(1); // Reopening the drawer reuses one socket.
		let userStarted = false;
		let sessionId = "relay-source-chat";
		let freshViews = 0;
		let freshView = false;
		configure({
			send(data) {
				const wire = JSON.parse(String(data));
				if (wire.type === "ready") {
					if (freshView && freshViews > 1) wire.sessionId += `-fresh-${freshViews}`;
					sessionId = wire.sessionId;
				}
				if (wire.type === "transcript") wire.sessionId ??= sessionId;
				if (wire.type === "ready")
					Object.assign(wire, {
						provider: "venice",
						modelId: "deepseek-v4-1-flash-1017",
						thinkingLevel: "off",
					});
				for (const saved of wire.messages ?? []) {
					if (typeof saved.content === "string" && ["user", "assistant"].includes(saved.role))
						saved.content = [{ type: "text", text: saved.content }];
				}
				const message = wire.event?.message;
				if (message && ["user", "assistant"].includes(message.role)) {
					if (typeof message.content === "string")
						message.content = [{ type: "text", text: message.content }];
					else message.content ??= [];
					if (wire.event.type === "message_start" && message.role === "user") userStarted = true;
					if (wire.event.type === "message_end" && message.role === "user") {
						if (!userStarted)
							socket.send(
								JSON.stringify({ type: "event", event: { type: "message_start", message } }),
							);
						userStarted = false;
					}
				}
				socket.send(JSON.stringify(wire));
			},
			onMessage(listener) {
				socket.onMessage((raw) => {
					const message = JSON.parse(String(raw));
					if ((message.type === "prompt" || message.type === "steer") && message.requestId) {
						socket.send(
							JSON.stringify({ type: "sendResult", requestId: message.requestId, accepted: true }),
						);
					}
					if (message.type === "init") {
						socket.send(
							JSON.stringify({
								type: "ready",
								sessionId: "relay-source-chat",
								provider: "zai",
								modelId: "glm-5.2",
								thinkingLevel: "off",
							}),
						);
					} else if (message.type === "newSession" || message.type === "resumeSession") {
						expect(message.preservePrevious).toBe(true);
						freshView = message.type === "newSession";
						if (freshView) freshViews++;
						listener(
							JSON.stringify({
								type: "init",
								...(message.sessionId ? { sessionId: message.sessionId } : {}),
							}),
						);
					} else listener(raw);
				});
			},
		});
	});
	await page.reload();
	await expect.poll(() => new URL(page.url()).pathname).toBe("/s/relay-source-chat");
}

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

	it("sends a prompt when crypto.randomUUID is unavailable as on plain HTTP", async () => {
		const { page } = await openPage(
			"/",
			`Object.defineProperty(crypto, "randomUUID", { value: undefined });\n${client.js}`,
		);
		try {
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/live-session-001");
			await send(page, "plain HTTP fallback");
			await expect.poll(() => messages(page).innerText()).toContain("reply 1");
			expect(lastPrompt()).toMatchObject({ message: "plain HTTP fallback" });
		} finally {
			await page.close();
		}
	});

	it.each([
		["normally", null],
		["when another tab replaces the unbound key", "Another tab's draft"],
	])("binds a draft typed while a new session connects %s", async (_case, replacement) => {
		const { page } = await openPage("/");
		let socket: WebSocketRoute | undefined;
		const prompts: string[] = [];
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			socket = ws;
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "prompt") {
					prompts.push(message.text);
					ws.send(
						JSON.stringify({ type: "sendResult", requestId: message.requestId, accepted: true }),
					);
				}
			});
		});
		try {
			await page.goto(`${base}/`);
			await expect.poll(() => Boolean(socket)).toBe(true);
			await page.locator("#input").fill("Written before ready");
			expect(await page.evaluate(() => sessionStorage.getItem("acb-draft-v1:new"))).toBe(
				"Written before ready",
			);
			if (replacement) {
				await page.evaluate((text) => localStorage.setItem("acb-draft-v1:new", text), replacement);
			}
			socket!.send(
				JSON.stringify({
					type: "ready",
					sessionId: "new-draft-session",
					provider: "zai",
					modelId: "glm-5.2",
					thinkingLevel: "off",
				}),
			);
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/new-draft-session");
			expect(await page.locator("#input").inputValue()).toBe("Written before ready");
			expect(
				await page.evaluate(() => localStorage.getItem("acb-draft-v1:new-draft-session")),
			).toBe("Written before ready");
			expect(await page.evaluate(() => localStorage.getItem("acb-draft-v1:new"))).toBe(replacement);
			expect(await page.evaluate(() => sessionStorage.getItem("acb-draft-v1:new"))).toBeNull();
			// Transcript replay rebuilds the composer; the bound draft must survive it.
			socket!.send(
				JSON.stringify({
					type: "transcript",
					sessionId: "new-draft-session",
					messages: [
						{ role: "user", content: [{ type: "text", text: "Earlier message" }], timestamp: 1 },
					],
				}),
			);
			await expect.poll(() => messages(page).innerText()).toContain("Earlier message");
			expect(await page.locator("#input").inputValue()).toBe("Written before ready");
			await page.locator("#send-btn").click();
			await expect.poll(() => prompts).toEqual(["Written before ready"]);
			await expect
				.poll(() => page.evaluate(() => localStorage.getItem("acb-draft-v1:new-draft-session")))
				.toBeNull();
			expect(await page.evaluate(() => localStorage.getItem("acb-draft-v1:new"))).toBe(replacement);
		} finally {
			await page.close();
		}
	});

	it("keeps the text and attachment when a move rejects an unconfirmed send", async () => {
		const { page } = await openPage("/");
		let socket: WebSocketRoute | undefined;
		const sent: Array<{ requestId: string; text: string }> = [];
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			socket = ws;
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init")
					ws.send(
						JSON.stringify({
							type: "ready",
							sessionId: "ack-draft-session",
							provider: "zai",
							modelId: "glm-5.2",
							thinkingLevel: "off",
						}),
					);
				if (message.type === "prompt" || message.type === "steer") sent.push(message);
			});
		});
		try {
			await page.goto(`${base}/`);
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/ack-draft-session");
			await page.locator("#input").fill("Keep this draft");
			await page.locator("#file-input").setInputFiles({
				name: "keep.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("content"),
			});
			await page.getByRole("button", { name: "Remove keep.txt", exact: true }).waitFor();
			await page.locator("#send-btn").click();
			await expect.poll(() => sent.length).toBe(1);
			expect(await page.locator("#input").inputValue()).toBe("Keep this draft");
			expect(await page.locator("#input").isDisabled()).toBe(true);
			expect(
				await page.evaluate(() => localStorage.getItem("acb-draft-v1:ack-draft-session")),
			).toBe("Keep this draft");
			socket!.send(
				JSON.stringify({
					type: "sendResult",
					requestId: sent[0].requestId,
					accepted: false,
					message: "session is switching",
				}),
			);
			await expect.poll(() => page.locator("#input").isDisabled()).toBe(false);
			expect(await page.locator("#input").inputValue()).toBe("Keep this draft");
			expect(await page.getByRole("button", { name: "Remove keep.txt", exact: true }).count()).toBe(
				1,
			);
			socket!.send(JSON.stringify({ type: "sessionMoving", sessionId: "ack-draft-session" }));
			await expect.poll(() => page.locator("#input").isDisabled()).toBe(true);
			expect(await page.locator("#input").inputValue()).toBe("Keep this draft");
			socket!.send(
				JSON.stringify({
					type: "ready",
					sessionId: "ack-draft-session",
					provider: "zai",
					modelId: "glm-5.2",
					thinkingLevel: "off",
				}),
			);
			await expect.poll(() => page.locator("#input").isDisabled()).toBe(false);
			expect(await page.getByRole("button", { name: "Remove keep.txt", exact: true }).count()).toBe(
				1,
			);
			await page.locator("#send-btn").click();
			await expect.poll(() => sent.length).toBe(2);
			expect(sent[1].text).toContain("[file: keep.txt]");
			socket!.send(
				JSON.stringify({ type: "sendResult", requestId: sent[1].requestId, accepted: true }),
			);
			await expect.poll(() => page.locator("#input").inputValue()).toBe("");
			expect(await page.locator("#attachment-previews .attachment-preview").count()).toBe(0);
			socket!.send(JSON.stringify({ type: "event", event: { type: "agent_start" } }));
			await expect
				.poll(() => page.locator("#send-btn").getAttribute("aria-label"))
				.toBe("Queue instruction");
			await page.locator("#input").fill("Change direction");
			await page.locator("#send-btn").click();
			await expect.poll(() => sent.length).toBe(3);
			socket!.send(
				JSON.stringify({
					type: "event",
					event: { type: "queue_update", steering: ["Change direction"] },
				}),
			);
			socket!.send(
				JSON.stringify({ type: "sendResult", requestId: sent[2].requestId, accepted: true }),
			);
			await expect.poll(() => page.locator(".row-steer").count()).toBe(1);
			expect(await page.locator("#status-dynamic").innerText()).toContain("1 queued");
			await page.locator("#input").fill("Possibly delivered");
			await page.locator("#send-btn").click();
			await expect.poll(() => sent.length).toBe(4);
			await socket!.close({ code: 1001, reason: "lost acknowledgement" });
			await expect.poll(() => page.locator("#input").isDisabled()).toBe(false);
			expect(await page.locator("#input").inputValue()).toBe("Possibly delivered");
			await expect
				.poll(() => page.locator("body").innerText())
				.toContain("check the chat before retrying");
			expect(sent).toHaveLength(4);
		} finally {
			await page.close();
		}
	});

	it("does not move an unbound new-chat draft into an existing conversation", async () => {
		const { page } = await openPage("/");
		try {
			await page.evaluate(() => {
				localStorage.setItem("acb-draft-v1:new", "Unbound draft");
				sessionStorage.setItem("acb-draft-v1:new", "This tab's unbound draft");
			});
			await page.goto(`${base}/s/${SEEDED_ID}`);
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			expect(await page.locator("#input").inputValue()).toBe("");
			expect(await page.evaluate(() => localStorage.getItem("acb-draft-v1:new"))).toBe(
				"Unbound draft",
			);
			expect(
				await page.evaluate((id) => localStorage.getItem(`acb-draft-v1:${id}`), SEEDED_ID),
			).toBeNull();
			await page.locator("#input").fill("This session's own draft");
			await page.reload();
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			expect(await page.locator("#input").inputValue()).toBe("This session's own draft");
			expect(await page.evaluate(() => localStorage.getItem("acb-draft-v1:new"))).toBe(
				"Unbound draft",
			);
			expect(await page.evaluate(() => sessionStorage.getItem("acb-draft-v1:new"))).toBe(
				"This tab's unbound draft",
			);
			await page.locator(".new-chat-btn").click();
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/live-session-001");
			expect(await page.locator("#input").inputValue()).toBe("This tab's unbound draft");
			expect(
				await page.evaluate((id) => localStorage.getItem(`acb-draft-v1:${id}`), SEEDED_ID),
			).toBe("This session's own draft");
			expect(await page.evaluate(() => sessionStorage.getItem("acb-draft-v1:new"))).toBeNull();
		} finally {
			await page.close();
		}
	});

	it("does not let another chat's replay change the session selected on reconnect", async () => {
		const { page } = await openPage("/");
		const inits: string[] = [];
		let socket: WebSocketRoute | undefined;
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type !== "init") return;
				inits.push(message.sessionId);
				socket = ws;
				ws.send(
					JSON.stringify({
						type: "ready",
						sessionId: SEEDED_ID,
						provider: "zai",
						modelId: "glm-5.2",
						thinkingLevel: "off",
					}),
				);
			});
		});
		try {
			await page.goto(`${base}/s/${SEEDED_ID}`);
			await expect.poll(() => inits).toEqual([SEEDED_ID]);
			const replay = (sessionId: string, text: string) =>
				socket!.send(
					JSON.stringify({
						type: "transcript",
						sessionId,
						messages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
					}),
				);
			replay(SEEDED_ID, "Correct chat history");
			await expect.poll(() => messages(page).innerText()).toContain("Correct chat history");
			await page.locator("#input").fill("Keep this draft in this chat");
			replay("unrelated-session", "Wrong chat history");
			await socket!.close({ code: 1001 });
			await expect.poll(() => inits).toEqual([SEEDED_ID, SEEDED_ID]);
			expect(await messages(page).innerText()).toContain("Correct chat history");
			expect(await messages(page).innerText()).not.toContain("Wrong chat history");
			expect(await page.locator("#input").inputValue()).toBe("Keep this draft in this chat");
			expect(new URL(page.url()).pathname).toBe(`/s/${SEEDED_ID}`);
		} finally {
			await page.close();
		}
	});

	it("opens an ask link as a new-session draft without submitting it", async () => {
		const question = "Tell me more about this";
		const { page } = await openPage(`/?ask=${encodeURIComponent(question)}`);
		try {
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/live-session-001");
			expect(await page.locator("#input").inputValue()).toBe(question);
			expect(await page.locator(".row-user").count()).toBe(0);
			expect(await page.evaluate(() => localStorage.getItem("acb-draft-v1:new"))).toBeNull();
			expect(await page.evaluate(() => localStorage.getItem("acb-draft-v1:live-session-001"))).toBe(
				question,
			);
		} finally {
			await page.close();
		}
	});

	it("keeps new-tab drafts private to each tab and restores an unbound draft after reload", async () => {
		const context = await browser!.newContext();
		const first = await context.newPage();
		const second = await context.newPage();
		let firstSocket: WebSocketRoute | undefined;
		let secondSocket: WebSocketRoute | undefined;
		await context.route(
			(url) => url.origin === base && !url.pathname.startsWith("/api/"),
			(route) => {
				const pathname = new URL(route.request().url()).pathname;
				if (pathname === "/app.js")
					return route.fulfill({ body: client.js, contentType: "text/javascript" });
				if (pathname === "/styles.css")
					return route.fulfill({ body: client.css, contentType: "text/css" });
				if (pathname === "/" || pathname.startsWith("/s/"))
					return route.fulfill({ body: client.html, contentType: "text/html" });
				return route.fulfill({ status: 404, body: "" });
			},
		);
		await first.routeWebSocket(/\/api\/chat$/, (ws) => {
			firstSocket = ws;
			ws.onMessage(() => {});
		});
		await second.routeWebSocket(/\/api\/chat$/, (ws) => {
			secondSocket = ws;
			ws.onMessage(() => {});
		});
		try {
			await first.goto(`${base}/`);
			await second.goto(`${base}/`);
			await expect.poll(() => Boolean(firstSocket && secondSocket)).toBe(true);
			await second.locator("#input").fill("Second tab only");
			firstSocket!.send(
				JSON.stringify({
					type: "ready",
					sessionId: "first-tab-session",
					modelId: "glm-5.2",
					provider: "zai",
					thinkingLevel: "off",
				}),
			);
			await expect.poll(() => new URL(first.url()).pathname).toBe("/s/first-tab-session");
			expect(await first.locator("#input").inputValue()).toBe("");
			expect(
				await first.evaluate(() => localStorage.getItem("acb-draft-v1:first-tab-session")),
			).toBeNull();
			await second.reload();
			await expect.poll(() => second.locator("#input").inputValue()).toBe("Second tab only");
			secondSocket!.send(
				JSON.stringify({
					type: "ready",
					sessionId: "second-tab-session",
					modelId: "glm-5.2",
					provider: "zai",
					thinkingLevel: "off",
				}),
			);
			await expect.poll(() => new URL(second.url()).pathname).toBe("/s/second-tab-session");
			expect(
				await second.evaluate(() => localStorage.getItem("acb-draft-v1:second-tab-session")),
			).toBe("Second tab only");
		} finally {
			await context.close();
		}
	});

	it("offers a legacy unbound draft without moving it or overwriting a current draft", async () => {
		const { page } = await openPage("/");
		let socket: WebSocketRoute | undefined;
		const prompts: string[] = [];
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			socket = ws;
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "prompt") prompts.push(message.text);
			});
		});
		try {
			await page.evaluate(() => localStorage.setItem("acb-draft-v1:new", "Old recoverable draft"));
			await page.goto(`${base}/`);
			await expect.poll(() => Boolean(socket)).toBe(true);
			socket!.send(
				JSON.stringify({
					type: "ready",
					sessionId: "legacy-recovery-session",
					modelId: "glm-5.2",
					provider: "zai",
					thinkingLevel: "off",
				}),
			);
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/legacy-recovery-session");
			expect(await page.locator("#input").inputValue()).toBe("");
			const recover = page.getByRole("button", { name: "Recover old draft", exact: true });
			await recover.waitFor();
			await page.locator("#input").fill("Current draft");
			await recover.click();
			expect(await page.locator("#input").inputValue()).toBe("Current draft");
			await page.locator("#input").fill("");
			await recover.click();
			expect(await page.locator("#input").inputValue()).toBe("Old recoverable draft");
			expect(await page.evaluate(() => localStorage.getItem("acb-draft-v1:new"))).toBe(
				"Old recoverable draft",
			);
			expect(
				await page.evaluate(() => localStorage.getItem("acb-draft-v1:legacy-recovery-session")),
			).toBe("Old recoverable draft");
			expect(prompts).toEqual([]);
		} finally {
			await page.close();
		}
	});

	it.each([
		"success",
		"failure",
	])("keeps the old draft and blocks submission while a new chat opens (%s)", async (outcome) => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		let socket: WebSocketRoute | undefined;
		const prompts: string[] = [];
		let newRequests = 0;
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			socket = ws;
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init") {
					ws.send(
						JSON.stringify({
							type: "ready",
							sessionId: SEEDED_ID,
							modelId: "glm-5.2",
							provider: "zai",
							thinkingLevel: "off",
						}),
					);
					ws.send(
						JSON.stringify({
							type: "transcript",
							sessionId: SEEDED_ID,
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: "Previous conversation" }],
									timestamp: 1,
								},
							],
						}),
					);
				} else if (message.type === "newSession") newRequests++;
				else if (message.type === "prompt") prompts.push(message.text);
			});
		});
		try {
			await page.reload();
			await expect.poll(() => messages(page).innerText()).toContain("Previous conversation");
			await page.locator("#input").fill("Old unsent draft");
			await page.locator(".new-chat-btn").click();
			await expect.poll(() => newRequests).toBe(1);
			expect(await page.locator("#input").isDisabled()).toBe(true);
			expect(await page.locator("#input").inputValue()).toBe("Old unsent draft");
			await page.locator("#send-btn").dispatchEvent("click");
			expect(prompts).toEqual([]);
			const dropped = await page.evaluate(() => {
				const data = new DataTransfer();
				data.items.add(new File(["fixture"], "during-switch.txt", { type: "text/plain" }));
				const event = new DragEvent("drop", {
					bubbles: true,
					cancelable: true,
					dataTransfer: data,
				});
				document.querySelector("#input")!.dispatchEvent(event);
				return {
					prevented: event.defaultPrevented,
					previews: document.querySelectorAll("#attachment-previews .attachment-preview").length,
				};
			});
			expect(dropped).toEqual({ prevented: true, previews: 0 });
			expect(
				await page.evaluate((id) => localStorage.getItem(`acb-draft-v1:${id}`), SEEDED_ID),
			).toBe("Old unsent draft");
			// An unrelated error from the old child must not unlock the composer.
			for (const message of [
				"unrelated old-session error",
				"a session switch is already in progress",
			]) {
				socket!.send(JSON.stringify({ type: "error", message }));
				await expect.poll(() => messages(page).innerText()).toContain(message);
				expect(await page.locator("#input").isDisabled()).toBe(true);
			}
			if (outcome === "failure") {
				socket!.send(
					JSON.stringify({
						type: "error",
						message: "could not switch session; current session is still active: test failure",
					}),
				);
				await expect.poll(() => page.locator("#input").isEnabled()).toBe(true);
				expect(await page.locator("#input").inputValue()).toBe("Old unsent draft");
				expect(await messages(page).innerText()).toContain("Previous conversation");
				await page.locator("#send-btn").click();
				await expect.poll(() => prompts).toEqual(["Old unsent draft"]);
			} else {
				socket!.send(
					JSON.stringify({
						type: "ready",
						sessionId: "next-session",
						modelId: "glm-5.2",
						provider: "zai",
						thinkingLevel: "off",
					}),
				);
				await expect.poll(() => new URL(page.url()).pathname).toBe("/s/next-session");
				expect(await page.locator("#input").isEnabled()).toBe(true);
				expect(await page.locator("#input").inputValue()).toBe("");
				expect(
					await page.evaluate((id) => localStorage.getItem(`acb-draft-v1:${id}`), SEEDED_ID),
				).toBe("Old unsent draft");
				await page.locator("#input").fill("New session draft");
				socket!.send(
					JSON.stringify({
						type: "transcript",
						sessionId: "next-session",
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: "New fixture transcript" }],
								timestamp: 1,
							},
						],
					}),
				);
				await expect.poll(() => messages(page).innerText()).toContain("New fixture transcript");
				expect(await page.locator("#input").inputValue()).toBe("New session draft");
			}
		} finally {
			await page.close();
		}
	});

	it("keeps the old view and draft while resuming an empty conversation", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		let socket: WebSocketRoute | undefined;
		const prompts: string[] = [];
		let resumeRequest = "";
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			socket = ws;
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init") {
					ws.send(
						JSON.stringify({
							type: "ready",
							sessionId: SEEDED_ID,
							modelId: "glm-5.2",
							provider: "zai",
							thinkingLevel: "off",
						}),
					);
					ws.send(
						JSON.stringify({
							type: "transcript",
							sessionId: SEEDED_ID,
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: "Previous conversation" }],
									timestamp: 1,
								},
							],
						}),
					);
				} else if (message.type === "listSessions") {
					ws.send(
						JSON.stringify({
							type: "sessions",
							sessions: [
								{
									id: "empty-target",
									cwd: join(tmp, "cwd"),
									title: "Empty target",
									createdAt: "2026-01-01T00:00:00Z",
									modifiedAt: "2026-01-01T00:00:00Z",
									messageCount: 0,
								},
							],
						}),
					);
				} else if (message.type === "resumeSession") resumeRequest = message.sessionId;
				else if (message.type === "prompt") prompts.push(message.text);
			});
		});
		try {
			await page.reload();
			await expect.poll(() => messages(page).innerText()).toContain("Previous conversation");
			await page.locator("#input").fill("Old draft during resume");
			await page.locator('a[href="/s/empty-target"]').click();
			await expect.poll(() => resumeRequest).toBe("empty-target");
			expect(await page.locator("#input").isDisabled()).toBe(true);
			expect(await messages(page).innerText()).toContain("Previous conversation");
			await page.locator("#send-btn").dispatchEvent("click");
			expect(prompts).toEqual([]);
			socket!.send(
				JSON.stringify({
					type: "ready",
					sessionId: "empty-target",
					modelId: "glm-5.2",
					provider: "zai",
					thinkingLevel: "off",
				}),
			);
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/empty-target");
			expect(await page.locator("#input").inputValue()).toBe("");
			expect(await messages(page).innerText()).not.toContain("Previous conversation");
			expect(
				await page.evaluate((id) => localStorage.getItem(`acb-draft-v1:${id}`), SEEDED_ID),
			).toBe("Old draft during resume");
		} finally {
			await page.close();
		}
	});

	it.each([
		"failure",
		"success",
	])("deletes the active chat only after the replacement is ready: %s", async (result) => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		let socket: WebSocketRoute | undefined;
		const sent: Array<{ type: string; sessionId?: string; preservePrevious?: boolean }> = [];
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			socket = ws;
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				sent.push(message);
				if (message.type === "init")
					ws.send(
						JSON.stringify({
							type: "ready",
							sessionId: SEEDED_ID,
							modelId: "glm-5.2",
							provider: "zai",
							thinkingLevel: "off",
						}),
					);
				else if (message.type === "listSessions")
					ws.send(
						JSON.stringify({
							type: "sessions",
							sessions: [
								{
									id: SEEDED_ID,
									cwd: join(tmp, "cwd"),
									title: "Delete source",
									createdAt: "2026-01-01T00:00:00Z",
									modifiedAt: "2026-01-01T00:00:00Z",
									messageCount: 1,
								},
							],
						}),
					);
			});
		});
		try {
			await page.reload();
			await page.locator('[aria-label="Delete Delete source"]').dispatchEvent("click");
			await page.getByRole("button", { name: "Delete permanently", exact: true }).click();
			await expect
				.poll(() => sent.find((entry) => entry.type === "newSession")?.preservePrevious)
				.toBe(true);
			expect(sent.filter((entry) => entry.type === "deleteSession")).toEqual([]);
			if (result === "failure") {
				socket!.send(
					JSON.stringify({
						type: "error",
						message: "could not switch session; current session is still active: fixture failed",
					}),
				);
				await expect.poll(() => page.locator("#input").isEnabled()).toBe(true);
				expect(new URL(page.url()).pathname).toBe(`/s/${SEEDED_ID}`);
				expect(sent.filter((entry) => entry.type === "deleteSession")).toEqual([]);
			} else {
				socket!.send(
					JSON.stringify({
						type: "ready",
						sessionId: "deletion-replacement",
						modelId: "glm-5.2",
						provider: "zai",
						thinkingLevel: "off",
					}),
				);
				await expect
					.poll(() => sent.find((entry) => entry.type === "deleteSession")?.sessionId)
					.toBe(SEEDED_ID);
			}
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

	it("hides the single-voice picker and labels TTS speech speed for ZONOS3-Mini", async () => {
		const { page } = await openPage("/");
		try {
			await page.route("**/api/health", (route) =>
				route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({
						status: "ok",
						providers: ["zai"],
						whisper: false,
						tts: true,
						ttsEngine: "zonos3",
						ttsVoice: "Savannah",
					}),
				}),
			);
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.getByRole("button", { name: "Open settings", exact: true }).click();
			await expect
				.poll(() => page.locator(".settings-row .overflow-label").allInnerTexts())
				.toContain("Speech speed");
			expect(await page.locator(".settings-row .overflow-label").allInnerTexts()).not.toContain(
				"Voice",
			);
			await page.locator(".settings-row").filter({ hasText: "Speech speed" }).click();
			const speedDialog = page.getByRole("dialog", { name: "TTS speech speed" });
			expect(await speedDialog.isVisible()).toBe(true);
			expect(await speedDialog.locator(".model-name").allInnerTexts()).toEqual([
				"1×",
				"1.25×",
				"1.4×",
			]);
			await page.getByRole("button", { name: "Close", exact: true }).click();
			await page.getByRole("button", { name: "Open settings", exact: true }).click();
			await page.locator(".settings-advanced-summary").click();
			await page.locator(".settings-row").filter({ hasText: "Models & services" }).click();
			const ttsRow = page.locator(".svc-row").filter({ hasText: "Text-to-speech" });
			expect(await ttsRow.innerText()).toContain("ZONOS3-Mini");
			expect(await ttsRow.innerText()).toContain("voice Savannah");
			expect(await ttsRow.evaluate((el) => el.classList.contains("svc-clickable"))).toBe(false);
		} finally {
			await page.close();
		}
	});

	it("surfaces Venice video model selection in Settings and Models & services via /videomodel", async () => {
		const { page } = await openPage("/");
		const sentPrompts: string[] = [];
		const selectResponses: Array<{ id: string; value?: string }> = [];
		try {
			await page.route("**/api/health", (route) =>
				route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({
						status: "ok",
						providers: ["venice"],
						whisper: false,
						tts: false,
						videoModel: { model: "minimax-h3-chili-text-to-video", source: "override" },
					}),
				}),
			);
			await page.routeWebSocket(/\/api\/chat$/, (ws) => {
				ws.onMessage((raw) => {
					const message = JSON.parse(String(raw));
					if (message.type === "init") {
						ws.send(
							JSON.stringify({
								type: "ready",
								sessionId: "video-session-001",
								provider: "zai",
								modelId: "glm-5.2",
								thinkingLevel: "off",
							}),
						);
					} else if (message.type === "getCapabilities") {
						ws.send(
							JSON.stringify({
								type: "capabilities",
								commands: [
									{ name: "videomodel", source: "extension" },
									{ name: "videogen", source: "extension" },
								],
							}),
						);
					} else if (message.type === "prompt") {
						sentPrompts.push(message.text);
						if (message.requestId) {
							ws.send(
								JSON.stringify({
									type: "sendResult",
									requestId: message.requestId,
									accepted: true,
								}),
							);
						}
						if (message.text === "/videomodel") {
							ws.send(
								JSON.stringify({
									type: "event",
									event: {
										type: "extension_ui_request",
										id: "vid-select-1",
										method: "select",
										title: "Venice video model (current: minimax-h3-chili-text-to-video)",
										options: [
											"── Venice (API, paid) ──",
											"MiniMax H3 Chili (minimax-h3-chili-text-to-video) — default · uncensored · 768P · 4s–15s — Venice",
											"Wan 2.6 (wan-2-6-text-to-video) — 720p/1080p · 5s–15s — Venice",
										],
									},
								}),
							);
						}
					} else if (message.type === "extensionUiResponse") {
						selectResponses.push({ id: message.id, value: message.value });
						ws.send(
							JSON.stringify({
								type: "event",
								event: {
									type: "extension_ui_request",
									id: "vid-notify-1",
									method: "notify",
									message: "video model set to wan-2-6-text-to-video (Venice)",
									notifyType: "info",
								},
							}),
						);
					}
				});
			});
			await page.setViewportSize({ width: 360, height: 800 });
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.getByRole("button", { name: "Open settings", exact: true }).click();
			const videoRow = page.locator(".settings-row").filter({ hasText: "Video model" });
			await expect
				.poll(() => videoRow.locator(".overflow-value").innerText())
				.toBe("minimax-h3-chili-text-to-video");
			await videoRow.click();
			await expect.poll(() => sentPrompts).toEqual(["/videomodel"]);
			const picker = page.getByRole("dialog", {
				name: "Venice video model (current: minimax-h3-chili-text-to-video)",
			});
			await expect.poll(() => picker.isVisible()).toBe(true);
			expect(await picker.locator(".ext-ui-separator").innerText()).toMatch(
				/VENICE \(API, PAID\)/i,
			);
			const firstModel = picker.locator(".model-row").first();
			expect(await firstModel.locator(".ext-ui-row-title").innerText()).toBe(
				"MiniMax H3 Chili (minimax-h3-chili-text-to-video)",
			);
			expect(await firstModel.locator(".ext-ui-row-meta").innerText()).toBe(
				"default · uncensored · 768P · 4s–15s",
			);
			expect(await firstModel.locator(".ext-ui-provider--venice").innerText()).toBe("Venice");
			const titleClipped = await firstModel
				.locator(".ext-ui-row-title")
				.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
			expect(titleClipped).toBe(false);
			await picker.locator(".model-row").filter({ hasText: "wan-2-6-text-to-video" }).click();
			await expect
				.poll(() => selectResponses)
				.toEqual([
					{
						id: "vid-select-1",
						value: "Wan 2.6 (wan-2-6-text-to-video) — 720p/1080p · 5s–15s — Venice",
					},
				]);

			await page.getByRole("button", { name: "Open settings", exact: true }).click();
			await expect
				.poll(() =>
					page
						.locator(".settings-row")
						.filter({ hasText: "Video model" })
						.locator(".overflow-value")
						.innerText(),
				)
				.toBe("wan-2-6-text-to-video");
			await page.locator(".settings-advanced-summary").click();
			await page.locator(".settings-row").filter({ hasText: "Models & services" }).click();
			const svcRow = page.locator(".svc-row").filter({ hasText: "Video generation" });
			expect(await svcRow.innerText()).toContain("wan-2-6-text-to-video");
			expect(await svcRow.evaluate((el) => el.classList.contains("svc-clickable"))).toBe(true);
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

	it("waits for recording and transcription before switching, keeping the voice draft", async () => {
		const { page } = await openPage(`/s/${SEEDED_ID}`);
		let release = () => {};
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		let transcriptions = 0;
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await mockMicrophone(page);
			await page.route("**/api/transcribe", async (route) => {
				transcriptions++;
				await ready;
				await route.fulfill({ json: { text: "Voice draft for the old chat" } });
			});
			await page.locator("#voice-btn").click();
			await page.locator(".new-chat-btn").dispatchEvent("click");
			await expect
				.poll(() => page.locator(".composer-notice-warning").innerText())
				.toContain("Finish the recording");
			expect(new URL(page.url()).pathname).toBe(`/s/${SEEDED_ID}`);
			await page.locator("#voice-btn").click();
			await expect.poll(() => transcriptions).toBe(1);
			await page.locator(".new-chat-btn").dispatchEvent("click");
			expect(new URL(page.url()).pathname).toBe(`/s/${SEEDED_ID}`);
			release();
			await expect
				.poll(() => page.locator("#input").inputValue())
				.toBe("Voice draft for the old chat");
			await expect.poll(() => page.locator(".composer-notice-warning").count()).toBe(0);
			await page.locator(".new-chat-btn").dispatchEvent("click");
			await expect.poll(() => new URL(page.url()).pathname).toBe("/s/live-session-001");
			expect(
				await page.evaluate((id) => localStorage.getItem(`acb-draft-v1:${id}`), SEEDED_ID),
			).toBe("Voice draft for the old chat");
		} finally {
			release();
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

	it("pairs parallel tools once in live view, export and transcript replay", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.getByTitle("Settings", { exact: true }).click();
			await page.getByRole("button", { name: /Tool calls/ }).click();
			await page.getByRole("button", { name: "Done", exact: true }).click();
			const socket = sockets.at(-1)!;
			const tools = [
				["bash", "grep: no match\n\nCommand exited with code 1"],
				["edit", "Could not find edits[2]. The oldText must match exactly."],
				["read", "ENOENT: no such file or directory"],
			];
			const assistant = {
				role: "assistant",
				timestamp: 3,
				stopReason: "toolUse",
				content: tools.map(([name]) => ({
					type: "toolCall",
					id: `call-${name}`,
					name,
					arguments: {},
				})),
			};
			const sendEvent = (event: Record<string, unknown>) =>
				socket.send(JSON.stringify({ type: "event", event }));
			sendEvent({ type: "message_start", message: assistant });
			sendEvent({ type: "message_end", message: assistant });
			for (const [toolName] of tools) {
				socket.send(
					JSON.stringify({
						type: "event",
						event: {
							type: "tool_execution_start",
							toolName,
							toolCallId: `call-${toolName}`,
							args: {},
						},
					}),
				);
			}
			const results = tools.toReversed().map(([toolName, text]) => ({
				role: "toolResult",
				toolCallId: `call-${toolName}`,
				toolName,
				content: [{ type: "text", text }],
				isError: true,
			}));
			for (const result of results) {
				sendEvent({ type: "message_start", message: result });
				const row = page.locator(`[data-tool-call-id="${result.toolCallId}"]`);
				await expect.poll(() => row.locator(".tool-status-error").count()).toBe(1);
				expect(await row.locator(".tool-result.tool-error").textContent()).toBe(
					result.content[0].text,
				);
				expect(await row.locator(".tool-result").isVisible()).toBe(false);
				await row.locator(".tool-head").click();
				expect(await row.locator(".tool-result").isVisible()).toBe(true);
				expect(await page.locator(".composer-notice-error").count()).toBe(0);
			}
			expect(await page.locator("#composer-notices").isVisible()).toBe(false);
			const downloaded = page.waitForEvent("download");
			await send(page, "/export");
			const html = readFileSync(await (await downloaded).path(), "utf8");
			expect(html.match(/<div class="msg tool">/g)).toHaveLength(3);
			for (const [toolName] of tools) expect(html).toContain(`${toolName} {}`);

			const textContent = (text: string) => [{ type: "text", text }];
			await messages(page).evaluate((el) => el.setAttribute("data-replay-sentinel", "keep"));
			socket.send(
				JSON.stringify({
					type: "transcript",
					sessionId: SEEDED_ID,
					messages: [
						{
							role: "user",
							timestamp: 1,
							content: textContent(`![image: photo.png](upload:${SEEDED_IMAGE})\nstored question`),
						},
						{ role: "assistant", timestamp: 2, content: textContent("stored answer") },
						assistant,
						...results,
					],
				}),
			);
			// An observable frame after the replay proves both frames were processed.
			socket.send(JSON.stringify({ type: "error", message: "received after replay" }));
			await expect.poll(() => messages(page).innerText()).toContain("received after replay");
			expect(await messages(page).getAttribute("data-replay-sentinel")).toBe("keep");
			expect(await page.locator(".row-tool").count()).toBe(3);
		} finally {
			await page.close();
		}
	});

	it("keeps command and result expansion in sync when opened during execution", async () => {
		const { page, sockets } = await openPage(`/s/${SEEDED_ID}`);
		try {
			await expect.poll(() => messages(page).innerText()).toContain("stored answer");
			await page.getByTitle("Settings", { exact: true }).click();
			await page.getByRole("button", { name: /Tool calls/ }).click();
			await page.getByRole("button", { name: "Done", exact: true }).click();
			const socket = sockets.at(-1)!;
			socket.send(
				JSON.stringify({
					type: "event",
					event: {
						type: "tool_execution_start",
						toolName: "bash",
						toolCallId: "expand-running",
						args: {
							command: "printf '%s' 'a sufficiently long command to require expansion in the card'",
						},
					},
				}),
			);
			const card = page.locator('[data-tool-call-id="expand-running"]');
			await card.locator(".tool-head").click();
			expect(await card.locator(".tool-args").isVisible()).toBe(true);
			socket.send(
				JSON.stringify({
					type: "event",
					event: {
						type: "message_start",
						message: {
							role: "toolResult",
							toolCallId: "expand-running",
							toolName: "bash",
							content: [{ type: "text", text: "completed output" }],
							isError: false,
						},
					},
				}),
			);
			await expect.poll(() => card.locator(".tool-result").count()).toBe(1);
			for (let i = 0; i < 3; i++) {
				expect(await card.locator(".tool-args").isVisible()).toBe(
					await card.locator(".tool-result").isVisible(),
				);
				await card.locator(".tool-head").click();
			}
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
		const tts: string[] = [];
		let kokoroRequests = 0;
		await page.route(/\/api\/tts\/(kokoro|relay)-stream$/, (route) => {
			kokoroRequests++;
			return route.abort();
		});
		await page.route("**/api/tts/zonos-relay-stream", (route) => {
			const { text } = route.request().postDataJSON();
			tts.push(text);
			return route.fulfill(zonosSpeechFixture(text));
		});
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
			const dialog = page.getByRole("dialog", { name: "Browser voice test" });
			await send(page, "/voicetest kokoro");
			await expect
				.poll(() => messages(page).innerText())
				.toContain("/voicetest only uses ZONOS3-Mini");
			expect(await dialog.count()).toBe(0);
			expect(voiceCommands).toEqual([]);
			await send(page, "/voicetest");
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			expect(await dialog.innerText()).toContain("DeepSeek Flash · thinking off");
			expect(await dialog.innerText()).toContain("This test cannot use tools or do work.");
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
			await dialog.getByRole("button", { name: "Voice settings & details" }).click();
			await expect
				.poll(() => dialog.locator(".voice-test-metrics").innerText())
				.toContain("scheduled playback");
			expect(tts).toEqual(["Hello from the voice model."]);
			expect(kokoroRequests).toBe(0);
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

	it.each([
		"/voicetest",
		"/relaytrial",
	])("switches an attached Relay into %s without cancelling Pi work", async (command) => {
		const { page } = await openPage("/");
		const prompts: string[] = [];
		await relayChatFixture(
			page,
			(ws) =>
				ws.onMessage((raw) => {
					const message = JSON.parse(String(raw));
					if (message.type === "init")
						ws.send(JSON.stringify({ type: "ready", sessionId: "switch-relay" }));
					if (message.type === "prompt") prompts.push(message.text);
				}),
			true,
		);
		try {
			await page.getByRole("button", { name: "Open Relay", exact: true }).click();
			await expect
				.poll(() => page.getByRole("dialog", { name: "Relay", exact: true }).count())
				.toBe(1);
			await send(page, command);
			await expect
				.poll(() => page.getByRole("dialog", { name: "Relay", exact: true }).count())
				.toBe(0);
			const title =
				command === "/voicetest" ? "Browser voice test" : "Trial A — streaming Pi voice";
			await expect
				.poll(() => page.getByRole("dialog", { name: title, exact: true }).count())
				.toBe(1);
			expect(prompts.some((text) => /^\/relay (cancel|stop)/.test(text))).toBe(false);
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

	it("resumes Relay after a legacy preference without replaying work or implicitly cancelling the job", async () => {
		const { page } = await openPage("/");
		await page.evaluate(() => localStorage.setItem("acb-relay-voice-engine", "legacy"));
		await expect.poll(() => page.locator("#model-picker").innerText()).toContain("Model");
		const inits: Array<Record<string, unknown>> = [];
		const prompts: string[] = [];
		let cancelled = false;
		let aborts = 0;
		let kokoroRequests = 0;
		await page.route("**/api/tts/zonos-relay-stream", (route) => route.abort());
		await page.route(/\/api\/tts\/(kokoro|relay)-stream$/, (route) => {
			kokoroRequests++;
			return route.abort();
		});
		await relayChatFixture(page, (ws) => {
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
						if (prompts.includes("Inspect the fixture")) job();
					} else if (message.text === "Inspect the fixture") {
						native({
							type: "message_end",
							message: { role: "user", content: message.text },
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
				} else if (message.type === "abort") aborts++;
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
			await page.locator("#input").fill("Keep my source draft");
			await relayButton.click();
			let dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect
				.poll(() => dialog.innerText())
				.toContain("Delegated work: work-model · thinking high");
			expect(new URL(page.url()).pathname).toBe("/s/relay-session-1");
			expect(await page.locator("#input").inputValue()).toBe("");
			expect(
				await page.evaluate(() =>
					Object.values(localStorage).some(
						(v) => typeof v === "string" && v.includes("Keep my source draft"),
					),
				),
			).toBe(true);
			await page.locator("#input").fill("Inspect the fixture");
			await page.locator("#send-btn").click();
			await expect
				.poll(() => messages(page).innerText())
				.toContain("The worker needs your choice.");
			expect(await dialog.locator(".relay-job").innerText()).toContain("Not live progress");
			await expect.poll(() => dialog.locator(".voice-test-status").innerText()).toMatch(/^Error:/);
			expect(kokoroRequests).toBe(0); // Failed synthesis does not fall back.
			await dialog.getByRole("button", { name: "Stop speaking", exact: true }).click();
			await dialog.getByRole("button", { name: "Close Relay", exact: true }).click();
			expect(cancelled).toBe(false);
			await send(page, "/relay");
			dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect
				.poll(() => messages(page).innerText())
				.toContain("The worker needs your choice.");
			expect(inits).toHaveLength(1); // Reopening controls does not reattach/reset the thread.
			expect(prompts.filter((p) => p === "Inspect the fixture")).toHaveLength(1);
			expect(aborts).toBe(0);
			await dialog.getByRole("button", { name: "Cancel work job", exact: true }).click();
			await expect
				.poll(() => dialog.locator(".relay-job").innerText())
				.toContain("Recorded: stopped");
			expect(cancelled).toBe(true);
			expect(await dialog.getByRole("button", { name: "New Relay conversation" }).isVisible()).toBe(
				true,
			);
			await dialog.getByRole("button", { name: "New Relay conversation" }).click();
			await expect.poll(() => inits.length).toBe(2);
			expect(inits.at(-1)?.sessionId).toBeUndefined();
			await expect
				.poll(() => page.getByRole("dialog", { name: "Relay", exact: true }).innerText())
				.toContain("Delegated work: work-model · thinking high");
			expect(new URL(page.url()).pathname).toBe("/s/relay-session-1-fresh-2");
			const beforeExit = prompts.length;
			await page.setViewportSize({ width: 1280, height: 900 });
			if ((await page.locator("#menu-toggle").getAttribute("aria-expanded")) !== "true")
				await page.locator("#menu-toggle").click();
			await page.locator(".new-chat-btn").click();
			await expect.poll(() => inits.length).toBe(3);
			await expect.poll(() => page.locator("#relay-voice-ui").count()).toBe(0);
			expect(prompts).toHaveLength(beforeExit); // Leaving is a view change, not abort/start/work.
			await expect.poll(() => page.locator("#input").isEnabled()).toBe(true);
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

	it("trials streaming Pi speech with ZONOS3-Mini, rejects retired engines, and leaves production Relay untouched", async () => {
		const { page } = await openPage("/");
		const prompts: string[] = [],
			controls: string[] = [],
			tts: string[] = [];
		const inits: Record<string, unknown>[] = [];
		const contexts = new Map<string, string>();
		let kokoroRequests = 0;
		let native: (event: object) => void = () => {};
		await page.route(/\/api\/tts\/(kokoro|relay)-stream$/, (route) => {
			kokoroRequests++;
			return route.abort();
		});
		await page.route("**/api/tts/zonos-relay-stream", async (route) => {
			const { text } = route.request().postDataJSON() as { text: string };
			const firstTurn = tts.length === 0;
			tts.push(text);
			// Keep the first turn playing long enough for Stop speaking to interrupt it;
			// let the second turn finish promptly to verify complete aligned playback.
			await route.fulfill(zonosSpeechFixture(text, firstTurn ? 176_400 : 8820));
		});
		await page.evaluate(() => {
			localStorage.setItem("acb-relay-session", "keep-production-session");
			localStorage.setItem("acb-relay-voice-engine", "server4");
			localStorage.setItem("acb-relay-trial-engine", "kokoro");
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
			let dialog = page.getByRole("dialog", { name: "Trial A — streaming Pi voice", exact: true });
			const errors = messages(page).locator(".row-error");
			for (const [index, arg] of ["kokoro", "legacy"].entries()) {
				await send(page, `/relaytrial ${arg}`);
				await expect.poll(() => errors.count()).toBe(index + 1);
				expect(await errors.last().innerText()).toContain(
					"/relaytrial only uses ZONOS3-Mini. Use /relaytrial without an engine argument.",
				);
				expect(await dialog.count()).toBe(0);
			}
			expect(inits).toEqual([]);
			await send(page, "/relaytrial");
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			expect(await dialog.innerText()).toContain("ZONOS3-Mini reads the replies aloud");
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-trial-engine"))).toBe(
				"zonos3",
			);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-voice-engine"))).toBe(
				"server4",
			);
			expect(inits[0].sessionId).toBeUndefined();
			expect(await dialog.locator("iframe").count()).toBe(0);
			await dialog.getByRole("textbox", { name: "Relay message" }).fill("Read a harmless fixture");
			await dialog.getByRole("button", { name: "Send text", exact: true }).click();
			await expect.poll(() => tts.length).toBe(1); // No message_end or agent_settled was sent.
			await expect
				.poll(() => dialog.locator(".voice-test-status").innerText())
				.toContain("Speaking");
			await dialog.getByRole("button", { name: "Stop speaking", exact: true }).click();
			await expect.poll(() => prompts.some((p) => p.startsWith("/relay voice-heard "))).toBe(true);
			const heard = prompts.find((p) => p.startsWith("/relay voice-heard "))!;
			const heardText = JSON.parse(Buffer.from(heard.split(" ")[3], "base64url").toString()).text;
			expect(heardText).toContain("ZONOS3-Mini synthesis alignment");
			expect(heardText).toContain("interrupted/stopped");
			expect(heardText).toContain("Do not assume remaining generated text was played.");
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
			await expect.poll(() => tts.length).toBe(2);
			native({
				type: "message_end",
				message: {
					role: "assistant",
					content: "### Greeting\n\n**The first streamed sentence is ready.**",
				},
			});
			await expect
				.poll(() =>
					prompts.some((p) => {
						if (!p.startsWith("/relay voice-heard ")) return false;
						const text = JSON.parse(Buffer.from(p.split(" ")[3], "base64url").toString()).text;
						return (
							text.includes("ZONOS3-Mini synthesis alignment") &&
							text.includes("completed") &&
							text.includes("Greeting The first streamed sentence is ready.") &&
							!text.includes("**")
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
			expect(kokoroRequests).toBe(0);
			expect(prompts).not.toContain("/relay cancel");
			await page.evaluate(() => localStorage.setItem("acb-relay-trial-engine", "lfm-tts"));
			await send(page, "/relaytrial");
			dialog = page.getByRole("dialog", { name: "Trial A — streaming Pi voice", exact: true });
			await expect
				.poll(() => dialog.getByRole("log").innerText())
				.toContain("Saved, not replayed.");
			expect(await dialog.innerText()).toContain("ZONOS3-Mini reads the replies aloud");
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-trial-engine"))).toBe(
				"zonos3",
			);
			expect(
				await dialog.getByRole("button", { name: /Use .*TTS|Kokoro|LFM|Server4/ }).count(),
			).toBe(0);
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

	it("opens ZONOS-only Relay and rejects old or crafted engine arguments without starting a thread", async () => {
		const { page } = await openPage("/");
		const prompts: string[] = [],
			controls: string[] = [];
		await page.evaluate(() => localStorage.setItem("acb-relay-session", "zonos3-default-session"));
		await relayChatFixture(page, (ws) =>
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "init")
					ws.send(JSON.stringify({ type: "ready", sessionId: "zonos3-default-session" }));
				else if (message.type === "getCapabilities")
					ws.send(JSON.stringify({ type: "capabilities", commands: [{ name: "relay" }] }));
				else if (message.type === "prompt") {
					prompts.push(message.text);
					if (message.text.startsWith("/relay start"))
						ws.send(
							JSON.stringify({
								type: "event",
								event: {
									type: "message_end",
									message: {
										role: "custom",
										customType: "acb-relay",
										details: {
											kind: "ready",
											model: "fixture",
											workerModel: { provider: "venice", modelId: "fixture", thinkingLevel: "off" },
										},
									},
								},
							}),
						);
				} else controls.push(message.type);
			}),
		);
		try {
			const dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			const errors = messages(page).locator(".row-error");
			for (const [index, arg] of [
				"kokoro",
				"KOKORO-TTS",
				"legacy",
				"zonos3 new kokoro",
			].entries()) {
				await send(page, `/relay ${arg}`);
				await expect.poll(() => errors.count()).toBe(index + 1);
				expect(await errors.last().innerText()).toContain("Relay only uses ZONOS3-Mini");
				expect(await dialog.count()).toBe(0);
			}
			expect(prompts).toEqual([]);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-session"))).toBe(
				"zonos3-default-session",
			);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-voice-engine"))).toBeNull();
			await send(page, "/relay zonos3");
			await expect.poll(() => dialog.innerText()).toContain("ZONOS3-Mini reads the replies aloud");
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			await send(page, "/relay legacy");
			expect(await dialog.isVisible()).toBe(true);
			expect(await dialog.innerText()).toContain("ZONOS3-Mini reads the replies aloud");
			expect(prompts).toHaveLength(1);
			expect(controls).not.toContain("abort");
			await dialog.getByRole("button", { name: "End voice", exact: true }).click();
		} finally {
			await page.close();
		}
	});

	it("migrates Kokoro without changing the chat and plays only new aligned speech at the saved speed", async () => {
		const { page } = await openPage("/");
		let finishReply = () => {};
		const inits: Array<Record<string, unknown>> = [],
			prompts: string[] = [],
			ttsRequests: Array<{ text: string; speed: number }> = [],
			kokoroRequests: string[] = [];
		await page.evaluate(() => {
			localStorage.setItem("acb-relay-session", "saved-relay-session");
			localStorage.setItem("acb-relay-voice-engine", "kokoro");
			localStorage.setItem("acb-relay-trial-engine", "kokoro");
			localStorage.setItem("acb:prefs:saved-relay-session", JSON.stringify({ ttsSpeed: 0.85 }));
		});
		await page.route(/\/api\/tts\/(kokoro|relay)-stream$/, (route) => {
			kokoroRequests.push(route.request().url());
			return route.abort();
		});
		await page.route("**/api/tts/zonos-relay-stream*", (route) => {
			const request = route.request().postDataJSON() as { text: string; speed: number };
			ttsRequests.push(request);
			return route.fulfill(zonosSpeechFixture(request.text));
		});
		await relayChatFixture(page, (ws) => {
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
								messages: [
									{
										role: "assistant",
										content:
											"**Saved history** stays silent.\n\n" +
											Array.from({ length: 40 }, (_, i) => `Saved line ${i}`).join("\n\n"),
									},
								],
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
						});
					} else if (m.text === "Ping" || m.text.startsWith("/relay voice-request ")) {
						native({ type: "message_end", message: { role: "user", content: "Ping" } });
						native({ type: "message_start", message: { role: "assistant" } });
						native({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", delta: "**Ready on mobile.** " },
						});
						finishReply = () =>
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
			const dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect.poll(() => inits.length).toBe(1);
			expect(inits[0].sessionId).toBe("saved-relay-session");
			expect(new URL(page.url()).pathname).toBe("/s/saved-relay-session");
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-voice-engine"))).toBe(
				"zonos3",
			);
			const settings = dialog.getByRole("button", { name: "Voice settings & details" });
			expect(await settings.getAttribute("aria-expanded")).toBe("false");
			await settings.focus();
			await page.keyboard.press("Enter");
			expect(await settings.getAttribute("aria-expanded")).toBe("true");
			expect(
				await dialog.getByRole("button", { name: /Use .*TTS|Use Pi|Kokoro|legacy/ }).count(),
			).toBe(0);
			expect(await page.evaluate(() => localStorage.getItem("acb-relay-trial-engine"))).toBe(
				"kokoro",
			);
			await settings.click();
			await expect.poll(() => dialog.innerText()).toContain("Ready —");
			expect(await dialog.locator("iframe").count()).toBe(0);
			expect(ttsRequests).toHaveLength(0); // Saved history is never replayed.
			expect(await dialog.locator(".voice-test-model").first().innerText()).toBe(
				"Answers & tools: DeepSeek Flash · thinking off",
			);
			expect(await dialog.locator(".voice-test-model").last().innerText()).toContain(
				"Delegated work: fixture · thinking off (when requested)",
			);
			expect(await dialog.locator(".voice-test-help").innerText()).toContain(
				"Up to 2 minutes per turn",
			);
			expect(await dialog.locator(".voice-test-mic-state").innerText()).toBe("Microphone off");
			const micButton = dialog.getByRole("button", { name: "Start microphone", exact: true });
			expect(Math.round((await micButton.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
			expect(await dialog.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
				"rgba(0, 0, 0, 0)",
			);
			await dialog.getByRole("button", { name: "Voice settings & details" }).click();
			expect(
				await dialog.getByRole("button", { name: "Stop current Pi turn", exact: true }).isVisible(),
			).toBe(true);
			const noOverflow = await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
			expect(noOverflow).toBe(true);
			await dialog.getByRole("button", { name: "Voice settings & details" }).click();
			expect(
				await dialog.getByRole("button", { name: "Stop speaking", exact: true }).isVisible(),
			).toBe(true);
			const pauseBtn = dialog.getByRole("button", { name: "Pause voice", exact: true });
			expect(await pauseBtn.isVisible()).toBe(true);
			expect(await pauseBtn.getAttribute("aria-pressed")).toBe("false");
			await pauseBtn.click();
			await expect
				.poll(() => dialog.locator(".voice-test-status").innerText())
				.toBe("Paused — microphone muted; Pi work continues.");
			const resumeBtn = dialog.getByRole("button", { name: "Resume voice", exact: true });
			expect(await resumeBtn.getAttribute("aria-pressed")).toBe("true");
			// Minimise to collapsed strip and resume from the strip button:
			await dialog.getByRole("button", { name: "Minimise voice controls", exact: true }).click();
			const stripResume = page.locator(".relay-voice-strip").getByRole("button", {
				name: "Resume voice",
				exact: true,
			});
			expect(await stripResume.isVisible()).toBe(true);
			await stripResume.click();
			await expect
				.poll(() =>
					page
						.locator(".relay-voice-strip")
						.getByRole("button", { name: "Pause voice", exact: true })
						.getAttribute("aria-pressed"),
				)
				.toBe("false");
			await page.locator(".relay-voice-toggle").click();

			await page.locator("#input").fill("Ping");
			await page.locator("#send-btn").click();
			await expect.poll(() => ttsRequests.length > 0).toBe(true);
			// The normal composer scrolls to our own input; later model updates
			// must not yank us away after we choose to read older messages.
			await messages(page).evaluate((node) => {
				node.scrollTop = 0;
			});
			finishReply();
			expect(ttsRequests[0]).toEqual({ text: "Ready on mobile.", speed: 0.85 });
			expect(kokoroRequests).toEqual([]);
			await expect
				.poll(() =>
					prompts.some((p) => {
						if (!p.startsWith("/relay voice-heard ")) return false;
						const decoded = JSON.parse(Buffer.from(p.split(" ")[3], "base64url").toString()).text;
						return (
							decoded.includes("ZONOS3-Mini synthesis alignment") &&
							decoded.includes("ms played, completed") &&
							decoded.includes("Ready on mobile.")
						);
					}),
				)
				.toBe(true);
			expect(await messages(page).evaluate((node) => node.scrollTop)).toBe(0);
			expect(await messages(page).locator(".row-user").count()).toBe(1); // Typed echo is not duplicated.
			await page.setViewportSize({ width: 1440, height: 1000 });
			await expect
				.poll(async () => {
					const drawer = await dialog.boundingBox();
					const main = await page.locator("main").boundingBox();
					return Boolean(drawer && main && drawer.x >= main.x + main.width);
				})
				.toBe(true);
			await dialog.getByRole("button", { name: "End voice", exact: true }).click();
			expect(await dialog.count()).toBe(0);
			expect(new URL(page.url()).pathname).toBe("/s/saved-relay-session");
			expect(await messages(page).innerText()).toContain("Ready on mobile.");
		} finally {
			await page.close();
		}
	});

	it.each([
		"connection error",
		"wrong thread",
	])("keeps Relay closable after %s without starting or cancelling work", async (failure) => {
		const { page } = await openPage("/");
		const sent: string[] = [];
		await page.evaluate(() => localStorage.setItem("acb-relay-voice-engine", "lfm-tts"));
		await relayChatFixture(
			page,
			(ws) => {
				ws.onMessage((raw) => {
					const message = JSON.parse(String(raw));
					sent.push(message.type);
					if (message.type === "init")
						ws.send(
							JSON.stringify(
								failure === "connection error"
									? { type: "error", message: "Fixture connection unavailable" }
									: { type: "ready", sessionId: "relay-source-chat" },
							),
						);
				});
			},
			true,
		);
		try {
			await page.getByRole("button", { name: "Open Relay", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Relay", exact: true });
			await expect
				.poll(() => dialog.locator(".voice-test-status").innerText())
				.toContain(
					failure === "connection error"
						? "Fixture connection unavailable"
						: "Relay did not open the requested thread",
				);
			expect(
				await dialog.getByRole("button", { name: "Start microphone", exact: true }).isDisabled(),
			).toBe(true);
			expect(await dialog.getByRole("button", { name: "End voice", exact: true }).isEnabled()).toBe(
				true,
			);
			await dialog.getByRole("button", { name: "End voice", exact: true }).click();
			expect(await dialog.count()).toBe(0);
			await expect.poll(() => page.locator("#input").isEnabled()).toBe(true);
			expect(new URL(page.url()).pathname).toBe("/s/relay-source-chat");
			expect(sent.filter((type) => type === "prompt" || type === "abort")).toEqual([]);
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

	it("exposes model selection and pin/default actions as separate keyboard buttons", async () => {
		const { page } = await openPage("/");
		try {
			await expect.poll(() => page.locator("#model-picker").innerText()).toContain("Model");
			await page.locator("#model-picker").click();
			const model = MODELS.at(-1)!;
			await page.getByRole("searchbox", { name: "Filter models" }).fill(model.id);
			const row = page.locator(`.model-row[data-model-id="${model.id}"]`).last();
			expect(await row.getAttribute("role")).toBeNull();
			expect(await row.locator(":scope > button").count()).toBe(3);
			const choose = row.locator("button.model-row-info");
			expect(await choose.locator("button").count()).toBe(0);
			await choose.focus();
			await page.keyboard.press("Enter");
			await expect.poll(() => page.locator(".model-picker-box").count()).toBe(0);
			await expect.poll(() => page.locator("#model-picker").innerText()).toContain(model.name);
		} finally {
			await page.close();
		}
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
		await page.getByRole("button", { name: "Close", exact: true }).click({ timeout: 3000 });
		await page.locator("#status-bar [data-status-model]").click({ timeout: 3000 });
		const pinnedDialog = page.getByRole("dialog", { name: "Pinned models" });
		await expect.poll(() => pinnedDialog.locator(".model-row").count()).toBe(MODELS.length);
		await pinnedDialog.locator(`.model-row[data-model-id="${last.id}"]`).click({ timeout: 3000 });
		await expect
			.poll(() => page.locator("#status-bar [data-status-model]").textContent())
			.toBe(last.name);
		await page.locator("#status-bar [data-status-think]").click({ timeout: 3000 });
		const thinkDialog = page.getByRole("dialog", { name: "Thinking level" });
		await thinkDialog.locator(".model-row", { hasText: "low" }).click({ timeout: 3000 });
		await expect
			.poll(() => page.locator("#status-bar [data-status-think]").textContent())
			.toBe("think: low");
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

	it("keeps normal Relay voice active while collapsed, retains paused speech and fences typed replacement", async () => {
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
		await relayChatFixture(page, (ws) => {
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
			await send(page, "/relay zonos3");
			const dialog = page.locator("#relay-voice-panel");
			await expect.poll(() => dialog.locator(".voice-test-status").innerText()).toContain("Ready");
			await page.evaluate(() =>
				Object.defineProperty(navigator, "mediaDevices", {
					configurable: true,
					value: {
						getUserMedia: () =>
							new Promise((resolve) => {
								(window as unknown as { __allowMic(): void }).__allowMic = () =>
									resolve({ getTracks: () => [{ stop() {}, addEventListener() {} }] });
							}),
					},
				}),
			);
			await page.clock.install();
			await dialog.getByRole("button", { name: "Start microphone", exact: true }).click();
			expect(
				await dialog
					.getByRole("button", { name: "Starting microphone…", exact: true })
					.isDisabled(),
			).toBe(true);
			expect(await dialog.locator(".voice-test-mic-state").innerText()).toBe(
				"Microphone starting…",
			);
			await page.evaluate(() => (window as unknown as { __allowMic(): void }).__allowMic());
			await expect
				.poll(() => dialog.getByRole("button", { name: "Stop microphone", exact: true }).count())
				.toBe(1);
			expect(await dialog.locator(".voice-test-mic-state").innerText()).toBe("Microphone on");
			await dialog.getByRole("button", { name: "Minimise voice controls" }).click();
			expect(await dialog.isVisible()).toBe(false);
			await expect
				.poll(() => page.locator(".relay-voice-toggle").innerText())
				.toContain("Microphone on");
			expect(
				await dialog
					.getByRole("button", { name: "Stop microphone", includeHidden: true })
					.getAttribute("aria-pressed"),
			).toBe("true");
			await onset();
			await page.clock.fastForward(31_000);
			await page.getByRole("button", { name: "Open Relay", exact: true }).click();
			expect(await dialog.locator(".voice-test-mic-state").innerText()).toBe("Microphone on");
			expect(
				await dialog.getByRole("button", { name: "Stop microphone", exact: true }).isVisible(),
			).toBe(true);
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
			await dialog.getByRole("button", { name: "Stop speaking", exact: true }).click();
			await answer(2, "First sentence, um, final sentence.");
			await expect.poll(() => contexts).toEqual(["First sentence, um, final sentence."]);
			expect(controls.filter((s) => s.startsWith("/relay voice-request "))).toHaveLength(1);
			expect(await messages(page).locator(".row-user").count()).toBe(1);
			expect(await messages(page).innerText()).toContain("First sentence, um, final sentence.");
			await onset();
			await end([0.75]);
			await expect.poll(() => requests.length).toBe(4);
			await page.locator("#input").fill("Typed replacement");
			await page.locator("#send-btn").click();
			await requests[3].fulfill({ json: { text: "Stale unsent speech must not be submitted." } });
			await page.evaluate(
				() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
			);
			expect(contexts).toEqual(["First sentence, um, final sentence."]);
			expect(controls.filter((s) => s === "Typed replacement")).toHaveLength(1);
			expect(controls).not.toContain("abort");
			await dialog.getByRole("button", { name: "Stop microphone", exact: true }).click();
			expect(await dialog.locator(".voice-test-mic-state").innerText()).toBe("Microphone off");
			expect(
				await dialog.getByRole("button", { name: "Start microphone" }).getAttribute("aria-pressed"),
			).toBe("false");
			expect(controls).not.toContain("abort");
			await dialog.getByRole("button", { name: "End voice", exact: true }).click();
		} finally {
			await page.close();
		}
	});

	it("restores foreground ZONOS3 Relay on the same chat without replaying input or speech", async () => {
		const vadFixture = join(tmp, "foreground-vad.ts");
		writeFileSync(
			vadFixture,
			`
			export const MicVAD = { new: async (options) => {
				window.relayFixture.speak = () => {
					options.onSpeechStart();
					options.onSpeechRealStart();
					options.onSpeechEnd(Float32Array.of(0.25));
				};
				return { start: async () => {}, destroy: async () => {} };
			}};
			export const utils = { encodeWAV: () => new ArrayBuffer(128) };
		`,
		);
		const synthetic = await bundleClient(vadFixture);
		const { page } = await openPage("/", synthetic.js);
		const session = "foreground-relay";
		const sockets: WebSocketRoute[] = [];
		const inits: (string | undefined)[] = [];
		const commands: string[] = [];
		const asr: Route[] = [];
		let tts = 0;
		let heldCapabilities = 0;
		let holdCapabilities = false;
		const wire = (ws: WebSocketRoute, msg: object) => ws.send(JSON.stringify(msg));
		const capabilities = (ws: WebSocketRoute) =>
			wire(ws, { type: "capabilities", commands: [{ name: "relay" }] });
		const event = (ws: WebSocketRoute, frame: object) => wire(ws, { type: "event", event: frame });
		const assistant = (ws: WebSocketRoute, phase: "start" | "update" | "end", text: string) =>
			event(ws, {
				type: `message_${phase}`,
				message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 },
				...(phase === "update"
					? { assistantMessageEvent: { type: "text_delta", delta: text, contentIndex: 0 } }
					: {}),
			});
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			sockets.push(ws);
			ws.onMessage((raw) => {
				const msg = JSON.parse(String(raw));
				if (msg.type === "init") {
					inits.push(msg.sessionId);
					wire(ws, {
						type: "ready",
						sessionId: session,
						isStreaming: inits.length > 1,
						provider: "zai",
						modelId: "glm-5.2",
						thinkingLevel: "off",
					});
					if (inits.length > 1) {
						assistant(ws, "start", "");
						assistant(ws, "update", "Replayed part of a running turn.");
					}
				} else if (msg.type === "getCapabilities") {
					if (holdCapabilities) heldCapabilities++;
					else capabilities(ws);
				} else if (msg.type === "prompt") {
					commands.push(msg.text);
					if (msg.text.startsWith("/relay start"))
						event(ws, {
							type: "message_end",
							message: {
								role: "custom",
								customType: "acb-relay",
								details: {
									kind: "ready",
									model: "fixture",
									workerModel: { provider: "zai", modelId: "glm-5.2", thinkingLevel: "off" },
								},
							},
						});
				} else if (["abort", "resumeSession", "newSession"].includes(msg.type))
					commands.push(msg.type);
			});
		});
		await page.route("**/api/transcribe", (route) => {
			asr.push(route);
		});
		await page.route("**/api/tts/zonos-relay-stream*", (route) => {
			tts++;
			return route.fulfill({ status: 503, body: "fixture stops before real synthesis" });
		});
		await page.addInitScript((id) => {
			localStorage.setItem("acb-relay-session", id);
			const tracks: (EventTarget & { stop(): void })[] = [];
			const counters = { starts: 0, stops: 0, locks: 0, releases: 0 };
			let visibility = "visible";
			Object.defineProperty(document, "visibilityState", { get: () => visibility });
			Object.defineProperty(navigator, "mediaDevices", {
				value: {
					getUserMedia: async () => {
						counters.starts++;
						const track = Object.assign(new EventTarget(), {
							stop: () => {
								counters.stops++;
							},
						});
						tracks.push(track);
						return { getTracks: () => [track] };
					},
				},
			});
			Object.defineProperty(navigator, "wakeLock", {
				value: {
					request: async () => {
						counters.locks++;
						return {
							release: async () => {
								counters.releases++;
							},
						};
					},
				},
			});
			Object.assign(window, {
				relayFixture: {
					counters,
					visibility: (value: string) => {
						visibility = value;
						document.dispatchEvent(new Event("visibilitychange"));
					},
					interrupt: () => tracks.at(-1)?.dispatchEvent(new Event("ended")),
				},
			});
		}, session);
		const run = (action: string, ...args: string[]) =>
			page.evaluate(
				([name, params]) => {
					// biome-ignore lint/suspicious/noExplicitAny: installed above by the synthetic browser/audio fixture.
					const fixture = (window as any).relayFixture;
					return typeof fixture[name] === "function" ? fixture[name](...params) : fixture[name];
				},
				[action, args] as const,
			);
		const dialog = page.locator("#relay-voice-panel");
		const button = (name: string) => dialog.getByRole("button", { name, exact: true });
		const mic = () => dialog.locator(".voice-test-mic-state").innerText();
		try {
			await page.reload();
			await expect.poll(() => new URL(page.url()).pathname).toBe(`/s/${session}`);
			await page.getByRole("button", { name: "Open Relay", exact: true }).click();
			await button("Start microphone").click();
			await expect
				.poll(() => run("counters"))
				.toEqual({ starts: 1, stops: 0, locks: 1, releases: 0 });
			await run("speak");
			await expect.poll(() => asr.length).toBe(1);
			await run("visibility", "hidden");
			await expect
				.poll(() => run("counters"))
				.toEqual({ starts: 1, stops: 1, locks: 1, releases: 1 });
			assistant(sockets[0], "start", "");
			assistant(sockets[0], "update", "A reply began while hidden.");
			await asr[0].fulfill({ json: { text: "Abandoned recognition must not dispatch" } });
			holdCapabilities = true;
			await run("visibility", "visible");
			await expect.poll(() => heldCapabilities).toBe(1);
			expect(await mic()).toBe("Microphone off");
			capabilities(sockets[0]);
			await expect.poll(mic).toBe("Microphone on");
			assistant(sockets[0], "end", "A reply began while hidden.");
			await run("interrupt");
			await expect
				.poll(() => run("counters"))
				.toEqual({ starts: 3, stops: 2, locks: 3, releases: 2 });
			expect(sockets).toHaveLength(1);

			await run("visibility", "hidden");
			await sockets[0].close();
			await run("visibility", "visible");
			holdCapabilities = false;
			await expect.poll(() => inits).toEqual([undefined, session]);
			// Let the fixture acknowledge even if the reconnect initiated before the flag changed.
			capabilities(sockets[1]);
			await expect.poll(mic).toBe("Microphone on");
			assistant(sockets[1], "update", "End of the previously running turn.");
			assistant(
				sockets[1],
				"end",
				"Replayed part of a running turn. End of the previously running turn.",
			);
			await run("speak");
			await expect.poll(() => asr.length).toBe(2);
			await asr[1].fulfill({ json: { text: "New foreground speech" } });
			await expect
				.poll(() => commands.filter((c) => c.startsWith("/relay voice-request ")).length)
				.toBe(1);
			expect(tts).toBe(0);
			const contexts = commands.filter((c) => c.startsWith("/relay voice-context "));
			expect(contexts).toHaveLength(1);
			expect(JSON.parse(Buffer.from(contexts[0].split(" ")[3], "base64url").toString())).toEqual({
				text: "New foreground speech",
			});
			expect(commands.filter((c) => c.startsWith("/relay start"))).toHaveLength(1);
			expect(
				commands.filter((c) => /^(abort|resumeSession|newSession|\/relay (cancel|stop))/.test(c)),
			).toEqual([]);
			event(sockets[1], {
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "New foreground speech" }] },
			});
			assistant(sockets[1], "start", "");
			assistant(sockets[1], "update", "This is a brand new answer.");
			assistant(sockets[1], "end", "This is a brand new answer.");
			await expect.poll(() => tts).toBe(1);

			await button("Pause voice").click();
			await run("visibility", "hidden");
			await run("visibility", "visible");
			await expect.poll(() => button("Resume voice").isEnabled()).toBe(true);
			await expect
				.poll(() => run("counters"))
				.toEqual({ starts: 4, stops: 4, locks: 4, releases: 4 });
			await button("Resume voice").click();
			await expect.poll(mic).toBe("Microphone on");
			await button("Stop microphone").click();
			await run("visibility", "hidden");
			await run("visibility", "visible");
			await expect.poll(() => button("Start microphone").isEnabled()).toBe(true);
			await expect
				.poll(() => run("counters"))
				.toEqual({ starts: 5, stops: 5, locks: 5, releases: 5 });
			await button("Start microphone").click();
			await expect.poll(mic).toBe("Microphone on");
			await button("End voice").click();
			await run("visibility", "hidden");
			await run("visibility", "visible");
			await expect
				.poll(() => run("counters"))
				.toEqual({ starts: 6, stops: 6, locks: 6, releases: 6 });
			expect(await dialog.count()).toBe(0);
			expect(sockets).toHaveLength(2);
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

	it("renders replayed and live worker reports with normal answer controls, leaving parent notes compact", async () => {
		const { page } = await openPage("/");
		const prompts: string[] = [];
		let emitReport: (() => void) | undefined;
		const report = {
			role: "custom",
			customType: "note",
			content: "✅ Worker done: Fix page\n\nFixed and checked.",
			timestamp: 1000,
			details: { source: "delegate-telegram", worker: "w-1", seq: 1 },
		};
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type === "prompt") prompts.push(message.text);
				if (message.type !== "init") return;
				ws.send(
					JSON.stringify({
						type: "ready",
						sessionId: "worker-report",
						modelId: "glm-5.2",
						provider: "zai",
						thinkingLevel: "off",
					}),
				);
				ws.send(
					JSON.stringify({
						type: "transcript",
						sessionId: "worker-report",
						messages: [
							{ role: "user", content: [{ type: "text", text: "Fix page" }] },
							report,
							{
								...report,
								content: "Done; read worker report",
								details: { source: "delegate", worker: "w-1" },
							},
						],
					}),
				);
				emitReport = () =>
					ws.send(
						JSON.stringify({
							type: "event",
							event: {
								type: "message_start",
								message: { ...report, content: "Live worker report", timestamp: 2000 },
							},
						}),
					);
			});
		});
		try {
			await page.reload();
			const answers = page.locator(".row-assistant");
			await expect.poll(() => answers.count()).toBe(1);
			await expect.poll(() => page.locator(".row-note").count()).toBe(1);
			const checkControls = async (index: number) => {
				const answer = answers.nth(index);
				for (const label of [
					"Copy this answer",
					"Retry the previous request",
					"Ask the agent to continue",
					"Copy a shareable link to this chat",
				]) {
					expect(await answer.locator(`[aria-label="${label}"]`).count()).toBe(1);
				}
				expect(await answer.locator(".voice-variant-btn").count()).toBe(3);
				expect(await answer.locator(".immediate-voice").count()).toBe(0);
				expect(
					await answer.locator('a[aria-label="Fork this conversation here"]').getAttribute("href"),
				).toContain("worker-report");
				expect(
					await answer.locator(".body").evaluate((node) => getComputedStyle(node).borderLeftWidth),
				).toBe("0px");
			};
			await checkControls(0);
			emitReport!();
			await expect.poll(() => answers.count()).toBe(2);
			await checkControls(1);
			expect(await page.locator(".row-note .assistant-controls").count()).toBe(0);
			await answers.nth(0).locator('[data-voice-variant="short"]').click();
			await expect.poll(() => prompts.length).toBe(1);
			expect(prompts[0]).toContain('/voice-last short --match "✅ Worker done: Fix page');
		} finally {
			await page.close();
		}
	});

	it("renders a working TTS speak button on delegate report notes, but not on structural dividers", async () => {
		const { page } = await openPage("/");
		const spokenTexts: string[] = [];
		const wav = Buffer.alloc(44 + 4800 * 2);
		wav.write("RIFF", 0);
		wav.writeUInt32LE(wav.length - 8, 4);
		wav.write("WAVE", 8);
		wav.write("fmt ", 12);
		wav.writeUInt32LE(16, 16);
		wav.writeUInt16LE(1, 20);
		wav.writeUInt16LE(1, 22);
		wav.writeUInt32LE(24000, 24);
		wav.writeUInt32LE(48000, 28);
		wav.writeUInt16LE(2, 32);
		wav.writeUInt16LE(16, 34);
		wav.write("data", 36);
		wav.writeUInt32LE(wav.length - 44, 40);
		const frame = Buffer.alloc(5);
		frame[0] = 1;
		frame.writeUInt32LE(wav.length, 1);
		await page.route("**/api/tts/stream", async (route) => {
			spokenTexts.push(route.request().postDataJSON().text);
			await route.fulfill({
				body: Buffer.concat([frame, wav, Buffer.alloc(5)]),
				contentType: "application/octet-stream",
			});
		});
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type !== "init") return;
				ws.send(
					JSON.stringify({
						type: "ready",
						sessionId: "delegate-tts-note",
						modelId: "glm-5.2",
						provider: "zai",
						thinkingLevel: "off",
					}),
				);
				ws.send(
					JSON.stringify({
						type: "transcript",
						sessionId: "delegate-tts-note",
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: "Old branch" }],
								_acbInactiveBranch: true,
							},
							{
								role: "custom",
								customType: "note",
								content:
									"**Worker report** · ✅ done · [Fix page](/s/worker-1)\n\nFixed; 12 tests pass.",
								timestamp: 1000,
								details: { source: "delegate", worker: "worker-1" },
							},
						],
					}),
				);
			});
		});
		try {
			await page.reload();
			await expect.poll(() => messages(page).innerText()).toContain("Fixed; 12 tests pass.");
			const rows = page.locator(".row-note");
			await expect.poll(() => rows.count()).toBe(3);
			// Branch dividers ("Earlier branch…" and "Current branch resumes.") stay control-free.
			expect(await rows.nth(0).locator(".speak-btn").count()).toBe(0);
			expect(await rows.nth(1).locator(".speak-btn").count()).toBe(0);
			// The delegate report note gets TTS + copy controls and streams spoken text.
			const reportSpeak = rows.nth(2).locator(".note-actions .speak-btn");
			expect(await reportSpeak.count()).toBe(1);
			expect(
				await rows.nth(2).locator('.note-actions button[aria-label="Copy this note"]').count(),
			).toBe(1);
			await reportSpeak.click();
			await expect.poll(() => spokenTexts.length).toBe(1);
			expect(spokenTexts[0]).toContain("Worker report");
			expect(spokenTexts[0]).toContain("Fixed; 12 tests pass.");
		} finally {
			await page.close();
		}
	});

	it("renders /uploads video links, images, and bare paths as inline <video> players without altering inline code", async () => {
		const { page } = await openPage("/");
		await page.routeWebSocket(/\/api\/chat$/, (ws) => {
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type !== "init") return;
				ws.send(
					JSON.stringify({
						type: "ready",
						sessionId: "video-inline",
						modelId: "glm-5.2",
						provider: "zai",
						thinkingLevel: "off",
					}),
				);
				ws.send(
					JSON.stringify({
						type: "transcript",
						sessionId: "video-inline",
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: "[file: clip.mp4](/uploads/user-clip.mp4)" }],
							},
							{
								role: "assistant",
								content: [
									{
										type: "text",
										text:
											"Link: [My clip](/uploads/out-1.mp4)\n\n" +
											"Image syntax: ![Preview](/uploads/out-2.webm)\n\n" +
											"Bare path: /uploads/out-3.mov\n\n" +
											"Code stays code: `/uploads/in-code.mp4`",
									},
								],
							},
						],
					}),
				);
			});
		});
		try {
			await page.reload();
			await expect.poll(() => page.locator(".row-assistant .markdown video").count()).toBe(3);
			const assistantVideos = await page
				.locator(".row-assistant .markdown video")
				.evaluateAll((els) =>
					els.map((el) => ({
						src: el.getAttribute("src"),
						controls: el.hasAttribute("controls"),
						playsinline: el.hasAttribute("playsinline"),
						preload: el.getAttribute("preload"),
					})),
				);
			expect(assistantVideos).toEqual([
				{ src: "/uploads/out-1.mp4", controls: true, playsinline: true, preload: "metadata" },
				{ src: "/uploads/out-2.webm", controls: true, playsinline: true, preload: "metadata" },
				{ src: "/uploads/out-3.mov", controls: true, playsinline: true, preload: "metadata" },
			]);
			expect(
				await page.locator(".row-user .markdown video[src='/uploads/user-clip.mp4']").count(),
			).toBe(1);
			expect(await page.locator(".row-assistant .markdown code").innerText()).toBe(
				"/uploads/in-code.mp4",
			);
		} finally {
			await page.close();
		}
	});
});
