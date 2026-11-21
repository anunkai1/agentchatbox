import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeFramedPcm16,
	type PcmPlayedReport,
	PcmTtsSpeaker,
	PlayedAudioClock,
} from "../src/client/pcm-tts.js";

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

	suspend(): Promise<void> {
		this.state = "suspended";
		return Promise.resolve();
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

class FakeTransport {
	static instances: FakeTransport[] = [];
	sent: Array<Record<string, unknown>> = [];
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;

	constructor() {
		FakeTransport.instances.push(this);
	}

	playedPrefix(_epoch: number, samples: number, interrupted: boolean, truncated: boolean) {
		return {
			text: samples ? "Fixture speech" : "",
			playedMs: Math.floor(samples / 24),
			playedSamples: samples,
			complete: !interrupted && !truncated && samples > 0,
			uncertain: truncated,
		};
	}

	send(raw: string): void {
		this.sent.push(JSON.parse(raw) as Record<string, unknown>);
	}

	close(): void {}

	receiveJson(payload: object): void {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}

	receiveBinary(buf: ArrayBuffer): void {
		this.onmessage?.({ data: buf });
	}
}

describe("Aligned PCM synthesis player", () => {
	beforeEach(() => {
		FakeAudioContext.instances = [];
		FakeTransport.instances = [];
		vi.stubGlobal("AudioContext", FakeAudioContext);
		vi.stubGlobal("navigator", {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("ticks only when running TTS is audible, never for idle input or pending audio", () => {
		const speaker = new PcmTtsSpeaker(
			{ onStatus: vi.fn(), onPlaying: vi.fn(), onIdle: vi.fn(), onError: vi.fn() },
			{ create: () => new FakeTransport(), label: "Test synth" },
		);
		speaker.stop(true);
		expect(FakeAudioContext.instances).toHaveLength(0);
		speaker.connect();
		const ctx = FakeAudioContext.instances[0];
		const ws = FakeTransport.instances[0];
		ws.receiveJson({ type: "ready", protocol: 3, tts: 1, outputRate: 24_000 });
		speaker.stop(true); // Ordinary mic speech start / idle manual Interrupt.
		expect(ctx.nodes).toHaveLength(0);
		speaker.beginUtterance("waiting", 0, vi.fn());
		speaker.stop(true);
		expect(ctx.nodes).toHaveLength(0);

		const play = (id: string) => {
			speaker.beginUtterance(id, 0, vi.fn());
			speaker.enqueueSegment("A sentence.");
			const begin = ws.sent.filter((msg) => msg.type === "speak").at(-1)!;
			ws.receiveBinary(encodePcmFrame(begin.epoch as number, Array(4_800).fill(0.1)));
		};
		play("scheduled");
		expect(ctx.nodes).toHaveLength(1);
		speaker.stop(true); // Scheduled 25 ms ahead, not yet audible.
		expect(ctx.nodes).toHaveLength(1);
		play("audible");
		ctx.currentTime = ctx.outputStampTime = 1.1;
		speaker.stop(true);
		expect(ctx.nodes).toHaveLength(3); // Two TTS nodes, one tick.
		expect(ctx.nodes[1].stopped).toBe(true);
		expect(ctx.nodes[2].buffer?.duration).toBe(0.03);
		expect(ctx.nodes[2].startedAt).toBe(ctx.currentTime);
		speaker.stop(true); // Tick is not itself assistant speech.
		expect(ctx.nodes).toHaveLength(3);
		expect(ctx.nodes[2].stopped).toBe(false);
		play("rapid-second-interruption");
		ctx.currentTime = ctx.outputStampTime = 1.15;
		speaker.stop(true);
		expect(ctx.nodes).toHaveLength(4); // A real second barge-in is still rate-limited.
		play("suspended");
		ctx.currentTime = ctx.outputStampTime = 1.2;
		ctx.state = "suspended";
		speaker.stop(true);
		expect(ctx.nodes).toHaveLength(5);
	});

	it("reports zero playback exactly once when nothing was synthesised", () => {
		const onReport = vi.fn();
		const speaker = new PcmTtsSpeaker(
			{ onStatus: vi.fn(), onPlaying: vi.fn(), onIdle: vi.fn(), onError: vi.fn() },
			{ create: () => new FakeTransport(), label: "Test synth" },
		);
		speaker.beginUtterance("empty-turn", 0, onReport);
		speaker.enqueueSegment(" ");
		speaker.finishUtterance();
		speaker.finishUtterance();
		expect(onReport).toHaveBeenCalledExactlyOnceWith({
			utterance: "empty-turn",
			playedMs: 0,
			playedSamples: 0,
			text: "",
			complete: false,
			uncertain: false,
		});
		speaker.close();
	});

	it("tracks output-clock playback milliseconds across scheduled chunks", () => {
		const clock = new PlayedAudioClock();
		clock.add(1.0, 0.5);
		clock.add(1.5, 0.5);
		expect(clock.isPlaying(0.9)).toBe(false);
		expect(clock.isPlaying(1.0)).toBe(true);
		expect(clock.isPlaying(1.75)).toBe(true);
		expect(clock.isPlaying(2.0)).toBe(false);
		clock.add(3.0, 0.5);
		expect(clock.isPlaying(2.5)).toBe(false);
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

	it("fences stale frames when a new utterance replaces interrupted PCM", () => {
		const onReport = vi.fn();
		const speaker = new PcmTtsSpeaker(
			{ onStatus: vi.fn(), onPlaying: vi.fn(), onIdle: vi.fn(), onError: vi.fn() },
			{ create: () => new FakeTransport(), label: "Test synth" },
		);
		speaker.beginUtterance("old", 0, onReport);
		const transport = FakeTransport.instances[0];
		transport.receiveJson({ type: "ready", protocol: 3, tts: 1, outputRate: 24000 });
		speaker.enqueueSegment("Old speech.");
		transport.receiveBinary(encodePcmFrame(1, Array(4800).fill(0.1)));
		speaker.stop();
		expect(transport.sent.at(-1)).toEqual({ type: "cancel", epoch: 1 });
		expect(onReport).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ utterance: "old", playedMs: 0, complete: false }),
		);
		speaker.beginUtterance("new", 0, vi.fn());
		speaker.enqueueSegment("New speech.");
		transport.receiveBinary(encodePcmFrame(1, Array(4800).fill(0.1)));
		expect(FakeAudioContext.instances[0].nodes).toHaveLength(1);
		transport.receiveBinary(encodePcmFrame(2, Array(4800).fill(0.1)));
		expect(FakeAudioContext.instances[0].nodes).toHaveLength(2);
		speaker.close();
	});

	it("suspends playback on pause without auto-resuming when new PCM arrives, then finishes after resume", async () => {
		const reports: PcmPlayedReport[] = [];
		let idleCount = 0;
		const speaker = new PcmTtsSpeaker(
			{
				onStatus: () => {},
				onPlaying: () => {},
				onIdle: () => {
					idleCount++;
				},
				onError: (err) => {
					throw err;
				},
			},
			{ create: () => new FakeTransport(), label: "Test synth" },
		);
		await speaker.pause();
		const ctx = FakeAudioContext.instances[0];
		expect(ctx.state).toBe("suspended");

		speaker.beginUtterance("utt-paused", performance.now(), (r) => reports.push(r));
		speaker.enqueueSegment("Spoken after resume.");
		speaker.finishUtterance();
		const ws = FakeTransport.instances[0];
		ws.receiveJson({ type: "ready", protocol: 3, tts: 1, outputRate: 24000, loadMs: 0 });
		ws.receiveBinary(encodePcmFrame(1, new Array(6000).fill(0.1)));
		ws.receiveJson({ type: "utterance_done", epoch: 1 });

		// Scheduling while paused must NOT auto-resume the suspended AudioContext.
		expect(ctx.state).toBe("suspended");
		expect(ctx.nodes).toHaveLength(1);
		expect(speaker.hasAudio).toBe(true);
		expect(ws.sent.filter((m) => m.type === "played")).toHaveLength(0);

		await speaker.resume();
		expect(ctx.state).toBe("running");
		ctx.outputStampTime = 5.0;
		ctx.nodes[0].onended?.();
		expect(ws.sent.at(-1)).toEqual({
			type: "played",
			epoch: 1,
		});
		expect(reports).toEqual([
			expect.objectContaining({ utterance: "utt-paused", playedSamples: 6000, complete: true }),
		]);
		expect(idleCount).toBe(1);
		speaker.close();
	});
});
