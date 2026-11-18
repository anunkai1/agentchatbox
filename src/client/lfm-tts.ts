/**
 * Shared progressive 24 kHz PCM player. Default transport: Server4 LFM /tts
 * with unhinted ASR retention; Relay's Kokoro adapter supplies synthesis alignment.
 *
 * Transport and browser Web Audio scheduling only: Pi owns prompts, tools,
 * session state, and full formatted Markdown answers.
 */

function declarePlaybackAudioSession(): void {
	if (typeof navigator === "undefined") return;
	const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
	if (session) session.type = "playback";
}

const OUTPUT_RATE = 24_000;
const MAX_QUEUED_SEGMENTS = 40;
const MAX_QUEUED_CHARS = 10_000;

export interface LfmPlayedReport {
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

export interface LfmUtteranceMetrics {
	coldLoadMs: number | null;
	ttsFirstPcmServerMs: number | null;
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

export function formatLfmPlayedHistory(report: LfmPlayedReport): string {
	let text = report.text.trim();
	const build = (omitted = false): string => {
		const body = text ? `${omitted ? "[Earlier played words omitted] " : ""}${text}` : "none";
		const dot = /[.!?]$/.test(body) ? "" : ".";
		if (report.playedMs <= 0) {
			return "LFM TTS approximate played speech (0 ms, interrupted before playback): none. Generated text in chat was NOT played.";
		}
		if (report.uncertain) {
			const stateLabel = report.complete ? "completed" : "interrupted";
			return `LFM TTS approximate played speech (${report.playedMs} ms, ${stateLabel}; partial unhinted ASR, exact word boundary uncertain): ${body}${dot} Do not assume remaining generated text was heard.`;
		}
		if (!report.complete) {
			return `LFM TTS approximate played speech (${report.playedMs} ms, interrupted; unhinted ASR, not verbatim): ${body}${dot} Remaining generated text in chat was NOT played.`;
		}
		return `LFM TTS approximate played speech (${report.playedMs} ms, playback completed; unhinted ASR, not verbatim): ${body}${dot}`;
	};
	let formatted = build(false);
	while (
		formatted.length > 16_000 ||
		new TextEncoder().encode(JSON.stringify({ text: formatted })).length > 17_000
	) {
		text = text.slice(1024).trim();
		formatted = build(true);
	}
	return formatted;
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
	metrics: LfmUtteranceMetrics;
	onReport: (report: LfmPlayedReport) => void;
}

interface PendingReport {
	utterance: string;
	playedMs: number;
	interrupted: boolean;
	fallbackText: string;
	onReport: (report: LfmPlayedReport) => void;
	resolveWait: () => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface LfmTtsSpeakerCallbacks {
	onStatus: (text: string) => void;
	onPlaying: (metrics: LfmUtteranceMetrics) => void;
	onMetrics?: (metrics: LfmUtteranceMetrics) => void;
	onIdle: () => void;
	onError: (error: unknown) => void;
}

/** Normalised player transport. LFM uses a real WebSocket; Kokoro adapts HTTP. */
export interface TtsTransport {
	readyState: number;
	bufferedAmount: number;
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
	onerror: (() => void) | null;
	onclose: (() => void) | null;
	send(data: string): void;
	close(): void;
	playedPrefix?: (
		epoch: number,
		samples: number,
		interrupted: boolean,
		truncated: boolean,
	) => Omit<LfmPlayedReport, "utterance">;
}

export class LfmTtsSpeaker {
	private context: AudioContext | null = null;
	private ws: TtsTransport | null = null;
	private alignedReporter: TtsTransport["playedPrefix"];
	private wsReady = false;
	private connecting = false;
	private closed = false;
	private paused = false;
	private connGen = 0;
	private epoch = 0;
	private coldLoadMs: number | null = null;
	private active: ActiveUtterance | null = null;
	private nodes = new Set<AudioBufferSourceNode>();
	private nextAt = 0;
	private played = new PlayedAudioClock();
	private finishTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingReports = new Map<number, PendingReport>();
	private lastInterruptTickAt = -Infinity;

	private readonly outputRate: number;
	private readonly prerollTarget: number;
	private readonly maxUtteranceSamples: number;

	constructor(
		private readonly callbacks: LfmTtsSpeakerCallbacks,
		private readonly wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/experiments/lfm-voice/ws?tts=1`,
		private readonly transportOptions?: {
			create: () => TtsTransport;
			label: string;
			outputRate?: number;
		},
	) {
		this.outputRate = transportOptions?.outputRate ?? OUTPUT_RATE;
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
		const socket = (this.transportOptions?.create() ?? new WebSocket(this.wsUrl)) as TtsTransport;
		if ("binaryType" in socket) socket.binaryType = "arraybuffer";
		this.ws = socket;
		this.alignedReporter = this.ws.playedPrefix?.bind(this.ws);

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
			if (type === "starting") {
				if (!this.active)
					this.callbacks.onStatus(`Loading ${this.transportOptions?.label ?? "Server4 LFM TTS"}…`);
			} else if (type === "ready") {
				if (msg.protocol !== 3 || msg.tts !== 1 || msg.outputRate !== this.outputRate) {
					this.failConnection(
						new Error(
							`${this.transportOptions?.label ?? "Server4 LFM TTS"} player protocol mismatch. Refresh ACB.`,
						),
					);
					return;
				}
				this.connecting = false;
				this.wsReady = true;
				const loadMs = typeof msg.loadMs === "number" && msg.loadMs > 0 ? msg.loadMs : null;
				if (this.active) {
					this.active.metrics.coldLoadMs = loadMs;
					this.coldLoadMs = null;
					this.flushSendQueue();
				} else {
					this.coldLoadMs = loadMs;
					this.callbacks.onIdle();
				}
			} else if (type === "first_pcm") {
				if (this.active && msg.epoch === this.active.epoch) {
					this.active.metrics.ttsFirstPcmServerMs =
						typeof msg.ttsFirstPcmMs === "number" ? msg.ttsFirstPcmMs : null;
				}
			} else if (type === "utterance_limit") {
				if (this.active && msg.epoch === this.active.epoch) {
					this.active.truncated = true;
					this.callbacks.onStatus(
						"Long answer truncated in voice playback; read the full formatted reply in chat.",
					);
				}
			} else if (type === "utterance_done") {
				if (this.active && msg.epoch === this.active.epoch) {
					this.active.serverDone = true;
					if (msg.truncated === true) this.active.truncated = true;
					this.flushPreroll(true);
					this.checkPlaybackComplete();
				}
			} else if (type === "played_prefix") {
				const ep = typeof msg.epoch === "number" ? msg.epoch : -1;
				const pending = this.pendingReports.get(ep);
				if (!pending) return;
				this.pendingReports.delete(ep);
				clearTimeout(pending.timer);
				const serverText = typeof msg.text === "string" ? msg.text : "";
				pending.onReport({
					utterance: pending.utterance,
					playedMs: typeof msg.playedMs === "number" ? msg.playedMs : pending.playedMs,
					text: serverText || pending.fallbackText,
					complete: msg.complete === true && !pending.interrupted,
					uncertain: msg.uncertain === true,
				});
				pending.resolveWait();
			} else if (type === "error") {
				this.failConnection(
					new Error(typeof msg.message === "string" ? msg.message : "Server4 LFM TTS failed."),
				);
			}
		};

		socket.onerror = () => {
			if (gen !== this.connGen || this.closed) return;
			this.failConnection(
				new Error(
					"Cannot reach Server4 LFM TTS. Check your login/Server4 status, or explicitly choose legacy voice.",
				),
			);
		};

		socket.onclose = () => {
			if (gen !== this.connGen || this.closed) return;
			const wasActive = Boolean(this.active || this.connecting);
			this.ws = null;
			this.wsReady = false;
			this.connecting = false;
			this.settleAllPendingOnDisconnect();
			if (this.active) {
				this.abortActiveLocally(true);
			}
			if (wasActive) {
				this.callbacks.onError(
					new Error(
						"Server4 LFM TTS disconnected; Pi work continues. Send or speak again to reconnect.",
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
		this.settleAllPendingOnDisconnect();
		if (this.active) this.abortActiveLocally(true);
		this.callbacks.onError(error);
	}

	beginUtterance(
		utteranceId: string,
		turnStartedAt: number,
		onReport: (report: LfmPlayedReport) => void,
	): void {
		if (this.closed) return;
		if (this.active) {
			this.stop();
		}
		this.ensureAudioContext();
		const epoch = ++this.epoch;
		this.played.reset();
		this.nextAt = 0;
		const coldLoadMs = this.coldLoadMs;
		this.coldLoadMs = null;
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
				coldLoadMs,
				ttsFirstPcmServerMs: null,
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
		if (!cleaned || (!this.transportOptions && !/[A-Za-z0-9]/.test(cleaned))) return;
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
		// Keep each wire segment <= 380 chars to respect server protocol cap (400).
		const safeText =
			cleaned.length > 380
				? cleaned
						.slice(0, 380)
						.replace(/[\uD800-\uDBFF]$/, "")
						.trimEnd()
				: cleaned;
		if (safeText !== cleaned && this.transportOptions) utt.truncated = true;
		utt.queuedForSend.push({ seq, text: safeText });
		this.flushSendQueue();
	}

	finishUtterance(): void {
		const utt = this.active;
		if (!utt || this.closed) return;
		utt.endQueued = true;
		if (utt.segments === 0 && utt.queuedForSend.length === 0) {
			// Nothing speakable was emitted (e.g. code-only or empty turn).
			this.active = null;
			this.requestPlayedPrefix(utt, 0, false, 0);
			this.callbacks.onIdle();
			return;
		}
		this.flushSendQueue();
	}

	private flushSendQueue(): void {
		const utt = this.active;
		if (!utt || !this.wsReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		// Backpressure: wait briefly if WS outbound buffer is congested (>128 KB).
		if (this.ws.bufferedAmount > 131_072) {
			setTimeout(() => this.flushSendQueue(), 25);
			return;
		}
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
		this.requestPlayedPrefix(finished, playedMs, false, playedSamples);
		this.callbacks.onIdle();
	}

	private requestPlayedPrefix(
		utt: ActiveUtterance,
		playedMs: number,
		interrupted: boolean,
		playedSamples?: number,
	): void {
		if (this.alignedReporter) {
			const report = this.alignedReporter(
				utt.epoch,
				playedSamples ?? 0,
				interrupted,
				utt.truncated,
			);
			this.ws?.send(JSON.stringify({ type: interrupted ? "cancel" : "played", epoch: utt.epoch }));
			utt.onReport({ ...report, utterance: utt.id });
			return;
		}
		if (!utt.sentAny || !this.wsReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
			utt.onReport({
				utterance: utt.id,
				playedMs,
				text: "",
				complete: false,
				uncertain: playedMs > 0,
			});
			return;
		}
		const timer = setTimeout(() => {
			const pending = this.pendingReports.get(utt.epoch);
			if (!pending) return;
			this.pendingReports.delete(utt.epoch);
			pending.onReport({
				utterance: pending.utterance,
				playedMs: pending.playedMs,
				text: pending.fallbackText,
				complete: false,
				uncertain: pending.playedMs > 0,
			});
			pending.resolveWait();
		}, 4_000);
		this.pendingReports.set(utt.epoch, {
			utterance: utt.id,
			playedMs,
			interrupted,
			fallbackText: "",
			onReport: utt.onReport,
			resolveWait: () => {},
			timer,
		});
		this.ws.send(
			JSON.stringify({
				type: interrupted ? "cancel" : "played",
				epoch: utt.epoch,
				utterance: utt.id,
				played_ms: playedMs,
			}),
		);
	}

	private abortActiveLocally(disconnected: boolean): void {
		const utt = this.active;
		if (!utt) return;
		const clock = this.outputClock();
		const playedMs = this.played.milliseconds(clock);
		const playedSamples = this.played.samples(clock, this.outputRate);
		this.stopAudioNodes();
		this.played.reset();
		this.active = null;
		if (this.alignedReporter) {
			this.requestPlayedPrefix(utt, playedMs, true, playedSamples);
		} else if (disconnected) {
			utt.onReport({
				utterance: utt.id,
				playedMs,
				text: "",
				complete: false,
				uncertain: playedMs > 0,
			});
		} else {
			this.requestPlayedPrefix(utt, playedMs, true);
		}
	}

	private settleAllPendingOnDisconnect(): void {
		for (const [ep, pending] of this.pendingReports) {
			clearTimeout(pending.timer);
			this.pendingReports.delete(ep);
			pending.onReport({
				utterance: pending.utterance,
				playedMs: pending.playedMs,
				text: pending.fallbackText,
				complete: false,
				uncertain: pending.playedMs > 0,
			});
			pending.resolveWait();
		}
	}

	hasPendingReports(): boolean {
		return this.pendingReports.size > 0;
	}

	get hasAudio(): boolean {
		return Boolean(this.active) || this.nodes.size > 0;
	}

	/** Wait briefly (bounded) for any in-flight played-prefix report before dispatching a follow-up turn. */
	async flushPendingReports(timeoutMs = 2_000): Promise<void> {
		if (this.pendingReports.size === 0) return;
		const waiters = [...this.pendingReports.values()].map(
			(entry) =>
				new Promise<void>((resolve) => {
					const prev = entry.resolveWait;
					entry.resolveWait = () => {
						prev();
						resolve();
					};
				}),
		);
		await Promise.race([
			Promise.all(waiters),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);
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

	/** Interrupt speech only; keeps Server4 TTS warm for the next utterance and never aborts Pi work. */
	stop(acknowledge = false): void {
		const interruptedPlayback =
			acknowledge && this.context?.state === "running" && this.played.isPlaying(this.outputClock());
		if (!this.active) {
			this.stopAudioNodes();
			this.played.reset();
			return;
		}
		this.abortActiveLocally(false);
		if (interruptedPlayback) this.acknowledgeInterruption();
	}

	/** Release Server4 TTS WebSocket and GPU reservation (e.g. when tab hides or voice closes). */
	disconnect(): void {
		if (this.active) {
			this.abortActiveLocally(true);
		} else {
			this.stopAudioNodes();
			this.played.reset();
		}
		this.settleAllPendingOnDisconnect();
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
