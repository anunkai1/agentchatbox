/** Opt in: real 8181 backend + real Relay byte pipe; output clock is simulated. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import express from "express";
import { expect, it, vi } from "vitest";
import { LfmRelay, VOICE_CONTEXT } from "../extensions/voice-test/lfm.js";
import {
	formatKokoroPlayedHistory,
	KokoroFrames,
	KokoroTtsTransport,
} from "../src/client/kokoro-tts.js";
import { type LfmPlayedReport, LfmTtsSpeaker } from "../src/client/lfm-tts.js";
import { createTtsRouter } from "../src/server/tts.js";
import { KOKORO_ALIGNMENT } from "../src/shared/kokoro.js";

it.runIf(process.env.KOKORO_LIVE === "1")(
	"real synthesis → proxy → player clock → saved data.heard, without Server4/ASR",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "relay-kokoro-live-"));
		const app = express();
		app.use(express.json());
		app.use("/api/tts", createTtsRouter());
		const server = createServer(app);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tts/relay-stream`;
		const originalFetch = globalThis.fetch;
		const network: string[] = [];
		vi.stubGlobal("fetch", ((input, init) => {
			network.push(String(input));
			return originalFetch(input, init);
		}) as typeof fetch);
		class AudioContext {
			currentTime = 1;
			outputStampTime = 1;
			state = "running";
			baseLatency = 0;
			destination = {};
			nodes: Array<{ startedAt: number; onended: (() => void) | null }> = [];
			getOutputTimestamp() {
				return { performanceTime: 100, contextTime: this.outputStampTime };
			}
			createBuffer(_c: number, samples: number, rate: number) {
				return { duration: samples / rate, copyToChannel() {} };
			}
			createBufferSource() {
				const node = {
					startedAt: 0,
					onended: null,
					buffer: null,
					connect() {},
					disconnect() {},
					stop() {},
					start(at: number) {
						this.startedAt = at;
					},
				};
				this.nodes.push(node);
				return node;
			}
			async resume() {}
			async close() {}
		}
		const audio = new AudioContext();
		vi.stubGlobal(
			"AudioContext",
			class {
				constructor() {
					return audio;
				}
			},
		);
		vi.stubGlobal("navigator", {});
		vi.stubGlobal(
			"WebSocket",
			class {
				static OPEN = 1;
				constructor() {
					throw new Error("No Server4 WebSocket allowed");
				}
			},
		);
		let speaker: LfmTtsSpeaker | undefined;
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Kokoro-Alignment": KOKORO_ALIGNMENT },
				body: JSON.stringify({ text: "Hello world.", speed: 1 }),
			});
			expect(response.headers.get("X-Kokoro-Alignment")).toBe(KOKORO_ALIGNMENT);
			const frames = new KokoroFrames().push(new Uint8Array(await response.arrayBuffer()));
			const metadata = JSON.parse(
				new TextDecoder().decode(frames.find((frame) => frame.type === 2)!.payload),
			);
			expect(metadata.submittedText).toBe("Hello world.");
			expect(metadata.words[0]).toMatchObject({
				text: "Hello",
				startSample: 8400,
				endSample: 15000,
			});
			let report: LfmPlayedReport | undefined;
			let playing!: () => void;
			let failed!: (error: unknown) => void;
			const began = new Promise<void>((resolve, reject) => {
				playing = resolve;
				failed = reject;
			});
			speaker = new LfmTtsSpeaker(
				{
					onStatus() {},
					onPlaying: playing,
					onIdle() {},
					onError: failed,
				},
				"",
				{ create: () => new KokoroTtsTransport(endpoint), label: "Server2 Kokoro" },
			);
			speaker.beginUtterance("live-kokoro-turn", 0, (value) => {
				report = value;
			});
			speaker.enqueueSegment("Hello world.");
			speaker.finishUtterance();
			await began;
			audio.currentTime = audio.outputStampTime = audio.nodes[0].startedAt + 0.9;
			speaker.stop(true);
			expect(report).toMatchObject({
				text: "Hello",
				playedMs: 900,
				playedSamples: 21600,
				submittedTexts: ["Hello world."],
			});
			const heard = formatKokoroPlayedHistory(report!);
			const manager = SessionManager.create(root, root);
			const pi = {
				appendEntry: (type: string, data: unknown) =>
					manager.appendCustomEntry(type, structuredClone(data)),
				sendUserMessage: vi.fn(),
			};
			const voice = new LfmRelay(pi as never, vi.fn(), vi.fn());
			const ctx = { sessionManager: manager, isIdle: () => true };
			const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
			await voice.handle(
				"voice-context",
				"fixture-owner",
				encode({ text: "Please say Hello world." }),
				ctx as never,
			);
			await voice.handle("voice-heard", "live-kokoro-turn", encode({ text: heard }), ctx as never);
			expect(
				manager
					.getBranch()
					.findLast((entry) => entry.type === "custom" && entry.customType === VOICE_CONTEXT),
			).toMatchObject({ data: { heard } });
			expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain(
				"Kokoro synthesis alignment",
			);
			expect(voice.history()).toContain("900 ms played");
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
			// Current backend omits the currency symbol. Continue audio, but never
			// fabricate a monetary value or lose the surrounding known history.
			speaker.close();
			const unavailable = vi.fn();
			let uncertain: LfmPlayedReport | undefined;
			speaker = new LfmTtsSpeaker(
				{ onStatus() {}, onPlaying() {}, onIdle() {}, onError: unavailable },
				"",
				{ create: () => new KokoroTtsTransport(endpoint), label: "Server2 Kokoro" },
			);
			speaker.beginUtterance("unreliable-price", 0, (value) => {
				uncertain = value;
			});
			const queued = audio.nodes.length;
			speaker.enqueueSegment("It costs $5.00.");
			speaker.finishUtterance();
			await vi.waitFor(() => expect(audio.nodes.length).toBeGreaterThan(queued), {
				timeout: 30000,
			});
			audio.currentTime = audio.outputStampTime = audio.nodes.at(-1)!.startedAt + 0.9;
			speaker.stop();
			expect(unavailable).not.toHaveBeenCalled();
			expect(uncertain).toMatchObject({ playedMs: 900, complete: false, uncertain: true });
			expect(uncertain?.text).toContain("UNKNOWN_WORDS");
			expect(uncertain?.text).not.toContain("5.00");
			await voice.handle(
				"voice-heard",
				"unreliable-price",
				encode({ text: formatKokoroPlayedHistory(uncertain!) }),
				ctx as never,
			);
			expect(voice.history()).toContain("UNKNOWN_WORDS");
			speaker.close();
			let bracket: LfmPlayedReport | undefined;
			speaker = new LfmTtsSpeaker(
				{ onStatus() {}, onPlaying() {}, onIdle() {}, onError: unavailable },
				"",
				{ create: () => new KokoroTtsTransport(endpoint), label: "Server2 Kokoro" },
			);
			speaker.beginUtterance("omitted-bracket", 0, (value) => {
				bracket = value;
			});
			const beforeBracket = audio.nodes.length;
			speaker.enqueueSegment("[code block]");
			speaker.finishUtterance();
			await vi.waitFor(() => expect(audio.nodes.length).toBeGreaterThan(beforeBracket), {
				timeout: 30000,
			});
			audio.currentTime = audio.outputStampTime = audio.nodes.at(-1)!.startedAt + 0.9;
			speaker.stop();
			expect(bracket).toMatchObject({
				text: "[code",
				uncertain: false,
				submittedTexts: ["[code block]"],
			});
			expect(unavailable).not.toHaveBeenCalled();
			expect(
				network.every(
					(url) =>
						url.startsWith("http://127.0.0.1:") &&
						(url.includes("/api/tts/relay-stream") || url.endsWith("8181/tts/stream")),
				),
			).toBe(true);
			console.log(
				JSON.stringify(
					{
						submitted: metadata.submittedText,
						timings: metadata.words,
						simulatedPlayedSamples: report!.playedSamples,
						retained: report!.text,
						savedHeard: heard,
						network,
					},
					null,
					2,
				),
			);
		} finally {
			speaker?.close();
			vi.unstubAllGlobals();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	},
	90_000,
);
