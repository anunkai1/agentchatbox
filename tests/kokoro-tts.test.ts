import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	completedKokoroWords,
	createKokoroSpeaker,
	formatKokoroPlayedHistory,
	hasReliableKokoroWords,
	KokoroFrames,
	validateKokoroAlignment,
} from "../src/client/kokoro-tts.js";
import { type LfmPlayedReport, PlayedAudioClock } from "../src/client/lfm-tts.js";
import {
	DEFAULT_RELAY_VOICE_ENGINE,
	resolveRelayVoiceEngine,
} from "../src/client/relay-voice-engine.js";
import { KOKORO_ALIGNMENT } from "../src/shared/kokoro.js";

// Captured from the deployed Python backend, not estimated/divided in the client.
const metadata = {
	alignment: KOKORO_ALIGNMENT,
	sampleRate: 24000,
	submittedText: "Hello world.",
	text: "Hello world.",
	startSample: 0,
	endSample: 37800,
	alignmentComplete: true,
	unalignedTokens: [],
	words: [
		{ text: "Hello", whitespace: " ", startSample: 8400, endSample: 15000 },
		{ text: "world", whitespace: "", startSample: 15000, endSample: 31200 },
		{ text: ".", whitespace: "", startSample: 31200, endSample: 35400 },
	],
};
// Also captured from loopback 8181: the model's tokens omit ] and $ respectively.
const bracketMetadata = {
	...metadata,
	submittedText: "[code block]",
	text: "[code block]",
	words: [
		{ text: "[code", whitespace: " ", startSample: 8400, endSample: 15600 },
		{ text: "block", whitespace: "", startSample: 15600, endSample: 35400 },
	],
};
const priceMetadata = {
	...metadata,
	submittedText: "It costs $5.00.",
	text: "It costs $5.00.",
	endSample: 49800,
	words: [
		{ text: "It", whitespace: " ", startSample: 6000, endSample: 9000 },
		{ text: "costs", whitespace: " ", startSample: 9000, endSample: 18000 },
		{ text: "5.00", whitespace: "", startSample: 18000, endSample: 43800 },
		{ text: ".", whitespace: "", startSample: 43800, endSample: 47400 },
	],
};
function wav(samples = 37800): Uint8Array {
	const bytes = new Uint8Array(44 + samples * 2),
		view = new DataView(bytes.buffer);
	const tag = (at: number, text: string) => bytes.set(new TextEncoder().encode(text), at);
	tag(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 24000, true);
	view.setUint32(28, 48000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, samples * 2, true);
	return bytes;
}
function frame(type: number, payload = new Uint8Array()): Uint8Array {
	const bytes = new Uint8Array(5 + payload.length);
	bytes[0] = type;
	new DataView(bytes.buffer).setUint32(1, payload.length, true);
	bytes.set(payload, 5);
	return bytes;
}
function meta(value: unknown = metadata): Uint8Array {
	return frame(2, new TextEncoder().encode(JSON.stringify(value)));
}
function response(parts = [meta(), frame(1, wav()), frame(0)]): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const part of parts) {
					// Split both frame headers and payloads over unrelated network reads.
					for (const piece of [part.slice(0, 2), part.slice(2, 7), part.slice(7)])
						if (piece.length) controller.enqueue(piece);
				}
				controller.close();
			},
		}),
		{ headers: { "X-Kokoro-Alignment": KOKORO_ALIGNMENT } },
	);
}
class AudioNode {
	buffer: { duration: number } | null = null;
	onended: (() => void) | null = null;
	startedAt = 0;
	stopped = false;
	connect() {}
	disconnect() {}
	start(at: number) {
		this.startedAt = at;
	}
	stop() {
		this.stopped = true;
	}
}
class AudioContext {
	static instances: AudioContext[] = [];
	currentTime = 1;
	outputStampTime = 1;
	state = "running";
	baseLatency = 0;
	destination = {};
	nodes: AudioNode[] = [];
	constructor() {
		AudioContext.instances.push(this);
	}
	getOutputTimestamp() {
		return { performanceTime: 100, contextTime: this.outputStampTime };
	}
	createBuffer(_channels: number, length: number, rate: number) {
		return { duration: length / rate, copyToChannel() {} };
	}
	createBufferSource() {
		const node = new AudioNode();
		this.nodes.push(node);
		return node;
	}
	async suspend() {
		this.state = "suspended";
	}
	async resume() {
		this.state = "running";
	}
	async close() {}
}
class NoServer4Socket {
	static OPEN = 1;
	constructor() {
		throw new Error("Kokoro must not contact Server4");
	}
}

function harness() {
	const reports: LfmPlayedReport[] = [];
	const error = vi.fn();
	const speaker = createKokoroSpeaker({
		onStatus: vi.fn(),
		onPlaying: vi.fn(),
		onIdle: vi.fn(),
		onError: error,
	});
	const begin = (text = "Hello world.") => {
		speaker.beginUtterance("turn-one", 0, (report) => reports.push(report));
		speaker.enqueueSegment(text);
		speaker.finishUtterance();
	};
	return { speaker, reports, error, begin, clock: () => AudioContext.instances[0] };
}

describe("Kokoro Relay transport and shared playback clock", () => {
	beforeEach(() => {
		AudioContext.instances = [];
		vi.stubGlobal("AudioContext", AudioContext);
		vi.stubGlobal("WebSocket", NoServer4Socket);
		vi.stubGlobal("navigator", {});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("parses negotiated metadata/WAV into the shared player and retains only completed words", async () => {
		const fetch = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetch);
		const h = harness();
		// Start at the rendered synthesis input, not raw **Hello** Markdown.
		// DOM rendering itself is exercised by the existing browser smoke suite.
		const rendered = "Hello world.";
		h.begin(rendered);
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(1));
		expect(fetch.mock.calls[0]).toMatchObject([
			"/api/tts/relay-stream",
			{
				headers: { "X-Kokoro-Alignment": KOKORO_ALIGNMENT },
				body: JSON.stringify({ text: rendered, speed: 1 }),
			},
		]);
		const ctx = h.clock();
		ctx.currentTime = ctx.outputStampTime = ctx.nodes[0].startedAt + 0.9;
		h.speaker.stop(true);
		expect(h.reports[0]).toMatchObject({
			playedMs: 900,
			text: "Hello",
			complete: false,
			uncertain: false,
			submittedTexts: [rendered],
			alignment: KOKORO_ALIGNMENT,
		});
		expect(ctx.nodes).toHaveLength(2);
		expect(ctx.nodes[1].buffer?.duration).toBe(0.03); // Same playback-gated tick.
		expect(formatKokoroPlayedHistory(h.reports[0])).toContain("Pronunciation not verified");
		h.speaker.close();
	});

	it("never rounds a partially played word up, including exact sample boundaries and gaps", () => {
		const clock = new PlayedAudioClock();
		clock.add(1, 1.575);
		clock.add(3, 0.2);
		expect(completedKokoroWords(metadata.words, clock.samples(1 + 14999 / 24000))).toBe("");
		expect(completedKokoroWords(metadata.words, clock.samples(1 + 15000 / 24000))).toBe("Hello");
		expect(completedKokoroWords(metadata.words, 31199)).toBe("Hello");
		expect(completedKokoroWords(metadata.words, 31200)).toBe("Hello world");
		expect(clock.samples(2.8)).toBe(37800); // Scheduling silence isn't played PCM.
		expect(completedKokoroWords(metadata.words, 0)).toBe("");
	});

	it("bounds saved history without inventing partial-word fragments", () => {
		const word = "supercalifragilisticexpialidocious";
		const history = formatKokoroPlayedHistory({
			utterance: "bounded",
			playedMs: 900,
			text: `${word} `.repeat(1000),
			complete: true,
			uncertain: false,
		});
		expect(history.length).toBeLessThanOrEqual(16000);
		expect(new TextEncoder().encode(JSON.stringify({ text: history })).length).toBeLessThanOrEqual(
			17000,
		);
		expect(history).toContain(`[Earlier completed input words omitted] ${word}`);
	});

	it("keeps zero-play empty and never ticks for queued/idle audio", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response()),
		);
		const h = harness();
		h.speaker.stop(true);
		h.begin();
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(1));
		h.speaker.stop(true); // 25 ms scheduled ahead; output clock has not passed it.
		expect(h.reports[0]).toMatchObject({ playedMs: 0, text: "", complete: false });
		expect(h.clock().nodes).toHaveLength(1);
		expect(formatKokoroPlayedHistory(h.reports[0])).toContain("No generated speech was played");
		h.speaker.close();
	});

	it("records authoritative 380-character synthesis input and labels truncation", async () => {
		const submitted = "x".repeat(380);
		const m = {
			...metadata,
			submittedText: submitted,
			text: submitted,
			endSample: 480,
			words: [{ text: submitted, whitespace: "", startSample: 0, endSample: 240 }],
		};
		const fetch = vi.fn(async () => response([meta(m), frame(1, wav(480)), frame(0)]));
		vi.stubGlobal("fetch", fetch);
		const h = harness();
		h.begin("x".repeat(400));
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(1));
		const ctx = h.clock();
		ctx.currentTime = ctx.outputStampTime = ctx.nodes[0].startedAt + 0.02;
		ctx.nodes[0].onended?.();
		expect(h.reports[0]).toMatchObject({
			submittedTexts: [submitted],
			complete: false,
			uncertain: true,
		});
		expect(h.reports[0].issues?.join(" ")).toContain("truncated");
		expect(
			JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).text,
		).toHaveLength(380);
		h.speaker.close();
	});

	it("retains validated played words on synthesis failure, without ASR or retry", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const fetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(c) {
							controller = c;
							c.enqueue(meta());
							c.enqueue(frame(1, wav()));
						},
					}),
					{ headers: { "X-Kokoro-Alignment": KOKORO_ALIGNMENT } },
				),
		);
		vi.stubGlobal("fetch", fetch);
		const h = harness();
		h.begin();
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(1));
		const ctx = h.clock();
		ctx.currentTime = ctx.outputStampTime = ctx.nodes[0].startedAt + 0.9;
		controller.enqueue(frame(128, new TextEncoder().encode("native synthesis failed")));
		controller.close();
		await vi.waitFor(() => expect(h.error).toHaveBeenCalled());
		expect(h.reports[0]).toMatchObject({
			text: "Hello",
			playedMs: 900,
			complete: false,
			uncertain: true,
		});
		expect(h.reports[0].issues).toContain("native synthesis failed");
		expect(fetch).toHaveBeenCalledTimes(1);
		h.speaker.close();
	});

	it("reconciles the real omitted closing bracket without inventing source punctuation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response([meta(bracketMetadata), frame(1, wav()), frame(0)])),
		);
		const h = harness();
		h.begin("[code block]");
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(1));
		const ctx = h.clock();
		ctx.currentTime = ctx.outputStampTime = ctx.nodes[0].startedAt + 0.9;
		h.speaker.stop();
		expect(h.reports[0]).toMatchObject({
			text: "[code",
			uncertain: false,
			submittedTexts: ["[code block]"],
		});
		expect(h.error).not.toHaveBeenCalled();
		h.speaker.close();
	});

	it("retains known words on both sides of an unreconciled played chunk, with an explicit gap", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(response())
			.mockResolvedValueOnce(response([meta(priceMetadata), frame(1, wav(49800)), frame(0)]))
			.mockResolvedValueOnce(response());
		vi.stubGlobal("fetch", fetch);
		const h = harness();
		h.speaker.beginUtterance("turn-one", 0, (r) => h.reports.push(r));
		for (const text of ["Hello world.", "It costs $5.00.", "Hello world."])
			h.speaker.enqueueSegment(text);
		h.speaker.finishUtterance();
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(3));
		const ctx = h.clock();
		ctx.currentTime = ctx.outputStampTime = ctx.nodes[0].startedAt + 109200 / 24000;
		h.speaker.stop();
		expect(h.reports[0]).toMatchObject({
			text: "Hello world. [UNKNOWN_WORDS:audio_samples=37800–87600] Hello",
			uncertain: true,
			complete: false,
		});
		expect(h.reports[0].text).not.toContain("5.00");
		expect(h.reports[0].issues?.join(" ")).toContain("words unknown");
		expect(h.error).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(3);
		h.speaker.close();
	});

	it.each([
		0, 21600,
	])("does not taint %s played samples with an unknown chunk still queued", async (samples) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response())
				.mockResolvedValueOnce(response([meta(priceMetadata), frame(1, wav(49800)), frame(0)])),
		);
		const h = harness();
		h.speaker.beginUtterance("turn-one", 0, (r) => h.reports.push(r));
		h.speaker.enqueueSegment("Hello world.");
		h.speaker.enqueueSegment("It costs $5.00.");
		h.speaker.finishUtterance();
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(2));
		const ctx = h.clock();
		ctx.currentTime = ctx.outputStampTime = ctx.nodes[0].startedAt + samples / 24000;
		h.speaker.stop();
		expect(h.reports[0]).toMatchObject({ text: samples ? "Hello" : "", uncertain: false });
		expect(h.error).not.toHaveBeenCalled();
		h.speaker.close();
	});

	it.each([
		"incomplete",
		"unaligned",
		"changed words",
	])("plays %s mappings without claiming their words", async (kind) => {
		const m = {
			...metadata,
			...(kind === "incomplete"
				? { alignmentComplete: false }
				: kind === "unaligned"
					? { unalignedTokens: ["world"] }
					: { words: [{ ...metadata.words[0], text: "Riley" }] }),
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response([meta(m), frame(1, wav()), frame(0)])),
		);
		const h = harness();
		h.begin();
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(1));
		const ctx = h.clock();
		ctx.currentTime = ctx.outputStampTime = ctx.nodes[0].startedAt + 0.9;
		h.speaker.stop();
		expect(h.reports[0]).toMatchObject({ complete: false, uncertain: true });
		expect(h.reports[0].text).toContain("UNKNOWN_WORDS");
		expect(h.reports[0].text).not.toContain("Riley");
		expect(formatKokoroPlayedHistory(h.reports[0])).toContain("not spoken text");
		expect(h.error).not.toHaveBeenCalled();
		h.speaker.close();
	});

	it.each([
		"missing negotiation",
		"missing timings",
		"missing END",
		"wrong input",
		"truncated frame",
	])("fails honestly for %s", async (kind) => {
		const parts =
			kind === "missing timings"
				? [frame(1, wav()), frame(0)]
				: kind === "wrong input"
					? [
							meta({ ...metadata, submittedText: "Invented chat fallback" }),
							frame(1, wav()),
							frame(0),
						]
					: kind === "truncated frame"
						? [meta().slice(0, 10)]
						: [meta(), frame(1, wav())];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				kind === "missing negotiation" ? new Response("old backend") : response(parts),
			),
		);
		const h = harness();
		h.begin();
		await vi.waitFor(() => expect(h.error).toHaveBeenCalled());
		expect(h.reports[0]).toMatchObject({ text: "", playedMs: 0, complete: false, uncertain: true });
		h.speaker.close();
	});

	it("rebases word ranges across multiple 380-character wire segments", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response()),
		);
		const h = harness();
		h.speaker.beginUtterance("turn-one", 0, (r) => h.reports.push(r));
		h.speaker.enqueueSegment("Hello world.");
		h.speaker.enqueueSegment("Hello world.");
		h.speaker.finishUtterance();
		await vi.waitFor(() => expect(h.clock().nodes).toHaveLength(2));
		const ctx = h.clock();
		ctx.currentTime = ctx.outputStampTime = ctx.nodes[0].startedAt + 1.575 + 0.9;
		h.speaker.stop();
		expect(h.reports[0].text).toBe("Hello world. Hello");
		expect(h.reports[0].submittedTexts).toEqual(["Hello world.", "Hello world."]);
		h.speaker.close();
	});

	it("bounds frame sizes and rejects unreliable token/audio mappings", () => {
		const parser = new KokoroFrames();
		const bad = new Uint8Array(5);
		new DataView(bad.buffer).setUint32(1, 12000001, true);
		expect(() => parser.push(bad)).toThrow("bound");
		expect(() =>
			validateKokoroAlignment(
				{ ...metadata, words: [{ ...metadata.words[0], endSample: 999999 }] },
				"Hello world.",
				0,
			),
		).toThrow("range");
		expect(
			hasReliableKokoroWords(
				validateKokoroAlignment({ ...metadata, text: "Riley" }, "Hello world.", 0),
			),
		).toBe(false);
		for (const [source, tokenText] of [
			["Hello   world.", "Hello world."],
			["Hello (world).", "Hello world."],
			["1.5", "15"],
			["$5", "5"],
			["five", "5"],
			["don't", "dont"],
			["foo[bar]", "foobar"],
		]) {
			const m = {
				...metadata,
				text: source,
				words: [{ ...metadata.words[0], text: tokenText, whitespace: "" }],
			};
			expect(hasReliableKokoroWords(validateKokoroAlignment(m, "Hello world.", 0))).toBe(
				source.startsWith("Hello"),
			);
		}
	});
});

describe("Relay engine preference", () => {
	it("defaults to Kokoro without migrating explicit saved selections, and switches back in one step", () => {
		expect(DEFAULT_RELAY_VOICE_ENGINE).toBe("kokoro");
		expect(resolveRelayVoiceEngine(null)).toBe("kokoro");
		for (const saved of ["lfm-tts", "legacy", "server4"] as const)
			expect(resolveRelayVoiceEngine(saved)).toBe(saved);
		expect(resolveRelayVoiceEngine("kokoro", "lfm-tts")).toBe("lfm-tts");
		expect(resolveRelayVoiceEngine("lfm-tts", "kokoro")).toBe("kokoro");
	});
});
