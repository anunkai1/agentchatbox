/** Voice recording auto-stop / manual-stop pill and Settings toggle regressions. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/linkify.js", () => ({ setRichText: vi.fn(), setUserRichText: vi.fn() }));

import {
	END_OF_SPEECH_SILENCE_MS,
	formatRecordingStatus,
	MANUAL_SILENCE_TIMEOUT_MS,
	NO_SPEECH_TIMEOUT_MS,
	silenceTimeoutMs,
} from "../src/client/voice.js";

const root = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(root, "src/client/styles.css"), "utf8");
let browser: Browser;
let script: string;

beforeAll(async () => {
	const bundle = await build({
		stdin: {
			resolveDir: root,
			contents: `
				import { applyDeviceDisplayPrefs } from './src/client/prefs.ts';
				import { refreshStatus, registerShellHandlers, renderShell, syncDisplayPreferences } from './src/client/render.ts';
				import { openOverflowMenu } from './src/client/slashes.ts';
				import { state } from './src/client/state.ts';
				import { cancelVoiceRecord, handleVoiceRecord, toggleVoiceAutoStop } from './src/client/voice.ts';

				window.__testState = state;
				window.__refreshStatus = refreshStatus;
				window.__openSettings = openOverflowMenu;
				applyDeviceDisplayPrefs();
				registerShellHandlers({
					handleSend: () => {},
					persistDraft: () => {},
					historyBack: () => {},
					historyForward: () => {},
					showSlashMenu: () => {},
					handleSlashMenuKeydown: () => false,
					handleSlash: () => {},
					openModelPicker: () => {},
					openThinkPicker: () => {},
					openOverflowMenu,
					toggleVoiceMode: () => {},
					handleVoiceRecord,
					cancelVoiceRecord,
					toggleVoiceAutoStop,
					stopAllVoice: () => {},
					pauseVoice: () => {},
					resumeVoice: () => {},
					handleFileAttach: async () => {},
					handlePaste: async () => {},
					handleDrop: async () => {},
					abort: () => {},
					abortRetry: () => {},
					setSessionPinned: () => {},
					renameSessionById: () => {},
					deleteSession: () => {},
					moveSession: () => {},
					newGlobalSession: () => {},
					newSessionInProject: () => {},
					createProject: () => {},
					updateProject: () => {},
					deleteProject: () => {},
					reorderProjects: () => {},
				});
				renderShell();
				syncDisplayPreferences();
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

async function open(options?: {
	failTranscribe?: boolean;
	viewport?: { width: number; height: number };
}): Promise<Page> {
	const page = await browser.newPage(
		options?.viewport ? { viewport: options.viewport } : undefined,
	);
	await page.clock.install();
	await page.route("https://acb.test/**", (route) => {
		if (route.request().url().endsWith("/api/transcribe")) {
			if (options?.failTranscribe) {
				return route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ error: "whisper unavailable" }),
				});
			}
			return route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({ text: "hello from mic" }),
			});
		}
		return route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><style>${css}</style>
				<div id="app"></div>
				<script>
					window.__micRms = 0.05;
					window.__stopCalls = 0;
					Object.defineProperty(navigator, "mediaDevices", {
						configurable: true,
						value: {
							getUserMedia: async () => ({
								getTracks: () => [{ stop: () => {} }],
							}),
						},
					});
					window.MediaRecorder = class MockMediaRecorder {
						constructor() {
							this.state = "inactive";
							this.ondataavailable = null;
							this.onstop = null;
						}
						start() {
							this.state = "recording";
						}
						stop() {
							if (this.state !== "recording") return;
							window.__stopCalls += 1;
							this.state = "inactive";
							this.ondataavailable?.({ data: new Blob(["abc"], { type: "audio/webm" }) });
							this.onstop?.();
						}
					};
					window.AudioContext = class MockAudioContext {
						constructor() {
							this.state = "running";
						}
						createAnalyser() {
							return {
								fftSize: 1024,
								getFloatTimeDomainData: (arr) => {
									arr.fill(window.__micRms);
								},
							};
						}
						createMediaStreamSource() {
							return { connect: () => {} };
						}
						resume() {
							return Promise.resolve();
						}
						close() {
							this.state = "closed";
							return Promise.resolve();
						}
					};
				</script>
				<script type="module">${script}</script>`,
		});
	});
	await page.goto("https://acb.test/");
	await page.waitForSelector("#voice-btn");
	return page;
}

describe("voice recording silence rules", () => {
	it("computes 4s/7s timeouts in auto mode and 60s in manual mode", () => {
		expect(silenceTimeoutMs(true, false)).toBe(NO_SPEECH_TIMEOUT_MS);
		expect(silenceTimeoutMs(true, true)).toBe(END_OF_SPEECH_SILENCE_MS);
		expect(silenceTimeoutMs(false, false)).toBe(MANUAL_SILENCE_TIMEOUT_MS);
		expect(silenceTimeoutMs(false, true)).toBe(MANUAL_SILENCE_TIMEOUT_MS);
	});

	it("formats live recording status with elapsed time and mode hint", () => {
		expect(formatRecordingStatus(12_400, true)).toBe(
			"recording (0:12) · stops after 4s pause · click mic to stop, ✕ to cancel",
		);
		expect(formatRecordingStatus(65_000, false)).toBe(
			"recording (1:05) · click mic to stop, ✕ to cancel",
		);
	});
});

describe("voice recording auto-stop pill UI", { timeout: 30_000 }, () => {
	it("shows the Auto 4s / Manual pill only while recording and respects manual pauses > 4s", async () => {
		const page = await open();
		try {
			const cancelBtn = page.locator("#voice-cancel-btn");
			const autoStopBtn = page.locator("#voice-autostop-btn");
			const voiceBtn = page.locator("#voice-btn");

			expect(await cancelBtn.isVisible()).toBe(false);
			expect(await autoStopBtn.isVisible()).toBe(false);

			await voiceBtn.click();
			await expect.poll(() => cancelBtn.isVisible()).toBe(true);
			await expect.poll(() => autoStopBtn.isVisible()).toBe(true);
			expect(await autoStopBtn.textContent()).toBe("Auto 4s");
			expect(await page.locator("#status-core").textContent()).toContain("stops after 4s pause");

			// Speak briefly, then pause 2s (not enough to stop in auto mode), and flip to Manual.
			await page.clock.runFor(200);
			await page.evaluate(() => {
				(window as unknown as { __micRms: number }).__micRms = 0;
			});
			await page.clock.runFor(2_000);
			await autoStopBtn.click();

			expect(await autoStopBtn.textContent()).toBe("Manual");
			expect(await autoStopBtn.getAttribute("class")).toContain("is-manual");
			expect(await autoStopBtn.getAttribute("aria-pressed")).toBe("true");
			expect(await page.locator("#status-core").textContent()).not.toContain(
				"stops after 4s pause",
			);

			// Silence for 10 seconds must NOT stop the recording in Manual mode.
			await page.clock.runFor(10_000);
			expect(
				await page.evaluate(() => (window as unknown as { __stopCalls: number }).__stopCalls),
			).toBe(0);
			expect(await autoStopBtn.isVisible()).toBe(true);

			// User clicks mic to stop and transcribe.
			await voiceBtn.click();
			await expect.poll(() => cancelBtn.isVisible()).toBe(false);
			await expect.poll(() => autoStopBtn.isVisible()).toBe(false);
			await expect.poll(() => page.locator("#input").inputValue()).toBe("hello from mic");

			// Persisted preference survives into Settings and next recording.
			await page.evaluate(() =>
				(window as unknown as { __openSettings: () => void }).__openSettings(),
			);
			const settingsRow = page.locator(".settings-row", { hasText: "Voice auto-stop" });
			expect(await settingsRow.textContent()).toContain("Manual (60s)");
			await settingsRow.click();
			expect(await settingsRow.textContent()).toContain("4s pause");
		} finally {
			await page.close();
		}
	});

	it("still auto-stops after 4s of silence when Auto 4s is active", async () => {
		const page = await open();
		try {
			await page.locator("#voice-btn").click();
			await expect.poll(() => page.locator("#voice-autostop-btn").isVisible()).toBe(true);
			expect(await page.locator("#voice-autostop-btn").textContent()).toBe("Auto 4s");
			// Hear speech, then pause > 4s.
			await page.clock.runFor(200);
			await page.evaluate(() => {
				(window as unknown as { __micRms: number }).__micRms = 0;
			});
			await page.clock.runFor(4_200);
			await expect
				.poll(() => page.evaluate(() => (window as unknown as { __stopCalls: number }).__stopCalls))
				.toBe(1);
			await expect.poll(() => page.locator("#voice-autostop-btn").isVisible()).toBe(false);
			await expect.poll(() => page.locator("#input").inputValue()).toBe("hello from mic");
		} finally {
			await page.close();
		}
	});

	it("resets silence timer when flipping Manual → Auto 4s and enforces 60s silence safety timeout", async () => {
		const page = await open();
		try {
			await page.locator("#voice-btn").click();
			await expect.poll(() => page.locator("#voice-autostop-btn").isVisible()).toBe(true);
			await page.locator("#voice-autostop-btn").click();
			expect(await page.locator("#voice-autostop-btn").textContent()).toBe("Manual");

			// Speak, pause 10s, flip back to Auto 4s: should NOT cut off immediately.
			await page.clock.runFor(200);
			await page.evaluate(() => {
				(window as unknown as { __micRms: number }).__micRms = 0;
			});
			await page.clock.runFor(10_000);
			await page.locator("#voice-autostop-btn").click();
			expect(await page.locator("#voice-autostop-btn").textContent()).toBe("Auto 4s");
			await page.clock.runFor(500);
			expect(
				await page.evaluate(() => (window as unknown as { __stopCalls: number }).__stopCalls),
			).toBe(0);

			// Flip back to Manual and let 60s of silence pass → safety timeout stops & transcribes.
			await page.locator("#voice-autostop-btn").click();
			await page.clock.runFor(60_100);
			await expect
				.poll(() => page.evaluate(() => (window as unknown as { __stopCalls: number }).__stopCalls))
				.toBe(1);
			await expect.poll(() => page.locator("#input").inputValue()).toBe("hello from mic");
		} finally {
			await page.close();
		}
	});

	it("keeps model and effort selector buttons visible on mobile after transcription completes", async () => {
		const page = await open({ viewport: { width: 390, height: 844 } });
		try {
			await page.evaluate(() => {
				const st = window as unknown as {
					__testState: {
						currentModelLabel: string;
						currentThinking: string;
						contextUsage: { tokens: number; contextWindow: number; percent: number };
					};
					__refreshStatus: () => void;
				};
				st.__testState.currentModelLabel = "Antigravity Claude Opus 4.6 (Thinking)";
				st.__testState.currentThinking = "high";
				st.__testState.contextUsage = { tokens: 120_000, contextWindow: 200_000, percent: 60 };
				st.__refreshStatus();
			});

			await page.locator("#voice-btn").click();
			await expect.poll(() => page.locator("#voice-cancel-btn").isVisible()).toBe(true);
			await page.locator("#voice-btn").click();

			await expect.poll(() => page.locator("#input").inputValue()).toBe("hello from mic");

			const modelBtn = page.locator("[data-status-model]");
			const thinkBtn = page.locator("[data-status-think]");
			const notice = page.locator("#status-notice");
			await expect.poll(() => modelBtn.isVisible()).toBe(true);
			await expect.poll(() => thinkBtn.isVisible()).toBe(true);
			await expect.poll(() => notice.isVisible()).toBe(true);
			expect(await notice.textContent()).toBe("transcribed (14 chars). Press Enter to send.");

			// Both buttons must fit inside the status bar bounds on mobile without clipping the effort chip.
			const barBox = await page.locator("#status-bar").boundingBox();
			const modelBox = await modelBtn.boundingBox();
			const thinkBox = await thinkBtn.boundingBox();
			expect(barBox).not.toBeNull();
			expect(modelBox).not.toBeNull();
			expect(thinkBox).not.toBeNull();
			expect(modelBox!.x).toBeGreaterThanOrEqual(barBox!.x);
			expect(thinkBox!.x + thinkBox!.width).toBeLessThanOrEqual(barBox!.x + barBox!.width + 1);
			expect(thinkBox!.width).toBeGreaterThan(40);

			// Toast clears after 8s while model & effort buttons stay visible.
			await page.clock.runFor(8_100);
			await expect.poll(() => notice.isVisible()).toBe(false);
			expect(await modelBtn.isVisible()).toBe(true);
			expect(await thinkBtn.isVisible()).toBe(true);
		} finally {
			await page.close();
		}
	});

	it("restores model and effort buttons when recording is cancelled or transcription fails", async () => {
		const cancelledPage = await open();
		try {
			await cancelledPage.locator("#voice-btn").click();
			await expect.poll(() => cancelledPage.locator("#voice-cancel-btn").isVisible()).toBe(true);
			await cancelledPage.locator("#voice-cancel-btn").click();
			await expect.poll(() => cancelledPage.locator("[data-status-model]").isVisible()).toBe(true);
			expect(await cancelledPage.locator("[data-status-think]").isVisible()).toBe(true);
			expect(await cancelledPage.locator("#status-notice").textContent()).toBe(
				"recording cancelled",
			);
		} finally {
			await cancelledPage.close();
		}

		const failedPage = await open({ failTranscribe: true });
		try {
			await failedPage.locator("#voice-btn").click();
			await expect.poll(() => failedPage.locator("#voice-cancel-btn").isVisible()).toBe(true);
			await failedPage.locator("#voice-btn").click();
			await expect.poll(() => failedPage.locator("[data-status-model]").isVisible()).toBe(true);
			expect(await failedPage.locator("[data-status-think]").isVisible()).toBe(true);
			expect(await failedPage.locator("#status-notice").textContent()).toBe(
				"transcription failed — recording available to retry",
			);
		} finally {
			await failedPage.close();
		}
	});
});
