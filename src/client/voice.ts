/**
 * Voice (TTS) and file/voice recording. The browser still owns these:
 *
 *   - speakText(): POST to /api/tts, play the WAV in the shared <audio>
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
import { synthesizeSpeech, transcribeAudio, uploadFile } from "./api.js";
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
 * The currently-active object URL feeding the <audio> element, tracked
 * so we can revoke it safely on swap or end without racing a newer URL.
 * null when nothing is loaded.
 */
let activeObjectUrl: string | null = null;

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
	const audio = $<HTMLAudioElement>("#tts-audio");
	// Mark the initiating button as "synthesizing…" so the user sees a
	// spinner during the (potentially long) TTS round-trip, then flip to
	// the playing (⏹) state once audio actually starts. Auto-speak calls
	// leave currentSpeakSrc null, so this is a no-op there.
	setSpeakBtnState(currentSpeakSrc, "loading");
	state.ttsInFlight++;
	refreshStatus();
	// Capture this request's generation token and AbortController. If
	// stopAllVoice() fires while we await synthesis (a slow Kokoro round
	// trip can take a second or two), the generation check below drops
	// the blob silently and the abort frees the connection early.
	const gen = speakGeneration;
	const controller = new AbortController();
	activeController = controller;

	// Use the whole-utterance endpoint rather than streaming individual WAV
	// chunks. Kokoro still chunks internally to stay within its context window,
	// but the server concatenates those chunks before returning one WAV. This
	// avoids browser source-swaps and queue-underflow gaps during long replies,
	// at the cost of waiting for the full synthesis before playback starts.
	// Clear any leftover user-pause intent from a previous utterance so this
	// one starts playing immediately.
	userPaused = false;

	try {
		await playWholeBlob(audio, spoken, gen, controller);
	} catch (err) {
		// stopAllVoice() aborted synthesis on purpose — reset quietly.
		if (err instanceof DOMException && err.name === "AbortError") {
			setSpeakBtnState(currentSpeakSrc, "idle");
			currentSpeakSrc = null;
			hideToast();
			return;
		}
		appendError(`tts failed: ${err instanceof Error ? err.message : String(err)}`);
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
 * Whole-utterance playback: synthesize the entire text in one /api/tts
 * request and play the resulting single WAV on the shared <audio>. Kokoro
 * still chunks internally, but the browser receives one continuous asset.
 */
async function playWholeBlob(
	audio: HTMLAudioElement,
	spoken: string,
	gen: number,
	controller: AbortController,
): Promise<void> {
	const blob = await synthesizeSpeech(spoken, state.ttsVoice ?? undefined, controller.signal);
	if (gen !== speakGeneration) return;
	const previousUrl = activeObjectUrl;
	const url = URL.createObjectURL(blob);
	activeObjectUrl = url;
	audio.pause();
	audio.currentTime = 0;
	audio.src = url;
	audio.playbackRate = state.ttsSpeed;
	if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
	await audio.play();
	if (gen !== speakGeneration) return;
	setSpeakBtnState(currentSpeakSrc, "playing");
	audio.onended = () => {
		if (gen !== speakGeneration) return;
		if (activeObjectUrl === url) {
			URL.revokeObjectURL(url);
			activeObjectUrl = null;
		}
		audio.onended = null;
		setSpeakBtnState(currentSpeakSrc, "idle");
		currentSpeakSrc = null;
	};
}

/**
 * Stop all voice playback and cancel any in-flight TTS synthesis — the
 * global "stop everything" the status-bar button calls. No matter which
 * message's speak button kicked off playback, this halts it: bumps the
 * generation token (so a blob arriving from a still-pending /api/tts
 * request is discarded), aborts that request, pauses the shared
 * <audio>, revokes its object URL, and resets the owning message's
 * speak button back to idle. Safe to call when nothing is playing.
 */
export function stopAllVoice(): void {
	// First, invalidate any in-flight synthesis so its late-arriving blob
	// is dropped by the generation check in speakText(), and abort the
	// fetch so the connection doesn't linger.
	speakGeneration++;
	activeController?.abort();
	activeController = null;

	// Clear the TTS banner if one is up (a stop is a full reset).
	hideToast();

	// Clear any user-pause intent — a stop is a full reset, so a subsequent
	// speak shouldn't start in a paused state, and the status-bar control
	// must not keep showing "paused" once audio is gone.
	userPaused = false;
	state.audioPaused = false;

	const audio = $<HTMLAudioElement>("#tts-audio");
	if (!audio.paused) {
		audio.pause();
		audio.currentTime = 0;
	}
	if (activeObjectUrl) {
		URL.revokeObjectURL(activeObjectUrl);
		activeObjectUrl = null;
	}
	if (currentSpeakSrc !== null) {
		setSpeakBtnState(currentSpeakSrc, "idle");
		currentSpeakSrc = null;
	}
}

/**
 * Pause the currently-playing TTS playback, freezing position within the
 * current chunk. Chunks still arriving from an open /api/tts/stream queue
 * up but the chunk pump won't advance them until resumeVoice(). Safe to
 * call when nothing is playing or when already paused (no-op).
 *
 * Sets an explicit `userPaused` flag rather than just calling audio.pause()
 * because the chunk pump needs to know NOT to advance while paused, and the
 * <audio> 'paused' property alone can't distinguish a user pause from the
 * natural between-chunks gap. The status-bar control flips to a ▶ resume
 * button via state.audioPaused.
 */
export function pauseVoice(): void {
	const audio = $<HTMLAudioElement>("#tts-audio");
	// Nothing to pause: already paused, no src loaded, or playback ended.
	if (userPaused || audio.paused || !audio.src) return;
	userPaused = true;
	audio.pause();
	// Flip state optimistically so the status bar shows the resume button
	// immediately; the 'pause' event listener also clears audioPlaying.
	state.audioPaused = true;
	state.audioPlaying = false;
	refreshStatus();
}

/**
 * Resume playback from where pauseVoice() froze it — continues the current
 * chunk, and once it ends the chunk pump drains any chunks that queued up
 * while paused. No-op if not currently paused.
 */
export function resumeVoice(): void {
	const audio = $<HTMLAudioElement>("#tts-audio");
	// Nothing to resume: not paused, no src, or the loaded chunk already
	// played to its end (a resume here would do nothing useful).
	if (!userPaused || !audio.src || audio.ended) return;
	userPaused = false;
	void audio.play().catch((err) => {
		if (err instanceof DOMException && err.name === "AbortError") return;
		appendError(`tts resume failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	// Flip state optimistically; the 'play' event confirms audioPlaying=true.
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
	const audio = $<HTMLAudioElement>("#tts-audio");
	// If this exact source is what's currently playing, the second
	// press is a "stop" — pause and reset, mirroring the auto-speak
	// off-path. Otherwise start (or switch to) this message.
	if (!audio.paused && currentSpeakSrc === src) {
		audio.pause();
		audio.currentTime = 0;
		currentSpeakSrc = null;
		setSpeakBtnState(src, "idle");
		return;
	}
	// Switching source: clear the previous button's stop indicator.
	if (currentSpeakSrc !== null) setSpeakBtnState(currentSpeakSrc, "idle");
	currentSpeakSrc = src;
	// Don't flip to playing yet — speakText() will show a spinner while
	// synthesizing, then flip to ⏹ once playback actually starts.
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
