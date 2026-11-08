/** Browser speech input. Keep unsent audio until its current transcript is accepted. */
export interface CapturedUtterance {
	audio: Blob;
	endedAt: number;
	isCurrent: () => boolean;
	accept: () => boolean;
}

export interface ConversationCapture {
	close: () => void;
	/** Explicit input replacement, not speech-output interruption. */
	discard: () => void;
}

const INPUT_RATE = 16_000;
const MAX_INPUT_SAMPLES = INPUT_RATE * 30;

export async function captureConversation(
	onSpeech: () => void,
	onUtterance: (turn: CapturedUtterance) => void,
	onError: (error: unknown) => void,
): Promise<ConversationCapture> {
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
	});
	let context: AudioContext | null = null;
	let vad: import("@ricky0123/vad-web").MicVAD | null = null;
	let speechTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	let speaking = false;
	let dropSegment = false;
	let revision = 0;
	let parts: Float32Array[] = [];
	let samples = 0;
	const discard = () => {
		revision++;
		parts = [];
		samples = 0;
		// A typed replacement must not later submit the old, still-open VAD segment.
		dropSegment = speaking;
	};
	const close = () => {
		if (closed) return;
		closed = true;
		discard();
		if (speechTimer) clearTimeout(speechTimer);
		stream.getTracks().forEach((track) => {
			track.stop();
		});
		void vad?.destroy().catch(() => {});
		void context?.close().catch(() => {});
	};
	try {
		context = new AudioContext();
		await context.resume();
		const { MicVAD, utils } = await import("@ricky0123/vad-web");
		let lastSound = performance.now();
		const emit = () => {
			if (closed || speaking || !samples) return;
			const version = revision;
			const merged = new Float32Array(samples);
			let offset = 0;
			for (const part of parts) {
				merged.set(part, offset);
				offset += part.length;
			}
			const isCurrent = () => !closed && !speaking && version === revision;
			onUtterance({
				audio: new Blob([utils.encodeWAV(merged, 1, INPUT_RATE, 1, 16)], { type: "audio/wav" }),
				endedAt: lastSound,
				isCurrent,
				accept: () => {
					if (!isCurrent()) return false;
					discard();
					return true;
				},
			});
		};
		vad = await MicVAD.new({
			model: "v5",
			startOnLoad: false,
			audioContext: context,
			getStream: async () => stream,
			baseAssetPath: "/voice-vad/vad-0.0.31/",
			onnxWASMBasePath: "/voice-vad/ort-1.31.1/",
			ortConfig: (ort) => {
				ort.env.wasm.numThreads = 1;
				ort.env.wasm.proxy = false;
				ort.env.logLevel = "error";
			},
			positiveSpeechThreshold: 0.5,
			negativeSpeechThreshold: 0.35,
			redemptionMs: 1400,
			preSpeechPadMs: 320,
			minSpeechMs: 128,
			submitUserSpeechOnPause: false,
			onFrameProcessed: (probabilities) => {
				if (probabilities.isSpeech >= 0.35) lastSound = performance.now();
			},
			onSpeechStart: () => {
				if (closed) return;
				// Fence an older ASR result immediately, before the real-start debounce.
				speaking = true;
				dropSegment = false;
				revision++;
			},
			onSpeechRealStart: () => {
				if (closed) return;
				onSpeech();
				if (speechTimer) clearTimeout(speechTimer);
				speechTimer = setTimeout(() => {
					close();
					onError(new Error("Speech exceeded the 30-second test limit; restart the microphone."));
				}, 30_000);
			},
			onSpeechEnd: (audio) => {
				if (speechTimer) clearTimeout(speechTimer);
				speechTimer = null;
				speaking = false;
				if (closed) return;
				if (dropSegment) {
					dropSegment = false;
					return;
				}
				if (samples + audio.length > MAX_INPUT_SAMPLES) {
					close();
					onError(
						new Error(
							"Unsent speech exceeded 30 seconds; restart the microphone. Nothing was submitted.",
						),
					);
					return;
				}
				parts.push(audio.slice());
				samples += audio.length;
				revision++;
				emit();
			},
			onVADMisfire: () => {
				if (closed) return;
				speaking = false;
				dropSegment = false;
				revision++;
				// A tiny filler/noise burst must not strand the previous draft.
				emit();
			},
		});
		for (const track of stream.getTracks()) {
			track.addEventListener("ended", () => {
				if (!closed) {
					close();
					onError(new Error("Microphone disconnected"));
				}
			});
		}
		await vad.start();
		return { close, discard };
	} catch (error) {
		close();
		throw error;
	}
}
