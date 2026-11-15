/** Relay-only synthesis alignment transport; shared player owns the output clock. */
import {
	KOKORO_ALIGNMENT,
	type KokoroAlignment,
	type KokoroWord,
	type RelaySynthesisAlignment,
	ZONOS3_ALIGNMENT,
	ZONOS3_SAMPLE_RATE,
	type Zonos3Alignment,
} from "../shared/kokoro.js";
import {
	type LfmPlayedReport,
	LfmTtsSpeaker,
	type LfmTtsSpeakerCallbacks,
	type TtsTransport,
} from "./lfm-tts.js";

const RATE = 24_000;
const MAX_FRAME = 12_000_000;

export interface AlignedTtsConfig {
	endpoint: string;
	alignmentHeader: string;
	alignmentValue: RelaySynthesisAlignment["alignment"];
	sampleRate: RelaySynthesisAlignment["sampleRate"];
	audioFormat: "wav" | "pcm16";
	label: string;
	shortLabel: string;
}

export const KOKORO_TTS_CONFIG: AlignedTtsConfig = {
	endpoint: "/api/tts/relay-stream",
	alignmentHeader: "X-Kokoro-Alignment",
	alignmentValue: KOKORO_ALIGNMENT,
	sampleRate: RATE,
	audioFormat: "wav",
	label: "Server2 Kokoro",
	shortLabel: "Kokoro",
};

export const ZONOS3_TTS_CONFIG: AlignedTtsConfig = {
	endpoint: "/api/tts/zonos-relay-stream",
	alignmentHeader: "X-Zonos-Alignment",
	alignmentValue: ZONOS3_ALIGNMENT,
	sampleRate: ZONOS3_SAMPLE_RATE,
	audioFormat: "pcm16",
	label: "Server2 ZONOS3-Mini",
	shortLabel: "ZONOS3-Mini",
};

/** Handles arbitrary HTTP chunk boundaries, bounded before allocating payloads. */
export class KokoroFrames {
	private pending = new Uint8Array(0);
	push(bytes: Uint8Array): Array<{ type: number; payload: Uint8Array }> {
		if (this.pending.length + bytes.length > MAX_FRAME + 5)
			throw new Error("Kokoro stream buffer exceeded");
		const combined = new Uint8Array(this.pending.length + bytes.length);
		combined.set(this.pending);
		combined.set(bytes, this.pending.length);
		let offset = 0;
		const frames = [];
		while (combined.length - offset >= 5) {
			const type = combined[offset];
			const length = new DataView(combined.buffer, offset + 1, 4).getUint32(0, true);
			if (length > MAX_FRAME) throw new Error("Kokoro frame exceeds the playback bound");
			if (combined.length - offset < 5 + length) break;
			frames.push({ type, payload: combined.slice(offset + 5, offset + 5 + length) });
			offset += 5 + length;
		}
		this.pending = combined.slice(offset);
		if (this.pending.length > MAX_FRAME + 5) throw new Error("Kokoro stream buffer exceeded");
		return frames;
	}
	finish(): void {
		if (this.pending.length) throw new Error("Truncated Kokoro stream frame");
	}
}

/** Read PCM without decodeAudioData/resampling: timing units stay exactly 24 kHz. */
export function kokoroWavPcm(bytes: Uint8Array): Uint8Array {
	const ascii = (at: number, length: number) =>
		String.fromCharCode(...bytes.subarray(at, at + length));
	if (bytes.length < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE")
		throw new Error("Invalid Kokoro WAV");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let validFormat = false;
	let pcm: Uint8Array | undefined;
	for (let offset = 12; offset + 8 <= bytes.length; ) {
		const size = view.getUint32(offset + 4, true);
		const start = offset + 8;
		if (start + size > bytes.length) throw new Error("Truncated Kokoro WAV");
		if (ascii(offset, 4) === "fmt ") {
			validFormat =
				size >= 16 &&
				view.getUint16(start, true) === 1 &&
				view.getUint16(start + 2, true) === 1 &&
				view.getUint32(start + 4, true) === RATE &&
				view.getUint16(start + 12, true) === 2 &&
				view.getUint16(start + 14, true) === 16;
		}
		if (ascii(offset, 4) === "data") pcm = bytes.slice(start, start + size);
		offset = start + size + (size % 2);
	}
	if (!validFormat || !pcm?.length || pcm.length % 2)
		throw new Error("Kokoro must return mono 24 kHz PCM16");
	return pcm;
}

export function validateSynthesisAlignment<T extends RelaySynthesisAlignment>(
	value: unknown,
	submitted: string,
	offset: number,
	options: {
		alignment: T["alignment"];
		sampleRate: T["sampleRate"];
		minWordSample?: number;
		allowEmptyChunk?: boolean;
		shortLabel?: string;
	},
): T {
	const m = value as T | null;
	const label = options.shortLabel ?? "Kokoro";
	const validEnd =
		m &&
		Number.isSafeInteger(m.endSample) &&
		(options.allowEmptyChunk
			? m.endSample > offset ||
				(m.endSample === offset && Array.isArray(m.words) && m.words.length > 0)
			: m.endSample > offset);
	if (
		!m ||
		m.alignment !== options.alignment ||
		m.sampleRate !== options.sampleRate ||
		m.submittedText !== submitted ||
		m.startSample !== offset ||
		!validEnd ||
		!Array.isArray(m.unalignedTokens) ||
		!Array.isArray(m.words) ||
		typeof m.text !== "string"
	)
		throw new Error(`Missing or unreliable ${label} synthesis alignment`);
	let end = options.minWordSample ?? offset;
	for (const word of m.words) {
		if (
			typeof word.text !== "string" ||
			!word.text ||
			typeof word.whitespace !== "string" ||
			!/^\s*$/.test(word.whitespace) ||
			!Number.isSafeInteger(word.startSample) ||
			!Number.isSafeInteger(word.endSample) ||
			word.startSample < end ||
			word.endSample < word.startSample ||
			word.endSample > m.endSample
		)
			throw new Error(`Invalid ${label} word sample range`);
		end = word.endSample;
	}
	return m;
}

export function validateKokoroAlignment(
	value: unknown,
	submitted: string,
	offset: number,
): KokoroAlignment {
	return validateSynthesisAlignment<KokoroAlignment>(value, submitted, offset, {
		alignment: KOKORO_ALIGNMENT,
		sampleRate: RATE,
		minWordSample: offset,
		allowEmptyChunk: false,
		shortLabel: "Kokoro",
	});
}

export function validateZonosAlignment(
	value: unknown,
	submitted: string,
	offset: number,
	minWordSample = 0,
): Zonos3Alignment {
	return validateSynthesisAlignment<Zonos3Alignment>(value, submitted, offset, {
		alignment: ZONOS3_ALIGNMENT,
		sampleRate: ZONOS3_SAMPLE_RATE,
		minWordSample,
		allowEmptyChunk: true,
		shortLabel: "ZONOS3-Mini",
	});
}

/** Reconcile presentation only, never currency, numeric expansion or new words. */
export function hasReliableKokoroWords(m: RelaySynthesisAlignment): boolean {
	if (m.alignmentComplete !== true || m.unalignedTokens.length || !m.words.length) return false;
	const space = (text: string) => text.replace(/\s+/gu, " ").trim();
	const tokens = m.words.map((word) => word.text + word.whitespace).join("");
	if (space(tokens) === space(m.text)) return true;
	// Brackets/quotes are separators, not deletions that could fuse two words.
	// Numeric/symbol-bearing chunks stay strict: punctuation can change a value.
	if (/[\p{N}$%+*=<>/−-]/u.test(m.text + tokens)) return false;
	const sequence = (text: string) =>
		(
			text.replace(/[[\](){}"“”]/gu, " ").match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|[^\s]/gu) ?? []
		).join("\0");
	return sequence(tokens) === sequence(m.text);
}

interface TimedChunk {
	startSample: number;
	endSample: number;
	words: KokoroWord[] | null;
}

interface Ledger {
	chunks: TimedChunk[];
	submitted: string[];
	samples: number;
	finished: boolean;
	issues: string[];
	controller: AbortController;
	queue: Array<{ text: string; seq: number }>;
	end: boolean;
	running: boolean;
}

export function completedKokoroWords(words: KokoroWord[], playedSamples: number): string {
	let text = "";
	if (playedSamples <= 0) return text;
	for (const word of words) {
		if (word.endSample > playedSamples) break;
		text += word.text + word.whitespace;
	}
	return text.trim();
}

export function formatKokoroPlayedHistory(report: LfmPlayedReport): string {
	const engineLabel = report.alignment === ZONOS3_ALIGNMENT ? "ZONOS3-Mini" : "Kokoro";
	let text = report.text.trim();
	const build = (omitted = false) => {
		const state = report.complete ? "completed" : "interrupted/stopped";
		const issues = report.issues?.length
			? `; ${report.issues
					.slice(0, 3)
					.map((issue) => issue.slice(0, 200))
					.join("; ")}`
			: "";
		const prefix = text
			? `${omitted ? "[Earlier completed input words omitted] " : ""}${text}`
			: "none";
		return `${engineLabel} synthesis alignment (${report.playedMs} ms played, ${state}${report.uncertain ? "; incomplete/uncertain" : ""}${issues}): ${prefix}\nPronunciation not verified; playback is not proof the owner heard it. Only timed input tokens whose end sample passed the output clock are retained; bracketed UNKNOWN entries describe gaps, not spoken text. ${(report.playedSamples ?? report.playedMs) <= 0 ? "No generated speech was played. " : ""}Do not assume remaining generated text was played. Tools/workers continue.`;
	};
	let formatted = build();
	while (
		formatted.length > 16000 ||
		new TextEncoder().encode(JSON.stringify({ text: formatted })).length > 17000
	) {
		// History bounds must not turn a completed input word into a fake fragment.
		text = text
			.slice(1024)
			.replace(/^\S*\s*/u, "")
			.trim();
		formatted = build(true);
	}
	return formatted;
}

/** Adapts the negotiated HTTP stream to the existing progressive PCM player. */
export class KokoroTtsTransport implements TtsTransport {
	readyState = 1;
	bufferedAmount = 0;
	onmessage: TtsTransport["onmessage"] = null;
	onerror: TtsTransport["onerror"] = null;
	onclose: TtsTransport["onclose"] = null;
	private ledgers = new Map<number, Ledger>();
	private readonly config: AlignedTtsConfig;
	constructor(configOrEndpoint: string | AlignedTtsConfig = KOKORO_TTS_CONFIG) {
		this.config =
			typeof configOrEndpoint === "string"
				? { ...KOKORO_TTS_CONFIG, endpoint: configOrEndpoint }
				: configOrEndpoint;
		queueMicrotask(() =>
			this.emit({ type: "ready", protocol: 3, tts: 1, outputRate: this.config.sampleRate }),
		);
	}
	private emit(message: unknown): void {
		if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) });
	}
	send(data: string): void {
		if (this.readyState !== 1) return;
		const msg = JSON.parse(data) as { type: string; epoch: number; text: string; seq: number };
		let ledger = this.ledgers.get(msg.epoch);
		if (msg.type === "speak") {
			if (!ledger) {
				ledger = {
					chunks: [],
					submitted: [],
					samples: 0,
					finished: false,
					issues: [],
					controller: new AbortController(),
					queue: [],
					end: false,
					running: false,
				};
				this.ledgers.set(msg.epoch, ledger);
			}
			ledger.queue.push({ text: msg.text, seq: msg.seq });
			void this.pump(msg.epoch, ledger);
		} else if (msg.type === "end" && ledger) {
			ledger.end = true;
			void this.pump(msg.epoch, ledger);
		} else if ((msg.type === "cancel" || msg.type === "played") && ledger) {
			ledger.controller.abort();
			ledger.queue = [];
			this.ledgers.delete(msg.epoch);
		}
	}
	playedPrefix(
		epoch: number,
		playedSamples: number,
		interrupted: boolean,
		truncated: boolean,
	): Omit<LfmPlayedReport, "utterance"> {
		const ledger = this.ledgers.get(epoch);
		const issues = [...(ledger?.issues ?? [])];
		if (truncated)
			issues.push("voice input/audio truncated; full chat text was not synthesised/played");
		const samples = Math.max(0, Math.min(playedSamples, ledger?.samples ?? 0));
		const playedChunks = (ledger?.chunks ?? []).filter((chunk) =>
			chunk.words !== null
				? samples > 0 && chunk.startSample <= samples
				: chunk.startSample < samples,
		);
		const unknown = playedChunks.filter((chunk) => chunk.words === null);
		if (unknown.length)
			issues.push(`words unknown for ${unknown.length} played chunk(s); no inferred words`);
		const text = playedChunks
			.map((chunk) =>
				chunk.words
					? completedKokoroWords(chunk.words, samples)
					: `[UNKNOWN_WORDS:audio_samples=${chunk.startSample}–${Math.min(samples, chunk.endSample)}]`,
			)
			.filter(Boolean)
			.join(" ");
		return {
			playedMs: Math.floor((samples * 1000) / this.config.sampleRate),
			playedSamples: samples,
			text,
			complete: !interrupted && !truncated && ledger?.finished === true && !issues.length,
			uncertain: issues.length > 0,
			alignment: this.config.alignmentValue,
			submittedTexts: [...(ledger?.submitted ?? [])],
			issues,
		};
	}
	private async pump(epoch: number, ledger: Ledger): Promise<void> {
		if (ledger.running || ledger.controller.signal.aborted) return;
		ledger.running = true;
		try {
			while (ledger.queue.length && !ledger.controller.signal.aborted) {
				const item = ledger.queue.shift()!;
				const timeout = setTimeout(() => {
					ledger.issues.push(`${this.config.shortLabel} synthesis timed out`);
					this.emit({
						type: "error",
						message: `${this.config.shortLabel} synthesis timed out; Pi tools/workers continue.`,
					});
				}, 60_000);
				try {
					await this.synthesize(epoch, ledger, item.text);
				} finally {
					clearTimeout(timeout);
				}
			}
			if (ledger.end && !ledger.controller.signal.aborted) {
				ledger.finished = true;
				this.emit({ type: "utterance_done", epoch });
			}
		} catch (error) {
			if (!ledger.controller.signal.aborted) {
				ledger.issues.push(
					error instanceof Error
						? error.message.slice(0, 500)
						: `${this.config.shortLabel} synthesis failed`,
				);
				// The shared player stops speech and snapshots its output clock.
				this.emit({
					type: "error",
					message: `${this.config.shortLabel} speech stopped: ${ledger.issues.at(-1)}. Pi tools/workers continue.`,
				});
			}
		} finally {
			ledger.running = false;
		}
	}
	private async synthesize(epoch: number, ledger: Ledger, text: string): Promise<void> {
		const isPcm16 = this.config.audioFormat === "pcm16";
		const response = await fetch(this.config.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[this.config.alignmentHeader]: this.config.alignmentValue,
			},
			body: JSON.stringify({ text, speed: 1 }),
			signal: ledger.controller.signal,
		});
		if (
			!response.ok ||
			!response.body ||
			response.headers.get(this.config.alignmentHeader) !== this.config.alignmentValue
		)
			throw new Error(
				`${this.config.shortLabel} alignment negotiation failed; no ASR or whole-answer fallback`,
			);
		const reader = response.body.getReader();
		const frames = new KokoroFrames();
		const base = ledger.samples;
		let offset = 0;
		let wordOffset = 0;
		let metadata: RelaySynthesisAlignment | undefined;
		let ended = false;
		let remaining = text.replace(/\s+/g, " ").trim();
		let matchedChunk = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (ledger.controller.signal.aborted) return;
				for (const frame of frames.push(value)) {
					if (ended) throw new Error(`${this.config.shortLabel} data after END`);
					if (frame.type === 2) {
						if (metadata)
							throw new Error(`${this.config.shortLabel} metadata without matching audio`);
						metadata = validateSynthesisAlignment(
							JSON.parse(new TextDecoder().decode(frame.payload)),
							text,
							offset,
							{
								alignment: this.config.alignmentValue,
								sampleRate: this.config.sampleRate,
								minWordSample: isPcm16 ? wordOffset : offset,
								allowEmptyChunk: isPcm16,
								shortLabel: this.config.shortLabel,
							},
						);
						if (metadata.words.length > 0) {
							wordOffset = metadata.words[metadata.words.length - 1].endSample;
						}
						matchedChunk = metadata.text.replace(/\s+/g, " ").trim();
						if (matchedChunk === "") {
							if (!isPcm16 || metadata.words.length > 0 || metadata.text !== "")
								throw new Error(
									`${this.config.shortLabel} chunk does not match complete submitted input words`,
								);
						} else if (
							!remaining.startsWith(matchedChunk) ||
							(remaining.length > matchedChunk.length && !/\s/.test(remaining[matchedChunk.length]))
						) {
							throw new Error(
								`${this.config.shortLabel} chunk does not match complete submitted input words`,
							);
						}
						if (offset === 0) ledger.submitted.push(metadata.submittedText);
					} else if (frame.type === 1) {
						if (!metadata) throw new Error(`${this.config.shortLabel} audio missing word timings`);
						let pcm: Uint8Array;
						if (isPcm16) {
							if (frame.payload.length % 2 !== 0)
								throw new Error(
									`${this.config.shortLabel} must return mono ${this.config.sampleRate} Hz PCM16`,
								);
							pcm = frame.payload;
						} else {
							pcm = kokoroWavPcm(frame.payload);
						}
						if (metadata.endSample - metadata.startSample !== pcm.length / 2)
							throw new Error(`${this.config.shortLabel} timing/audio sample count mismatch`);
						const emptyPcm16Block =
							isPcm16 &&
							metadata.text === "" &&
							metadata.words.length === 0 &&
							metadata.alignmentComplete === true &&
							metadata.unalignedTokens.length === 0;
						const reliableWords: KokoroWord[] | null = emptyPcm16Block
							? []
							: hasReliableKokoroWords(metadata)
								? metadata.words.map((word) => ({
										...word,
										startSample: base + word.startSample,
										endSample: base + word.endSample,
									}))
								: null;
						if (pcm.length === 0) {
							const prev = ledger.chunks.at(-1);
							if (reliableWords !== null && prev && prev.words !== null) {
								prev.words.push(...reliableWords);
							} else {
								ledger.chunks.push({
									startSample: base + metadata.startSample,
									endSample: base + metadata.endSample,
									words: reliableWords,
								});
							}
						} else {
							ledger.chunks.push({
								startSample: base + metadata.startSample,
								endSample: base + metadata.endSample,
								words: reliableWords,
							});
							offset += pcm.length / 2;
							ledger.samples += pcm.length / 2;
							const bytes = new Uint8Array(4 + pcm.length);
							new DataView(bytes.buffer).setUint32(0, epoch, false);
							bytes.set(pcm, 4);
							this.onmessage?.({ data: bytes.buffer });
						}
						if (matchedChunk) remaining = remaining.slice(matchedChunk.length).trimStart();
						metadata = undefined;
						matchedChunk = "";
					} else if (frame.type === 0 && frame.payload.length === 0 && !metadata) {
						ended = true;
					} else if (frame.type === 128) {
						throw new Error(
							new TextDecoder().decode(frame.payload) ||
								`${this.config.shortLabel} synthesis failed`,
						);
					} else
						throw new Error(`Unknown/incomplete ${this.config.shortLabel} alignment stream frame`);
				}
			}
			frames.finish();
			if (!ended || !offset || remaining)
				throw new Error(`Truncated/incomplete ${this.config.shortLabel} synthesis input or stream`);
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	close(): void {
		this.readyState = 3;
		for (const ledger of this.ledgers.values()) ledger.controller.abort();
		// Retain ledgers briefly for the player's synchronous failure snapshot.
	}
}

export function createKokoroSpeaker(callbacks: LfmTtsSpeakerCallbacks): LfmTtsSpeaker {
	return new LfmTtsSpeaker(callbacks, "", {
		create: () => new KokoroTtsTransport(KOKORO_TTS_CONFIG),
		label: KOKORO_TTS_CONFIG.label,
	});
}

export function createZonosSpeaker(callbacks: LfmTtsSpeakerCallbacks): LfmTtsSpeaker {
	return new LfmTtsSpeaker(callbacks, "", {
		create: () => new KokoroTtsTransport(ZONOS3_TTS_CONFIG),
		label: ZONOS3_TTS_CONFIG.label,
		outputRate: ZONOS3_TTS_CONFIG.sampleRate,
	});
}
