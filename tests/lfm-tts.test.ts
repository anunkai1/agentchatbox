import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeFramedPcm16,
	formatLfmPlayedHistory,
	type LfmPlayedReport,
	LfmTtsSpeaker,
	PlayedAudioClock,
} from "../src/client/lfm-tts.js";

function encodePcmFrame(epoch: number, samples: number[]): ArrayBuffer {
	const buf = new ArrayBuffer(4 + samples.length * 2);
	const view = new DataView(buf);
	view.setUint32(0, epoch, false);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(4 + i * 2, Math.round(s * 32767), true);
	}
	return buf;
}

class FakeAudioNode {
	buffer: { duration: number } | null = null;
	onended: (() => void) | null = null;
	startedAt = -1;
	stopped = false;
	connect(): void {}
	disconnect(): void {}
	start(at: number): void {
		this.startedAt = at;
	}
	stop(): void {
		this.stopped = true;
	}
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	state: "running" | "suspended" = "running";
	currentTime = 1.0;
	baseLatency = 0;
	outputLatency = 0;
	outputStampTime = 1.0;
	nodes: FakeAudioNode[] = [];

	constructor() {
		FakeAudioContext.instances.push(this);
	}

	resume(): Promise<void> {
		this.state = "running";
		return Promise.resolve();
	}

	close(): Promise<void> {
		return Promise.resolve();
	}

	getOutputTimestamp(): { performanceTime: number; contextTime: number } {
		return { performanceTime: 100, contextTime: this.outputStampTime };
	}

	createBuffer(_channels: number, length: number, sampleRate: number) {
		const data = new Float32Array(length);
		return {
			duration: length / sampleRate,
			copyToChannel: (src: Float32Array) => data.set(src),
		};
	}

	createBufferSource(): FakeAudioNode {
		const node = new FakeAudioNode();
		this.nodes.push(node);
		return node;
	}

	destination = {};
}

class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.OPEN;
	binaryType = "blob";
	bufferedAmount = 0;
	sent: Array<Record<string, unknown>> = [];
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(public readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(raw: string): void {
		this.sent.push(JSON.parse(raw) as Record<string, unknown>);
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
	}

	receiveJson(payload: object): void {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}

	receiveBinary(buf: ArrayBuffer): void {
		this.onmessage?.({ data: buf });
	}
}

describe("LFM speech-only TTS client primitives", () => {
	beforeEach(() => {
		FakeAudioContext.instances = [];
		FakeWebSocket.instances = [];
		vi.stubGlobal("AudioContext", FakeAudioContext);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		vi.stubGlobal("navigator", {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("tracks output-clock playback milliseconds across scheduled chunks", () => {
		const clock = new PlayedAudioClock();
		clock.add(1.0, 0.5);
		clock.add(1.5, 0.5);
		expect(clock.milliseconds(0.9)).toBe(0);
		expect(clock.milliseconds(1.25)).toBe(250);
		expect(clock.milliseconds(1.75)).toBe(750);
		expect(clock.milliseconds(3.0)).toBe(1000);
	});

	it("decodes valid framed s16le PCM and rejects malformed binary frames", () => {
		expect(decodeFramedPcm16(new ArrayBuffer(3))).toBeNull();
		expect(decodeFramedPcm16(new ArrayBuffer(7))).toBeNull();
		const frame = encodePcmFrame(7, [0, 0.5, -0.5]);
		const decoded = decodeFramedPcm16(frame);
		expect(decoded?.epoch).toBe(7);
		expect(decoded?.samples.length).toBe(3);
		expect(decoded!.samples[0]).toBeCloseTo(0, 4);
		expect(decoded!.samples[1]).toBeCloseTo(0.5, 3);
		expect(decoded!.samples[2]).toBeCloseTo(-0.5, 3);
	});

	it("formats honest played-prefix history and bounds encoded payload bytes", () => {
		expect(
			formatLfmPlayedHistory({
				utterance: "u0",
				playedMs: 0,
				text: "",
				complete: false,
				uncertain: false,
			}),
		).toContain("0 ms, interrupted before playback");

		const interrupted = formatLfmPlayedHistory({
			utterance: "u1",
			playedMs: 1100,
			text: "First sentence only",
			complete: false,
			uncertain: false,
		});
		expect(interrupted).toContain("1100 ms, interrupted; unhinted ASR, not verbatim");
		expect(interrupted).toContain("Remaining generated text in chat was NOT played.");

		const huge = formatLfmPlayedHistory({
			utterance: "u2",
			playedMs: 60000,
			text: "word ".repeat(6000),
			complete: false,
			uncertain: true,
		});
		expect(huge).toContain("[Earlier played words omitted]");
		expect(huge).toContain("exact word boundary uncertain");
		expect(new TextEncoder().encode(JSON.stringify({ text: huge })).length).toBeLessThanOrEqual(
			17_000,
		);
	});

	it("schedules progressive PCM before utterance_done, fences stale epochs on interrupt, and flushes pending reports", async () => {
		const statuses: string[] = [];
		const reports: LfmPlayedReport[] = [];
		let playingCount = 0;
		const speaker = new LfmTtsSpeaker(
			{
				onStatus: (text) => statuses.push(text),
				onPlaying: () => {
					playingCount++;
				},
				onIdle: () => {},
				onError: (err) => {
					throw err;
				},
			},
			"wss://agent.mavali.top/experiments/lfm-voice/ws?tts=1",
		);

		speaker.beginUtterance("utt-1", performance.now(), (r) => reports.push(r));
		speaker.enqueueSegment("First sentence starts immediately.");
		const ws = FakeWebSocket.instances[0];
		ws.receiveJson({ type: "starting" });
		expect(statuses).not.toContain("Error");
		ws.receiveJson({ type: "ready", protocol: 3, tts: 1, outputRate: 24000, loadMs: 740 });
		expect(ws.sent).toEqual([
			{
				type: "speak",
				epoch: 1,
				utterance: "utt-1",
				seq: 0,
				text: "First sentence starts immediately.",
			},
		]);

		// Send 6,000 samples (250 ms >= 240 ms preroll) BEFORE utterance_done:
		// progressive playback must schedule immediately without waiting for full synthesis.
		ws.receiveJson({ type: "first_pcm", epoch: 1, seq: 0, ttsFirstPcmMs: 58 });
		ws.receiveBinary(encodePcmFrame(1, new Array(6000).fill(0.1)));
		const ctx = FakeAudioContext.instances[0];
		expect(ctx.nodes).toHaveLength(1);
		expect(playingCount).toBe(1);

		// Advance output clock by 120 ms into the scheduled buffer (starts at 1.025s -> 1.145s = 120ms), then interrupt.
		ctx.outputStampTime = 1.145;
		speaker.stop();
		expect(ctx.nodes[0].stopped).toBe(true);
		expect(ws.sent.at(-1)).toEqual({
			type: "cancel",
			epoch: 1,
			utterance: "utt-1",
			played_ms: 120,
		});
		expect(speaker.hasPendingReports()).toBe(true);

		// Stale binary frame from epoch 1 arriving after interrupt must be dropped, never scheduled.
		ws.receiveBinary(encodePcmFrame(1, new Array(6000).fill(0.2)));
		expect(ctx.nodes).toHaveLength(1);

		const waitFlush = speaker.flushPendingReports(1000);
		ws.receiveJson({
			type: "played_prefix",
			epoch: 1,
			utterance: "utt-1",
			playedMs: 120,
			text: "First",
			complete: false,
			uncertain: false,
		});
		await waitFlush;
		expect(speaker.hasPendingReports()).toBe(false);
		expect(reports).toEqual([
			{
				utterance: "utt-1",
				playedMs: 120,
				text: "First",
				complete: false,
				uncertain: false,
			},
		]);

		// Fresh follow-up utterance uses epoch 2 and completes cleanly even when shorter than preroll.
		speaker.beginUtterance("utt-2", performance.now(), (r) => reports.push(r));
		speaker.enqueueSegment("Short reply.");
		speaker.finishUtterance();
		ws.receiveBinary(encodePcmFrame(2, new Array(2400).fill(0.1))); // 100 ms (< preroll)
		expect(ctx.nodes).toHaveLength(1); // Still in preroll until utterance_done
		ws.receiveJson({ type: "utterance_done", epoch: 2, utterance: "utt-2", truncated: false });
		expect(ctx.nodes).toHaveLength(2); // Flushed on utterance_done!
		ctx.outputStampTime = 5.0;
		ctx.nodes[1].onended?.();
		expect(ws.sent.at(-1)).toEqual({
			type: "played",
			epoch: 2,
			utterance: "utt-2",
			played_ms: 100,
		});
		ws.receiveJson({
			type: "played_prefix",
			epoch: 2,
			utterance: "utt-2",
			playedMs: 100,
			text: "Short reply.",
			complete: true,
			uncertain: false,
		});
		expect(reports.at(-1)).toEqual({
			utterance: "utt-2",
			playedMs: 100,
			text: "Short reply.",
			complete: true,
			uncertain: false,
		});
		speaker.close();
	});

	it("settles active playback as uncertain on unexpected WebSocket disconnect without throwing", () => {
		const reports: LfmPlayedReport[] = [];
		const errors: unknown[] = [];
		const speaker = new LfmTtsSpeaker(
			{
				onStatus: () => {},
				onPlaying: () => {},
				onIdle: () => {},
				onError: (err) => errors.push(err),
			},
			"wss://agent.mavali.top/experiments/lfm-voice/ws?tts=1",
		);
		speaker.beginUtterance("utt-drop", performance.now(), (r) => reports.push(r));
		speaker.enqueueSegment("Interrupted by network drop.");
		const ws = FakeWebSocket.instances[0];
		ws.receiveJson({ type: "ready", protocol: 3, tts: 1, outputRate: 24000, loadMs: 0 });
		ws.receiveBinary(encodePcmFrame(1, new Array(6000).fill(0.1)));
		FakeAudioContext.instances[0].outputStampTime = 1.125;
		ws.onclose?.();
		expect(errors).toHaveLength(1);
		expect(reports).toEqual([
			{
				utterance: "utt-drop",
				playedMs: 100,
				text: "",
				complete: false,
				uncertain: true,
			},
		]);
		speaker.close();
	});
});
