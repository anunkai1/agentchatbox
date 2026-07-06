/**
 * Voice (TTS) and file/voice recording. The browser still owns these:
 *
 *   - speakText(): POST to /api/tts, play the WAV in the shared <audio>
 *   - toggleAutoSpeak(): header toggle that asks the live event
 *     dispatcher to fire speakText() for every final assistant message
 *   - handleFileAttach(): POST to /api/upload, remember base64 bytes for
 *     multimodal models, insert a markdown link into the input
 *   - handleVoiceRecord(): MediaRecorder → POST to /api/transcribe →
 *     paste the transcript into the input
 */

import { transcribeAudio, uploadFile } from "./api.js";
import { $ } from "./dom.js";
import { markdownToSpeechText } from "./markdown.js";
import { appendError, refreshStatus } from "./render.js";
import { state } from "./state.js";
import { saveSessionPrefs } from "./prefs.js";

/**
 * Soft cap on what we send to TTS. The server hard-rejects anything over
 * 4096 chars (MAX_TEXT_CHARS in tts.ts) with a 413, which surfaces to the
 * user as an error. To avoid that we cap client-side, leaving room for the
 * markdown→speech transform to expand things slightly and for a small
 * trailing cue when we truncate.
 */
const TTS_MAX_CHARS = 3800;

/**
 * Identity (opaque token) of whatever source is currently driving
 * playback, so the speak buttons can implement play/stop toggle
 * semantics. Set by toggleSpeak() and cleared when playback stops.
 * Direct speakText() calls (e.g. from auto-speak) leave this null,
 * which is correct: nothing for a button to "stop" in that case.
 */
let currentSpeakSrc: unknown = null;

/**
 * The currently-active object URL feeding the <audio> element, tracked
 * so we can revoke it safely on swap or end without racing a newer URL.
 * null when nothing is loaded.
 */
let activeObjectUrl: string | null = null;

/**
 * Synthesize the given text via /api/tts and play it on the shared <audio>.
 * One call at a time — starting a new one stops the current playback.
 */
export async function speakText(text: string): Promise<void> {
	// Strip markdown before synthesis: the raw text off the wire is full
	// of **bold**, ### headings, ``` fences, [label](url) links, etc. that
	// piper would read aloud as literal sigils. See markdown.ts.
	let spoken = markdownToSpeechText(text);
	if (!spoken) return;
	if (spoken.length > TTS_MAX_CHARS) {
		spoken = `${spoken.slice(0, TTS_MAX_CHARS)} … message truncated.`;
	}
	const audio = $<HTMLAudioElement>("#tts-audio");
	state.ttsInFlight++;
	refreshStatus();
	try {
		const { synthesizeSpeech } = await import("./api.js");
		const blob = await synthesizeSpeech(spoken, state.ttsVoice ?? undefined);
		// Swap the source AFTER the new blob is ready, so the previous
		// playback isn't interrupted during the (slow) synth round-trip —
		// pausing the element early lets Android's media session drop it
		// and can stall playback mid-way through.
		// Keep the previous URL alive until the new src is set, then revoke.
		const previousUrl = activeObjectUrl;
		const url = URL.createObjectURL(blob);
		activeObjectUrl = url;
		audio.pause();
		audio.currentTime = 0;
		audio.src = url;
		audio.playbackRate = state.ttsSpeed;
		if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
		await audio.play();
		// Revoke object URL after playback ends (or on next speak), and
		// clear the active source so a subsequent click re-plays rather
		// than being mistaken for a "stop the same thing" toggle.
		audio.onended = () => {
			if (activeObjectUrl === url) {
				URL.revokeObjectURL(url);
				activeObjectUrl = null;
			}
			audio.onended = null;
			setSpeakBtnLabel(currentSpeakSrc, false);
			currentSpeakSrc = null;
		};
	} catch (err) {
		appendError(`tts failed: ${err instanceof Error ? err.message : String(err)}`);
		setSpeakBtnLabel(currentSpeakSrc, false);
		currentSpeakSrc = null;
	} finally {
		state.ttsInFlight--;
		refreshStatus();
	}
}

/**
 * Play/stop toggle for the per-message speak buttons. `src` is an
 * opaque identity token (typically the calling button element) so we
 * can tell "I'm the one currently playing — second press stops me"
 * from "a different message is playing — switch to this one".
 * Direct auto-speak doesn't go through here, so it never registers a
 * src and a button press always starts fresh.
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
		setSpeakBtnLabel(src, false);
		return;
	}
	// Switching source: clear the previous button's stop indicator.
	if (currentSpeakSrc !== null) setSpeakBtnLabel(currentSpeakSrc, false);
	currentSpeakSrc = src;
	setSpeakBtnLabel(src, true);
	void speakText(text);
}

/**
 * Toggle a source button's label between 🔊 (idle) and ⏹ (playing /
 * stoppable), if the source is a DOM element exposing `.textContent`.
 * Silent no-op for non-element sources so toggleSpeak stays generic.
 */
function setSpeakBtnLabel(src: unknown, playing: boolean): void {
	if (!(src instanceof HTMLElement)) return;
	src.textContent = playing ? "⏹" : "🔊";
	src.title = playing ? "Stop playback" : "Speak this message (local TTS)";
}

export function toggleAutoSpeak(): void {
	state.autoSpeak = !state.autoSpeak;
	saveSessionPrefs();
	const btn = $<HTMLButtonElement>("#tts-toggle");
	btn.classList.toggle("active", state.autoSpeak);
	btn.textContent = state.autoSpeak ? "🔊 on" : "🔇 off";
	// Turning it off should also stop any speech that's playing,
	// so a 2nd press actually silences the audio.
	if (!state.autoSpeak) {
		const audio = $<HTMLAudioElement>("#tts-audio");
		audio.pause();
		audio.currentTime = 0;
	}
	refreshStatus();
}

// ---------------------------------------------------------------------------
// File attach
// ---------------------------------------------------------------------------

/**
 * Shared core: take a list of File objects (from the file picker, a
 * paste, or a drag-and-drop) and upload each one, remembering image
 * bytes for multimodal models and inserting a markdown link into the
 * input. The file picker resets its own .value; callers that don't
 * come from an <input type=file> simply pass an empty Event-less path.
 */
export async function attachFiles(files: File[]): Promise<void> {
	if (files.length === 0) return;
	const ta = $<HTMLTextAreaElement>("#input");
	for (const file of files) {
		try {
			// Run the upload and the base64 conversion in parallel —
			// they're independent. (Previously these were sequential,
			// which created a race: the user could send the message
			// during the uploadFile await, and the base64 wouldn't
			// be in state.uploadedImages yet — so the model never
			// saw the image bytes.)
			const [res, data] = await Promise.all([uploadFile(file), blobToBase64(file)]);
			if (res.mimeType.startsWith("image/")) {
				state.uploadedImages.set(res.url, {
					data,
					mimeType: res.mimeType,
					filename: res.filename,
				});
			}
			const insertion = res.mimeType.startsWith("image/")
				? `\n[image: ${res.filename}](${res.url})`
				: `\n[file: ${res.filename}](${res.url})`;
			ta.value = `${ta.value} ${insertion}`.trim();
			import("./render.js").then(({ autoSize }) => autoSize());
		} catch (err) {
			appendError(err instanceof Error ? err.message : String(err));
		}
	}
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

/** Convert a Blob to a base64 string (no data: URL prefix). */
function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("FileReader returned non-string"));
				return;
			}
			// Strip the "data:<mime>;base64," prefix.
			const comma = result.indexOf(",");
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
		reader.readAsDataURL(blob);
	});
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
			stream.getTracks().forEach((t) => {
				t.stop();
			});
			const blob = new Blob(recordedChunks, { type: "audio/webm" });
			const secs = (Date.now() - recordingStart) / 1000;
			$("#status-bar").textContent = `transcribing ${secs.toFixed(1)}s of audio…`;
			try {
				const text = await transcribeAudio(blob);
				$<HTMLTextAreaElement>("#input").value = text;
				import("./render.js").then(({ autoSize }) => autoSize());
				$("#status-bar").textContent = `transcribed (${text.length} chars). Press Enter to send.`;
			} catch (err) {
				appendError(`transcription failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		};
		recordingStart = Date.now();
		mediaRecorder.start();
		$<HTMLButtonElement>("#voice-btn").textContent = "⏹";
		$("#status-bar").textContent = "recording… click ⏹ to stop";
	} catch (err) {
		appendError(`microphone access denied: ${err instanceof Error ? err.message : String(err)}`);
	}
}
