/**
 * Voice (TTS) and file/voice recording. The browser still owns these:
 *
 *   - speakText(): POST to /api/tts/stream, decode each arriving WAV chunk
 *     and schedule it on a Web Audio timeline, so playback starts as soon as
 *     the FIRST chunk is synthesized (not after the whole reply)
 *   - toggleSpeak(): per-message Long/Short button: play/stop the chosen
 *     message's audio
 *   - handleFileAttach(): POST to /api/upload, remember structured image
 *     references for multimodal models, and show attachment previews
 *   - handleVoiceRecord(): MediaRecorder → POST to /api/transcribe →
 *     paste the transcript into the input
 */

import {
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGE_TOTAL_BYTES,
	MAX_PROMPT_IMAGES,
} from "../shared/limits.js";
import { streamSynthesizeSpeech, synthesizeSpeech, transcribeAudio, uploadFile } from "./api.js";
import { $ } from "./dom.js";
import { markdownToSpeechText } from "./markdown.js";
import {
	addFileUploadPreview,
	addImageAttachmentPreview,
	appendError,
	autoSize,
	hideToast,
	refreshStatus,
	setStatusMessage,
	showTtsBanner,
} from "./render.js";
import { state } from "./state.js";

/**
 * Soft cap on what we send to TTS. Kept just under the server's hard cap
 * (MAX_TEXT_CHARS in tts.ts, 30 000) so a normal long message never trips
 * the 413 — instead we truncate with a spoken "…message truncated" cue.
 * Kokoro itself has no text limit; this exists only to avoid synthesizing
 * absurd lengths and to keep the spoken cue inside the server's cap.
 */
const TTS_MAX_CHARS = 29_000;

/** Active transfers; the composer blocks sending a half-attached prompt. */
let uploadCount = 0;

export function isUploadInProgress(): boolean {
	return uploadCount > 0;
}

/**
 * Identity (opaque token) of whatever source is currently driving
 * playback, so the speak buttons can implement play/stop toggle
 * semantics. Set by toggleSpeak() and cleared when playback stops.
 * Direct speakText() calls leave this null, which is correct: nothing
 * for a button to "stop" in that case.
 */
let currentSpeakSrc: unknown = null;

/**
 * Monotonic generation token. Bumped by stopAllVoice() so any
 * speakText() call that is still mid-synthesis (waiting on /api/tts)
 * can detect that it has been superseded and discard its blob instead
 * of starting playback. Without this, "stop" would race the in-flight
 * synthesis: the blob lands a moment later and auto-plays over the
 * silence the user just asked for.
 */
let speakGeneration = 0;

/**
 * AbortController for the currently in-flight /api/tts request, if any.
 * Held at module scope so stopAllVoice() can abort the fetch early
 * (freeing the network connection) rather than just ignoring the blob
 * when it eventually arrives.
 */
let activeController: AbortController | null = null;

/**
 * Shared Web Audio context for all TTS playback. Created lazily on the first
 * speak — inside the click that started it, so browsers that require a user
 * gesture for audio (Safari/iOS) accept the resume — and then reused for the
 * life of the page. Chrome caps a page at a handful of contexts and one is all
 * we need, because utterances are serialized. Never closed.
 */
let audioCtx: AudioContext | null = null;

/**
 * Scheduling lead (seconds) for each chunk: chunks are placed slightly in the
 * future so consecutive ones butt up seamlessly instead of racing the audio
 * clock. Small enough to be inaudible.
 */
const TTS_SCHEDULE_LEAD = 0.08;

/**
 * The gapless queue: chunks of the current utterance that are scheduled but
 * haven't finished playing, plus the context time the NEXT chunk should start
 * at. Playback begins as soon as the first chunk is synthesized and each later
 * chunk is appended to the running timeline, rather than swapped into a media
 * element — which is what used to leave an audible gap between chunks.
 */
let liveNodes: AudioBufferSourceNode[] = [];
let nextStartAt = 0;

/**
 * Playback rate Web Audio applies to the current utterance, and the speed the
 * current utterance was synthesized at (undefined = engine default). Exactly one
 * of the two does the speeding up: when the server takes a `speed`
 * (state.ttsSpeedParam), the engine stretches the audio itself — it scales
 * phoneme durations, so the voice keeps its natural pitch — and the rate stays 1;
 * otherwise we resample with Web Audio's playbackRate, which has no
 * pitch-preserving mode and so raises the pitch (audibly, at the 1.25x default).
 */
let activePlaybackRate = 1;
let activeSynthSpeed: number | undefined;

/**
 * True once the current utterance's stream has closed, i.e. no more chunks
 * will ever be scheduled. Only then can the last node's `ended` event finalize
 * the utterance — before that, an empty queue is a temporary underflow
 * (synthesis behind playback) and the next arriving chunk resumes it.
 */
let streamEnded = false;

/**
 * Tell Safari/iOS this page is playing *media* rather than ambient audio. Web
 * Audio is silenced by the hardware mute switch by default; the media elements
 * we used to play through weren't. Unsupported elsewhere — harmless no-op in
 * Chrome and Firefox.
 */
function declarePlaybackAudioSession(): void {
	const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
	if (session) session.type = "playback";
}

/**
 * Speed to ask the engine for, clamped to what it accepts. The picker only
 * offers 1–2x, so this only matters for a persisted pref from an older build or
 * a hand-edited one — which would otherwise come back as a 400.
 */
function clampSynthSpeed(rate: number): number {
	return Math.min(2, Math.max(0.5, rate));
}

/**
 * True when the USER has paused playback via the status-bar pause button
 * — an explicit intent flag, distinct from the <audio> element's `paused`
 * property. That property is also momentarily true between chunks, during
 * the src-swap window, and after stop, none of which should show a "paused"
 * state or block the chunk pump. Only pauseVoice() sets this; speakText()
 * (on start) and stopAllVoice() clear it. resumeVoice() clears it to pump.
 */
let userPaused = false;

/**
 * Derive a friendly speak-source label (e.g. "🗣️ LongTTS") from the
 * owning button so the TTS banner can name the variant. Falls back to a
 * generic "🔊 TTS" for direct speakText() calls (auto-speak) that have no
 * owning button.
 */
function speakLabelFromSrc(src: unknown): string {
	if (src instanceof HTMLElement) {
		const variant = src.dataset.voiceVariant;
		if (variant === "long") return "🗣️ LongTTS";
		if (variant === "medium") return "📝 MedTTS";
		if (variant === "short") return "💬 ShortTTS";
		const lbl = src.dataset.idleLabel ?? src.textContent ?? "";
		if (/LongTTS/.test(lbl)) return "🗣️ LongTTS";
		if (/MedTTS/.test(lbl)) return "📝 MedTTS";
		if (/ShortTTS/.test(lbl)) return "💬 ShortTTS";
	}
	return "🔊 TTS";
}

/** Collapse a spoken string to a single preview line, capped for the banner. */
function ttsPreview(spoken: string): string {
	const oneLine = spoken.replace(/\s+/g, " ").trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

/**
 * Human-readable TTS engine label from /api/health (kokoro→Kokoro).
 * Falls back to "TTS" before the health probe lands or
 * if the server omits the engine — so the banner never lies about
 * which engine is actually configured.
 */
function ttsEngineLabel(): string {
	const e = state.ttsEngine;
	if (!e) return "TTS";
	return e.charAt(0).toUpperCase() + e.slice(1);
}

/**
 * The active TTS voice for the banner — the user's pick if set, else the
 * server default. null when neither is known yet.
 */
function ttsVoiceLabel(): string | null {
	return state.ttsVoice ?? state.ttsDefaultVoice ?? null;
}

/**
 * Synthesize the given text via /api/tts and play it on the shared <audio>.
 * One call at a time — starting a new one stops the current playback.
 * `label` (e.g. "🗣️ LongTTS") names the variant on the blue TTS banner.
 */
export async function speakText(text: string, label = "🔊 TTS"): Promise<void> {
	// Strip markdown before synthesis: the raw text off the wire is full
	// of **bold**, ### headings, ``` fences, [label](url) links, etc. that
	// the TTS engine would read aloud as literal sigils. See markdown.ts.
	let spoken = markdownToSpeechText(text);
	if (!spoken) return;
	if (spoken.length > TTS_MAX_CHARS) {
		spoken = `${spoken.slice(0, TTS_MAX_CHARS)} … message truncated.`;
	}
	// Raise the blue TTS banner (mirrors the multimodal-proxy toast): the
	// header names the variant + the actually-configured engine (and voice,
	// if known), the body shows a preview of the text about to be spoken.
	// Persistent until playback starts, stops, or errors — at which point
	// hideToast() clears it.
	const engine = ttsEngineLabel();
	const voice = ttsVoiceLabel();
	const synthHead = voice
		? `${label} · synthesizing via ${engine} (${voice})…`
		: `${label} · synthesizing via ${engine}…`;
	showTtsBanner(synthHead, ttsPreview(spoken));
	// Decide who does the speeding up for this utterance (see the state comment
	// on ttsSpeedParam): the engine when it takes a speed, else Web Audio's rate.
	if (state.ttsSpeedParam) {
		activeSynthSpeed = clampSynthSpeed(state.ttsSpeed);
		activePlaybackRate = 1;
	} else {
		activeSynthSpeed = undefined;
		activePlaybackRate = state.ttsSpeed;
	}
	// Mark the initiating button as "synthesizing…" so the user sees a
	// spinner during the (potentially long) TTS round-trip, then flip to
	// the playing (⏹) state once audio actually starts. Auto-speak calls
	// leave currentSpeakSrc null, so this is a no-op there.
	setSpeakBtnState(currentSpeakSrc, "loading");
	state.ttsInFlight++;
	refreshStatus();
	// A new utterance supersedes everything about the previous one: bumping the
	// generation token makes the old stream loop's late-arriving chunks (and any
	// audio it had already scheduled) no-ops, and haltPlayback() silences what is
	// still on the timeline. Without both, two overlapping speaks would talk over
	// each other and the loser would reset the winner's button.
	speakGeneration++;
	const gen = speakGeneration;
	activeController?.abort();
	haltPlayback();
	const controller = new AbortController();
	activeController = controller;

	// Clear any leftover user-pause intent from a previous utterance so this
	// one starts playing immediately.
	userPaused = false;

	try {
		await playStreamed(spoken, gen, controller);
	} catch (err) {
		// Nothing to reset if a newer utterance superseded this one, or if
		// stopAllVoice() already did the resetting when it bumped the generation
		// (which is what an AbortError here means in practice).
		if (gen !== speakGeneration) return;
		if (!(err instanceof DOMException && err.name === "AbortError")) {
			appendError(`tts failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		setSpeakBtnState(currentSpeakSrc, "idle");
		currentSpeakSrc = null;
		hideToast();
	} finally {
		if (activeController === controller) activeController = null;
		state.ttsInFlight--;
		refreshStatus();
	}
}

/**
 * Streaming playback: pull synthesized chunks from /api/tts/stream and put each
 * one on the Web Audio timeline as it arrives, so sound starts after the FIRST
 * chunk instead of after the whole message has been synthesized — a long reply
 * costs one chunk of latency rather than all of them. Chunks are decoded in
 * arrival order and scheduled back-to-back, which is what makes the joins
 * inaudible — the previous implementation swapped each WAV into a media element
 * instead and left a gap whenever the next chunk wasn't ready when the current
 * one ended.
 */
async function playStreamed(
	spoken: string,
	gen: number,
	controller: AbortController,
): Promise<void> {
	const ctx = await ensureAudioRunning();
	let scheduled = false;
	try {
		for await (const wav of streamSynthesizeSpeech(
			spoken,
			state.ttsVoice ?? undefined,
			controller.signal,
			activeSynthSpeed,
		)) {
			if (gen !== speakGeneration) return; // stopped or superseded mid-stream
			await scheduleChunk(ctx, gen, wav);
			scheduled = true;
		}
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") throw err;
		if (scheduled || liveNodes.length > 0) {
			// Audio is already playing. Let what we have play out rather than
			// cutting the user off mid-sentence, but say the reply is truncated.
			const detail = err instanceof Error ? err.message : String(err);
			appendError(`tts stream interrupted: ${detail}`);
		} else {
			// Nothing was scheduled, so the streaming route failed outright (an
			// older pi-voice-server without /tts/stream, or a pre-stream 502).
			// Fall back to one whole-utterance synthesis on the same timeline.
			await playWholeBlob(ctx, spoken, gen, controller);
		}
	}
	if (gen !== speakGeneration) return;
	streamEnded = true;
	// An empty queue here means the stream produced nothing at all; otherwise the
	// last chunk's `ended` event finalizes the utterance.
	if (liveNodes.length === 0) finishUtterance();
}

/**
 * Get the shared AudioContext running. Called before the first chunk is
 * scheduled; because speakText's prologue runs synchronously from the click
 * handler, this resume happens inside the user gesture that asked for playback
 * (which Safari/iOS require). The race guards against a resume() promise that
 * never settles (iOS, no gesture): scheduling against a frozen clock is still
 * correct, and playback begins whenever the context actually starts.
 */
async function ensureAudioRunning(): Promise<AudioContext> {
	declarePlaybackAudioSession();
	if (!audioCtx) audioCtx = new AudioContext();
	const ctx = audioCtx;
	// Read the state into a local first: comparing ctx.state directly here would
	// narrow it for the check after the race, which needs the post-resume truth.
	const initial: AudioContextState = ctx.state;
	if (initial === "running") return ctx;
	await Promise.race([
		ctx.resume().catch(() => undefined),
		new Promise((resolve) => setTimeout(resolve, 1000)),
	]);
	if (ctx.state !== "running") {
		appendError("audio is blocked by the browser — tap the page and try again.");
	}
	return ctx;
}

/**
 * Decode one synthesized WAV chunk and place it on the timeline immediately
 * after the previous one. Decoding is awaited in stream order, so chunks are
 * always scheduled in playback order even though decodeAudioData's promises can
 * settle out of order.
 */
async function scheduleChunk(ctx: AudioContext, gen: number, wav: Blob): Promise<void> {
	const decoded = await ctx.decodeAudioData(await wav.arrayBuffer());
	if (gen !== speakGeneration) return; // superseded while decoding
	const node = ctx.createBufferSource();
	node.buffer = decoded;
	node.playbackRate.value = activePlaybackRate;
	node.connect(ctx.destination);
	// Start where the previous chunk ends. If synthesis fell behind playback the
	// timeline has already passed, so start now rather than in the past (which the
	// audio clock would silently skip).
	const startAt = Math.max(ctx.currentTime + TTS_SCHEDULE_LEAD, nextStartAt);
	node.start(startAt);
	nextStartAt = startAt + decoded.duration / activePlaybackRate;
	liveNodes.push(node);
	node.onended = () => onChunkEnded(gen, node);
	if (liveNodes.length === 1) {
		// First chunk on the timeline: flip the button from its spinner to ⏹ and
		// drop the synthesis banner in favour of the status bar's "♪ playing".
		state.audioPlaying = true;
		state.audioPaused = false;
		setSpeakBtnState(currentSpeakSrc, "playing");
		hideToast();
		refreshStatus();
	}
}

/**
 * A scheduled chunk played to its end. When the last one ends after the stream
 * closed, the utterance is over. An empty queue with the stream still open is a
 * temporary underflow (synthesis behind playback) — the next chunk resumes the
 * queue, and until then the status bar's "synthesizing…" is the truth.
 */
function onChunkEnded(gen: number, node: AudioBufferSourceNode): void {
	if (gen !== speakGeneration) return;
	liveNodes = liveNodes.filter((n) => n !== node);
	node.disconnect();
	if (liveNodes.length > 0) return;
	if (!streamEnded) {
		state.audioPlaying = false;
		refreshStatus();
		return;
	}
	finishUtterance();
}

/**
 * Playback of the current utterance is over: reset the timeline, the owning
 * button (spinner/⏹ → idle) and the status-bar voice indicator.
 */
function finishUtterance(): void {
	nextStartAt = 0;
	streamEnded = false;
	userPaused = false;
	state.audioPlaying = false;
	state.audioPaused = false;
	if (currentSpeakSrc !== null) {
		setSpeakBtnState(currentSpeakSrc, "idle");
		currentSpeakSrc = null;
	}
	hideToast();
	refreshStatus();
}

/**
 * Silence the current utterance: stop and detach every scheduled chunk and clear
 * the timeline. Audio only — button and banner state are the caller's job
 * (stopAllVoice resets the owning button; a new utterance sets its own). Also
 * lifts a pause, so the next speak isn't stuck in a suspended context. Safe to
 * call when nothing is scheduled.
 */
function haltPlayback(): void {
	for (const node of liveNodes) {
		node.onended = null; // stopping fires `ended`; it must not finalize
		try {
			node.stop();
		} catch {
			/* already ended, or never got to start */
		}
		node.disconnect();
	}
	liveNodes = [];
	nextStartAt = 0;
	streamEnded = false;
	state.audioPlaying = false;
	state.audioPaused = false;
	if (audioCtx?.state === "suspended") {
		void audioCtx.resume().catch(() => {
			/* the next speak resumes it again if this fails */
		});
	}
}

/**
 * Whole-utterance fallback: synthesize the entire text in one /api/tts request
 * and put the single WAV on the same timeline. Used only when the streaming
 * route is unavailable, where it costs the full synthesis before the first sound
 * — better than failing outright, and the server still exposes both routes.
 */
async function playWholeBlob(
	ctx: AudioContext,
	spoken: string,
	gen: number,
	controller: AbortController,
): Promise<void> {
	const blob = await synthesizeSpeech(
		spoken,
		state.ttsVoice ?? undefined,
		controller.signal,
		activeSynthSpeed,
	);
	if (gen !== speakGeneration) return;
	// No more chunks will ever arrive, so this node's `ended` finalizes.
	streamEnded = true;
	await scheduleChunk(ctx, gen, blob);
}

/**
 * Stop all voice playback and cancel any in-flight TTS synthesis — the global
 * "stop everything" the status-bar button calls. No matter which message's speak
 * button kicked off playback, this halts it: bumps the generation token (so
 * chunks arriving from a still-pending /api/tts/stream request are discarded and
 * scheduled audio ignores its own `ended` events), aborts that request, stops
 * every scheduled chunk, and resets the owning message's speak button back to
 * idle. Safe to call when nothing is playing.
 */
export function stopAllVoice(): void {
	// Bump first: the in-flight stream loop and every scheduled node check this
	// token, so from here they are all no-ops. Then abort, so neither the
	// connection nor the synthesis CPU work lingers on audio nobody will hear.
	speakGeneration++;
	activeController?.abort();
	activeController = null;

	// Clear the TTS banner if one is up (a stop is a full reset).
	hideToast();

	// A stop is a full reset, so a subsequent speak must not start paused and the
	// status-bar control must not keep showing "paused" once the audio is gone.
	userPaused = false;

	haltPlayback();

	if (currentSpeakSrc !== null) {
		setSpeakBtnState(currentSpeakSrc, "idle");
		currentSpeakSrc = null;
	}
	refreshStatus();
}

/**
 * Pause TTS playback. Suspending the AudioContext freezes its clock, so every
 * scheduled chunk keeps its position and playback continues from exactly where
 * it stopped when resumeVoice() lifts the suspension — including mid-chunk.
 * Chunks still being synthesized keep arriving (decodeAudioData works while
 * suspended) and are simply scheduled further along the frozen timeline.
 *
 * Sets an explicit `userPaused` flag rather than reading the context state,
 * because a new speak must be able to clear the pause before the context has
 * caught up. Safe to call when nothing is playing or when already paused.
 */
export function pauseVoice(): void {
	if (!audioCtx || userPaused || audioCtx.state !== "running") return;
	if (liveNodes.length === 0) return; // nothing scheduled yet — nothing to pause
	userPaused = true;
	void audioCtx.suspend().catch((err) => {
		appendError(`tts pause failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	state.audioPaused = true;
	state.audioPlaying = false;
	refreshStatus();
}

/**
 * Resume playback from where pauseVoice() froze it — mid-chunk, with any chunks
 * that were synthesized meanwhile already queued behind it. No-op if not
 * currently paused.
 */
export function resumeVoice(): void {
	if (!audioCtx || !userPaused || audioCtx.state !== "suspended") return;
	userPaused = false;
	void audioCtx.resume().catch((err) => {
		appendError(`tts resume failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	// Flip state optimistically; the resumed context confirms it by playing.
	state.audioPaused = false;
	state.audioPlaying = true;
	refreshStatus();
}

/**
 * Play/stop toggle for the per-message speak buttons. `src` is an
 * opaque identity token (typically the calling button element) so we
 * can tell "I'm the one currently playing — second press stops me"
 * from "a different message is playing — switch to this one".
 * Direct speakText() callers pass null for `src` so a later button
 * press always starts fresh.
 */
export function toggleSpeak(text: string, src: unknown): void {
	const ownsCurrent =
		currentSpeakSrc === src && (state.audioPlaying || state.audioPaused || state.ttsInFlight > 0);
	// Second press on the button that owns the current utterance — playing,
	// paused, or still synthesizing — is a stop. Anything else starts (or
	// switches to) this message.
	if (ownsCurrent) {
		stopAllVoice();
		return;
	}
	// Switching source: clear the previous button's stop indicator.
	if (currentSpeakSrc !== null && currentSpeakSrc !== src) {
		setSpeakBtnState(currentSpeakSrc, "idle");
	}
	currentSpeakSrc = src;
	// Don't flip to playing yet — speakText() shows a spinner while the first
	// chunk is synthesized, then flips to ⏹ once audio actually starts.
	void speakText(text, speakLabelFromSrc(src));
}

/**
 * Three-state label for a speak button: idle (restore its original
 * emoji/label), loading (spinning indicator while TTS synthesizes or
 * pi generates a spoken reply), or playing (⏹ stop). The original
 * label is captured from the button's initial textContent on first
 * use via a data attribute, so we can always restore it. Silent no-op
 * for non-element sources so toggleSpeak stays generic.
 */
type SpeakBtnState = "idle" | "loading" | "playing";
function setSpeakBtnState(src: unknown, state: SpeakBtnState): void {
	if (!(src instanceof HTMLElement)) return;
	if (state === "loading") {
		// Remember the idle label the first time we swap away from it,
		// so a later "idle" restores the original emoji/text.
		if (!src.dataset.idleLabel) src.dataset.idleLabel = src.textContent ?? "";
		src.textContent = "";
		src.append(Object.assign(document.createElement("span"), { className: "speak-spinner" }));
		src.classList.add("is-loading");
		src.title = "Processing…";
		return;
	}
	src.classList.remove("is-loading");
	if (state === "playing") {
		src.textContent = "⏹";
		src.title = "Stop playback";
	} else {
		src.textContent = src.dataset.idleLabel ?? "🔊";
		src.title = "Speak this message (local TTS)";
	}
}

// ---------------------------------------------------------------------------
// File attach
// ---------------------------------------------------------------------------

// Matches the server's bounded structured-image transport. Images above the
// per-image limit are rejected before any upload begins.
/**
 * Shared core: take a list of File objects (from the file picker, a
 * paste, or a drag-and-drop) and upload each one, remembering its private
 * upload reference for multimodal models and showing a removable thumbnail
 * above the composer. Non-image files still get a Markdown link in the input.
 * The file picker resets its own .value; callers that don't come from an
 * <input type=file> simply pass an empty Event-less path.
 */
export async function attachFiles(files: File[]): Promise<void> {
	if (files.length === 0) return;
	const ta = $<HTMLTextAreaElement>("#input");
	for (const file of files) {
		if (file.type.startsWith("image/") && file.size > MAX_PROMPT_IMAGE_BYTES) {
			appendError(
				`Cannot attach ${file.name}: image is ${formatFileSize(file.size)}, above the ${formatFileSize(MAX_PROMPT_IMAGE_BYTES)} per-image limit.`,
			);
			continue;
		}
		if (file.type.startsWith("image/") && state.uploadedImages.size >= MAX_PROMPT_IMAGES) {
			appendError(
				`Cannot attach ${file.name}: at most ${MAX_PROMPT_IMAGES} images can be attached.`,
			);
			continue;
		}
		const uploadController = new AbortController();
		const uploadPreview = addFileUploadPreview(file.name, file.size, () => {
			uploadController.abort();
		});
		uploadCount++;
		try {
			const res = await uploadFile(
				file,
				({ loaded, total }) => {
					uploadPreview.setProgress(loaded, total);
				},
				uploadController.signal,
			);
			const isImage = res.mimeType.startsWith("image/") && res.size <= MAX_PROMPT_IMAGE_BYTES;
			if (isImage) {
				// Keep only the small upload reference. The server reads the file it
				// already accepted over HTTP and builds pi's inline image block; this
				// avoids a multi-megabyte base64 WebSocket frame on mobile browsers.
				state.uploadedImages.set(res.url, {
					mimeType: res.mimeType,
					filename: res.filename,
					size: res.size,
				});
			}
			if (isImage) {
				// Keep image uploads out of the visible draft. The thumbnail is
				// the attachment affordance; the URL is sent separately as a
				// structured reference and resolved by the server.
				uploadPreview.remove();
				addImageAttachmentPreview(res.url, res.filename, () => {
					state.uploadedImages.delete(res.url);
				});
			} else {
				const insertion = `[file: ${res.filename}](${res.url})`;
				ta.value = `${ta.value}\n${insertion}`.trim();
				uploadPreview.complete(() => {
					ta.value = ta.value.replace(`[file: ${res.filename}](${res.url})`, "").trim();
					autoSize();
				});
			}
			autoSize();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (uploadController.signal.aborted) {
				uploadPreview.cancelled();
			} else {
				uploadPreview.fail(message);
				appendError(message);
			}
		} finally {
			uploadCount--;
		}
	}
}

export function promptImageLimitError(): string | null {
	const total = Array.from(state.uploadedImages.values()).reduce(
		(sum, image) => sum + image.size,
		0,
	);
	if (total > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
		return `The attached images total ${formatFileSize(total)}, above the ${formatFileSize(MAX_PROMPT_IMAGE_TOTAL_BYTES)} combined limit.`;
	}
	return null;
}

function formatFileSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
}

export async function handleFileAttach(e: Event): Promise<void> {
	const input = e.target as HTMLInputElement;
	const files = input.files;
	if (!files || files.length === 0) return;
	await attachFiles(Array.from(files));
	input.value = "";
}

/**
 * Paste handler for the input textarea. Plain-text paste behaves as
 * normal; this only intercepts pastes that carry File objects
 * (screenshots copied to clipboard, files copied from a file manager,
 * etc.) and routes them through attachFiles() so they upload just like
 * a picker-selected file. When files are present we cancel the default
 * text insertion to avoid dumping binary/placeholder text into the box.
 */
export async function handlePaste(e: ClipboardEvent): Promise<void> {
	const files = e.clipboardData?.files;
	if (!files || files.length === 0) return;
	e.preventDefault();
	await attachFiles(Array.from(files));
}

/**
 * Drag-and-drop handler for the input textarea. Same idea as paste:
 * route any dropped files through attachFiles(). preventDefault on
 * both dragover (so the drop event fires) and drop (so the browser
 * doesn't navigate to the file).
 */
export async function handleDrop(e: DragEvent): Promise<void> {
	const files = e.dataTransfer?.files;
	if (!files || files.length === 0) return;
	e.preventDefault();
	await attachFiles(Array.from(files));
}

// ---------------------------------------------------------------------------
// Voice recording
// ---------------------------------------------------------------------------

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordingStart = 0;

export async function handleVoiceRecord(): Promise<void> {
	if (mediaRecorder && mediaRecorder.state === "recording") {
		mediaRecorder.stop();
		// Flip the button back to the mic icon immediately so the user
		// sees that recording has stopped, before the transcription
		// round-trip even begins. (onstop also resets it as the
		// canonical teardown point.)
		$<HTMLButtonElement>("#voice-btn").textContent = "🎙";
		return;
	}
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		recordedChunks = [];
		mediaRecorder = new MediaRecorder(stream);
		mediaRecorder.ondataavailable = (e) => {
			if (e.data.size > 0) recordedChunks.push(e.data);
		};
		mediaRecorder.onstop = async () => {
			// Canonical teardown: ensure the mic button reverts to its
			// idle icon no matter how recording stopped (button click,
			// an OS/permission revoke, etc.).
			$<HTMLButtonElement>("#voice-btn").textContent = "🎙";
			stream.getTracks().forEach((t) => {
				t.stop();
			});
			const blob = new Blob(recordedChunks, { type: "audio/webm" });
			const secs = (Date.now() - recordingStart) / 1000;
			setStatusMessage(`transcribing ${secs.toFixed(1)}s of audio…`);
			try {
				const text = await transcribeAudio(blob);
				// Insert the transcript at the cursor, preserving any text
				// already in the box — so recording again appends rather
				// than wiping what's there. A single space is added before
				// the transcript only when needed (non-empty prefix that
				// doesn't already end in whitespace).
				if (text) {
					const ta = $<HTMLTextAreaElement>("#input");
					const start = ta.selectionStart;
					const end = ta.selectionEnd;
					const before = ta.value.slice(0, start);
					const after = ta.value.slice(end);
					const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
					ta.value = before + lead + text + after;
					ta.selectionStart = ta.selectionEnd = before.length + lead.length + text.length;
					ta.focus();
				}
				autoSize();
				setStatusMessage(`transcribed (${text.length} chars). Press Enter to send.`);
			} catch (err) {
				appendError(`transcription failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		};
		recordingStart = Date.now();
		mediaRecorder.start();
		$<HTMLButtonElement>("#voice-btn").textContent = "🔴";
		setStatusMessage("recording… click 🔴 to stop");
	} catch (err) {
		appendError(`microphone access denied: ${err instanceof Error ? err.message : String(err)}`);
	}
}
