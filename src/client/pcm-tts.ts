/** Progressive PCM scheduling with synthesis-aligned playback evidence. */

function declarePlaybackAudioSession(): void {
	if (typeof navigator === "undefined") return;
	const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
	if (session) session.type = "playback";
}

const OUTPUT_RATE = 24_000;
const MAX_QUEUED_SEGMENTS = 40;
const MAX_QUEUED_CHARS = 10_000;

export interface PcmPlayedReport {
	utterance: string;
	playedMs: number;
	playedSamples?: number;
	text: string;
	complete: boolean;
	uncertain: boolean;
	/** Present only for synthesis-aligned transports, never inferred by the player. */
	alignment?: string;
	submittedTexts?: string[];
	issues?: string[];
}

export interface PcmUtteranceMetrics {
	ttsFirstPcmClientMs: number | null;
	scheduledPlaybackMs: number | null;
}

export class PlayedAudioClock {
	private parts: Array<{ start: number; duration: number }> = [];

	reset(): void {
		this.parts = [];
	}

	add(start: number, duration: number): void {
		if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
			this.parts.push({ start, duration });
		}
	}

	isPlaying(clockSeconds: number): boolean {
		return this.parts.some(
			(part) => clockSeconds >= part.start && clockSeconds < part.start + part.duration,
		);
	}

	samples(clockSeconds: number, rate = OUTPUT_RATE): number {
		let total = 0;
		if (!Number.isFinite(clockSeconds)) return 0;
		for (const part of this.parts) {
			total += Math.max(0, Math.min(part.duration, clockSeconds - part.start));
		}
		const samples = total * rate;
		return Math.floor(samples + Number.EPSILON * Math.max(1, samples) * 4);
	}

	milliseconds(clockSeconds: number): number {
		if (!Number.isFinite(clockSeconds) || clockSeconds <= 0) return 0;
		let total = 0;
		for (const part of this.parts) {
			total += Math.max(0, Math.min(part.duration, clockSeconds - part.start));
		}
		return Math.floor(total * 1000);
	}
}

export function decodeFramedPcm16(
	bytes: ArrayBuffer,
): { epoch: number; samples: Float32Array } | null {
	if (bytes.byteLength < 6 || (bytes.byteLength - 4) % 2 !== 0) return null;
	const view = new DataView(bytes);
	const epoch = view.getUint32(0, false);
	const count = (bytes.byteLength - 4) / 2;
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		samples[i] = view.getInt16(4 + i * 2, true) / 32768;
	}
	return { epoch, samples };
}

interface ActiveUtterance {
	epoch: number;
	id: string;
	turnStartedAt: number;
	nextSeq: number;
	segments: number;
	chars: number;
	queuedForSend: Array<{ seq: number; text: string }>;
	endQueued: boolean;
	endSent: boolean;
	sentAny: boolean;
	serverDone: boolean;
	truncated: boolean;
	samplesReceived: number;
	preroll: Float32Array[];
	prerollSamples: number;
	startedPlayback: boolean;
	metrics: PcmUtteranceMetrics;
	onReport: (report: PcmPlayedReport) => void;
}

export interface PcmTtsSpeakerCallbacks {
	onStatus: (text: string) => void;
	onPlaying: (metrics: PcmUtteranceMetrics) => void;
	onMetrics?: (metrics: PcmUtteranceMetrics) => void;
	onIdle: () => void;
	onError: (error: unknown) => void;
}

/** Local adapter between HTTP synthesis streams and the PCM player. */
export interface TtsTransport {
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
	send(data: string): void;
	close(): void;
	playedPrefix: (
		epoch: number,
		samples: number,
		interrupted: boolean,
		truncated: boolean,
	) => Omit<PcmPlayedReport, "utterance">;
}

export class PcmTtsSpeaker {
	private context: AudioContext | null = null;
	private ws: TtsTransport | null = null;
	private alignedReporter?: TtsTransport["playedPrefix"];
	private wsReady = false;
	private connecting = false;
	private closed = false;
	private paused = false;
	private connGen = 0;
	private epoch = 0;
	private active: ActiveUtterance | null = null;
	private nodes = new Set<AudioBufferSourceNode>();
	private nextAt = 0;
	private played = new PlayedAudioClock();
	private finishTimer: ReturnType<typeof setTimeout> | null = null;
	private lastInterruptTickAt = -Infinity;

	private readonly outputRate: number;
	private readonly prerollTarget: number;
	private readonly maxUtteranceSamples: number;

	constructor(
		private readonly callbacks: PcmTtsSpeakerCallbacks,
		private readonly transportOptions: {
			create: () => TtsTransport;
			label: string;
			outputRate?: number;
		},
	) {
		this.outputRate = transportOptions.outputRate ?? OUTPUT_RATE;
		this.prerollTarget = Math.round(this.outputRate * 0.1);
		this.maxUtteranceSamples = this.outputRate * 180;
	}

	private ensureAudioContext(): AudioContext {
		if (!this.context) {
			declarePlaybackAudioSession();
			this.context = new AudioContext();
		}
		if (!this.paused && this.context.state !== "running") {
			void this.context.resume().catch(this.callbacks.onError);
		}
		return this.context;
	}

	private outputClock(): number {
		const ctx = this.context;
		if (!ctx) return 0;
		const stamp = ctx.getOutputTimestamp?.();
		if (
			stamp &&
			typeof stamp.performanceTime === "number" &&
			stamp.performanceTime > 0 &&
			typeof stamp.contextTime === "number" &&
			stamp.contextTime > 0
		) {
			return stamp.contextTime;
		}
		const outLatency =
			(ctx as AudioContext & { outputLatency?: number }).outputLatency || ctx.baseLatency || 0;
		return Math.max(0, ctx.currentTime - outLatency);
	}

	connect(): void {
		if (this.closed || this.wsReady || this.connecting) return;
		this.ensureAudioContext();
		this.connecting = true;
		const gen = ++this.connGen;
		const socket = this.transportOptions.create();
		this.ws = socket;
		this.alignedReporter = socket.playedPrefix.bind(socket);

		socket.onmessage = (event) => {
			if (gen !== this.connGen || this.closed) return;
			if (event.data instanceof ArrayBuffer) {
				this.handleBinary(event.data);
				return;
			}
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(String(event.data)) as Record<string, unknown>;
			} catch {
				return;
			}
			const type = msg.type;
			if (type === "ready") {
				if (msg.protocol !== 3 || msg.tts !== 1 || msg.outputRate !== this.outputRate) {
					this.failConnection(
						new Error(`${this.transportOptions.label} player protocol mismatch. Refresh ACB.`),
					);
					return;
				}
				this.connecting = false;
				this.wsReady = true;
				if (this.active) this.flushSendQueue();
				else this.callbacks.onIdle();
			} else if (type === "utterance_done") {
				if (this.active && msg.epoch === this.active.epoch) {
					this.active.serverDone = true;
					this.flushPreroll(true);
					this.checkPlaybackComplete();
				}
			} else if (type === "error") {
				this.failConnection(
					new Error(
						typeof msg.message === "string"
							? msg.message
							: `${this.transportOptions.label} failed.`,
					),
				);
			}
		};
	}

	private failConnection(error: Error): void {
		this.connGen++;
		const old = this.ws;
		this.ws = null;
		this.wsReady = false;
		this.connecting = false;
		try {
			old?.close();
		} catch {
			/* ignore */
		}
		if (this.active) this.abortActiveLocally();
		this.callbacks.onError(error);
	}

	beginUtterance(
		utteranceId: string,
		turnStartedAt: number,
		onReport: (report: PcmPlayedReport) => void,
	): void {
		if (this.closed) return;
		if (this.active) {
			this.stop();
		}
		this.ensureAudioContext();
		const epoch = ++this.epoch;
		this.played.reset();
		this.nextAt = 0;
		this.active = {
			epoch,
			id: utteranceId,
			turnStartedAt,
			nextSeq: 0,
			segments: 0,
			chars: 0,
			queuedForSend: [],
			endQueued: false,
			endSent: false,
			sentAny: false,
			serverDone: false,
			truncated: false,
			samplesReceived: 0,
			preroll: [],
			prerollSamples: 0,
			startedPlayback: false,
			metrics: {
				ttsFirstPcmClientMs: null,
				scheduledPlaybackMs: null,
			},
			onReport,
		};
		this.connect();
	}

	enqueueSegment(text: string): void {
		const utt = this.active;
		if (!utt || this.closed || utt.endQueued) return;
		const cleaned = text.trim();
		if (!cleaned) return;
		if (utt.segments >= MAX_QUEUED_SEGMENTS || utt.chars + cleaned.length > MAX_QUEUED_CHARS) {
			utt.truncated = true;
			utt.endQueued = true;
			this.callbacks.onStatus(
				"Long answer truncated in voice playback; read the full formatted reply in chat.",
			);
			this.flushSendQueue();
			return;
		}
		const seq = utt.nextSeq++;
		utt.segments++;
		utt.chars += cleaned.length;
		const bounded = cleaned
			.slice(0, 380)
			.replace(/[\uD800-\uDBFF]$/, "")
			.trimEnd();
		if (bounded !== cleaned) utt.truncated = true;
		utt.queuedForSend.push({ seq, text: bounded });
		this.flushSendQueue();
	}

	finishUtterance(): void {
		const utt = this.active;
		if (!utt || this.closed) return;
		utt.endQueued = true;
		if (utt.segments === 0 && utt.queuedForSend.length === 0) {
			// Nothing speakable was emitted (e.g. code-only or empty turn).
			this.active = null;
			this.reportPlayback(utt, 0, false, 0);
			this.callbacks.onIdle();
			return;
		}
		this.flushSendQueue();
	}

	private flushSendQueue(): void {
		const utt = this.active;
		if (!utt || !this.wsReady || !this.ws) return;
		while (utt.queuedForSend.length > 0) {
			const item = utt.queuedForSend.shift()!;
			utt.sentAny = true;
			this.ws.send(
				JSON.stringify({
					type: "speak",
					epoch: utt.epoch,
					utterance: utt.id,
					seq: item.seq,
					text: item.text,
				}),
			);
		}
		if (utt.endQueued && !utt.endSent && utt.sentAny) {
			utt.endSent = true;
			this.ws.send(
				JSON.stringify({
					type: "end",
					epoch: utt.epoch,
					utterance: utt.id,
				}),
			);
		}
	}

	private handleBinary(data: ArrayBuffer): void {
		const utt = this.active;
		if (!utt) return;
		const decoded = decodeFramedPcm16(data);
		if (!decoded || decoded.epoch !== utt.epoch) return; // Strict epoch fencing!
		let { samples } = decoded;
		if (utt.samplesReceived >= this.maxUtteranceSamples) {
			utt.truncated = true;
			return;
		}
		if (utt.samplesReceived + samples.length > this.maxUtteranceSamples) {
			samples = samples.subarray(0, this.maxUtteranceSamples - utt.samplesReceived);
			utt.truncated = true;
		}
		utt.samplesReceived += samples.length;
		if (utt.metrics.ttsFirstPcmClientMs === null) {
			utt.metrics.ttsFirstPcmClientMs = Math.max(0, performance.now() - utt.turnStartedAt);
			this.callbacks.onMetrics?.(utt.metrics);
		}
		if (!utt.startedPlayback) {
			utt.preroll.push(samples);
			utt.prerollSamples += samples.length;
			if (utt.prerollSamples >= this.prerollTarget || utt.serverDone) {
				this.flushPreroll(true);
			}
			return;
		}
		this.scheduleSamples(utt, samples);
	}

	private flushPreroll(force = false): void {
		const utt = this.active;
		if (!utt || utt.prerollSamples === 0) return;
		if (!force && utt.prerollSamples < this.prerollTarget && !utt.serverDone) return;
		const merged = new Float32Array(utt.prerollSamples);
		let offset = 0;
		for (const chunk of utt.preroll) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		utt.preroll = [];
		utt.prerollSamples = 0;
		this.scheduleSamples(utt, merged);
	}

	private scheduleSamples(utt: ActiveUtterance, samples: Float32Array): void {
		if (!samples.length || !this.context) return;
		const ctx = this.context;
		if (!this.paused && ctx.state === "suspended") {
			void ctx.resume().catch(() => {});
		}
		const buffer = ctx.createBuffer(1, samples.length, this.outputRate);
		buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
		const node = ctx.createBufferSource();
		node.buffer = buffer;
		node.connect(ctx.destination);
		const at = Math.max(ctx.currentTime + 0.025, this.nextAt);
		node.start(at);
		this.nextAt = at + buffer.duration;
		this.played.add(at, buffer.duration);
		this.nodes.add(node);
		if (!utt.startedPlayback) {
			utt.startedPlayback = true;
			utt.metrics.scheduledPlaybackMs = Math.max(0, performance.now() - utt.turnStartedAt);
			this.callbacks.onPlaying(utt.metrics);
		}
		const epoch = utt.epoch;
		node.onended = () => {
			this.nodes.delete(node);
			node.disconnect();
			if (this.active?.epoch === epoch) {
				this.checkPlaybackComplete();
			}
		};
	}

	private stopAudioNodes(): void {
		if (this.finishTimer) {
			clearTimeout(this.finishTimer);
			this.finishTimer = null;
		}
		for (const node of this.nodes) {
			node.onended = null;
			try {
				node.stop();
			} catch {
				/* already ended */
			}
			node.disconnect();
		}
		this.nodes.clear();
		this.nextAt = 0;
	}

	private checkPlaybackComplete(): void {
		const utt = this.active;
		if (this.paused || !utt?.serverDone || utt.prerollSamples > 0 || this.nodes.size > 0) return;
		const remaining = this.nextAt - this.outputClock();
		if (remaining > 0.008) {
			if (this.finishTimer) clearTimeout(this.finishTimer);
			this.finishTimer = setTimeout(
				() => this.checkPlaybackComplete(),
				Math.max(15, Math.ceil(remaining * 1000) + 15),
			);
			return;
		}
		const finished = utt;
		const clock = this.outputClock();
		const playedMs = this.played.milliseconds(clock);
		const playedSamples = this.played.samples(clock, this.outputRate);
		this.active = null;
		this.played.reset();
		this.nextAt = 0;
		this.reportPlayback(finished, playedMs, false, playedSamples);
		this.callbacks.onIdle();
	}

	private reportPlayback(
		utt: ActiveUtterance,
		playedMs: number,
		interrupted: boolean,
		samples: number,
	): void {
		const report = this.alignedReporter?.(utt.epoch, samples, interrupted, utt.truncated) ?? {
			playedMs,
			text: "",
			complete: false,
			uncertain: playedMs > 0,
		};
		this.ws?.send(JSON.stringify({ type: interrupted ? "cancel" : "played", epoch: utt.epoch }));
		utt.onReport({ ...report, utterance: utt.id });
	}

	private abortActiveLocally(): void {
		const utt = this.active;
		if (!utt) return;
		const clock = this.outputClock();
		const playedMs = this.played.milliseconds(clock);
		const playedSamples = this.played.samples(clock, this.outputRate);
		this.stopAudioNodes();
		this.played.reset();
		this.active = null;
		this.reportPlayback(utt, playedMs, true, playedSamples);
	}

	get hasAudio(): boolean {
		return Boolean(this.active) || this.nodes.size > 0;
	}

	/** Freeze the output clock and scheduled PCM; incoming audio keeps its existing bounds. */
	async pause(): Promise<void> {
		if (this.closed) return;
		this.paused = true;
		if (this.finishTimer) {
			clearTimeout(this.finishTimer);
			this.finishTimer = null;
		}
		await this.ensureAudioContext().suspend();
	}

	async resume(): Promise<void> {
		if (this.closed) return;
		await this.context?.resume();
		if (this.closed) return;
		this.paused = false;
		this.checkPlaybackComplete();
	}

	/** Local speech-detection acknowledgement, separate from TTS and heard-prefix evidence. */
	private acknowledgeInterruption(): void {
		const ctx = this.context;
		const now = performance.now();
		// Never queue a delayed cue behind autoplay, pause or a suspended audio clock.
		if (this.closed || this.paused || !ctx || ctx.state !== "running") return;
		if (now - this.lastInterruptTickAt < 1_000) return;
		this.lastInterruptTickAt = now;
		try {
			const length = 720; // 30 ms at 24 kHz; fades at both ends to avoid clicks.
			const samples = new Float32Array(length);
			for (let i = 0; i < length; i++) {
				const envelope = Math.sin((Math.PI * i) / (length - 1)) ** 2;
				samples[i] = 0.12 * envelope * Math.sin((2 * Math.PI * 1_200 * i) / OUTPUT_RATE);
			}
			const buffer = ctx.createBuffer(1, length, OUTPUT_RATE);
			buffer.copyToChannel(samples, 0);
			const cue = ctx.createBufferSource();
			cue.buffer = buffer;
			cue.connect(ctx.destination);
			cue.onended = () => cue.disconnect();
			// Not in this.nodes or this.played: speech cancellation/history must not include the cue.
			cue.start(ctx.currentTime);
		} catch {
			// Feedback is best-effort; it must never interfere with speech capture or stopping TTS.
		}
	}

	/** Interrupt speech only; keeps the local transport available and never aborts Pi work. */
	stop(acknowledge = false): void {
		const interruptedPlayback =
			acknowledge && this.context?.state === "running" && this.played.isPlaying(this.outputClock());
		if (!this.active) {
			this.stopAudioNodes();
			this.played.reset();
			return;
		}
		this.abortActiveLocally();
		if (interruptedPlayback) this.acknowledgeInterruption();
	}

	/** Release the local synthesis transport (e.g. when tab hides or voice closes). */
	disconnect(): void {
		if (this.active) {
			this.abortActiveLocally();
		} else {
			this.stopAudioNodes();
			this.played.reset();
		}
		this.connGen++;
		this.wsReady = false;
		this.connecting = false;
		const old = this.ws;
		this.ws = null;
		try {
			old?.close();
		} catch {
			/* ignore */
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.disconnect();
		const ctx = this.context;
		this.context = null;
		if (ctx) void ctx.close().catch(() => {});
	}
}
