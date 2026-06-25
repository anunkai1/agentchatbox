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
import { appendError, refreshStatus } from "./render.js";
import { state } from "./state.js";

/**
 * Synthesize the given text via /api/tts and play it on the shared <audio>.
 * One call at a time — starting a new one stops the current playback.
 */
export async function speakText(text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) return;
	const audio = $<HTMLAudioElement>("#tts-audio");
	state.ttsInFlight++;
	refreshStatus();
	try {
		// Stop any current playback.
		audio.pause();
		audio.currentTime = 0;
		const { synthesizeSpeech } = await import("./api.js");
		const blob = await synthesizeSpeech(trimmed, state.ttsVoice ?? undefined);
		const url = URL.createObjectURL(blob);
		audio.src = url;
		audio.playbackRate = state.ttsSpeed;
		await audio.play();
		// Revoke object URL after playback ends (or on next speak).
		audio.onended = () => {
			URL.revokeObjectURL(url);
			audio.onended = null;
		};
	} catch (err) {
		appendError(`tts failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		state.ttsInFlight--;
		refreshStatus();
	}
}

export function toggleAutoSpeak(): void {
	state.autoSpeak = !state.autoSpeak;
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

export async function handleFileAttach(e: Event): Promise<void> {
	const input = e.target as HTMLInputElement;
	const files = input.files;
	if (!files || files.length === 0) return;
	const ta = $<HTMLTextAreaElement>("#input");
	for (const file of Array.from(files)) {
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
	input.value = "";
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
