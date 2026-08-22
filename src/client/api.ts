/**
 * Client-side API for talking to the agentchatbox server.
 *
 * Browser no longer runs the pi Agent. It just opens a WebSocket to
 * `/api/chat` and listens for events. The server owns the Agent and its
 * tools.
 *
 * This file is kept around for the bits that are NOT the chat agent:
 *   - /api/upload — file attachments
 *   - /api/transcribe — voice notes (server runs local faster-whisper)
 *   - /api/health — server liveness + configured providers
 */

import type { TranscribeResponse, UploadResponse, VoicesResponse } from "../shared/protocol.js";

const BASE = ""; // same origin

export interface UploadProgress {
	loaded: number;
	total: number;
}

/**
 * Upload one attachment with browser-native upload progress. fetch() does not
 * expose request-body progress, so this intentionally uses XMLHttpRequest.
 */
export function uploadFile(
	file: File,
	onProgress?: (progress: UploadProgress) => void,
	signal?: AbortSignal,
): Promise<UploadResponse> {
	const form = new FormData();
	form.append("file", file);

	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const abort = () => xhr.abort();
		const cleanupAbortListener = () => signal?.removeEventListener("abort", abort);
		if (signal?.aborted) {
			reject(new Error("upload cancelled"));
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		xhr.open("POST", `${BASE}/api/upload`);
		xhr.responseType = "text";
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) {
				onProgress?.({ loaded: event.loaded, total: event.total });
			} else {
				onProgress?.({ loaded: event.loaded, total: file.size });
			}
		};
		xhr.onerror = () => {
			cleanupAbortListener();
			reject(new Error("upload failed: network error"));
		};
		xhr.onabort = () => {
			cleanupAbortListener();
			reject(new Error("upload cancelled"));
		};
		xhr.onload = () => {
			cleanupAbortListener();
			const text = xhr.responseText;
			if (xhr.status < 200 || xhr.status >= 300) {
				const detail =
					xhr.status === 413
						? "file is larger than the server upload limit"
						: text.trim().startsWith("<")
							? "the server rejected the upload"
							: text.trim().slice(0, 300) || "the server rejected the upload";
				reject(new Error(`upload failed (${xhr.status}): ${detail}`));
				return;
			}
			try {
				resolve(JSON.parse(text) as UploadResponse);
			} catch {
				reject(new Error("upload failed: server returned an invalid response"));
			}
		};
		xhr.send(form);
	});
}

export async function transcribeAudio(blob: Blob, filename = "voice.webm"): Promise<string> {
	const form = new FormData();
	form.append("audio", blob, filename);
	const res = await fetch(`${BASE}/api/transcribe`, {
		method: "POST",
		body: form,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`transcribe failed: ${res.status} ${text}`);
	}
	const data = (await res.json()) as TranscribeResponse;
	return data.text;
}

export interface HealthInfo {
	status: "ok";
	providers: string[];
	whisper: boolean;
	whisperReason?: string;
	tts: boolean;
	ttsReason?: string;
	/** TTS engine id from /api/health (always "kokoro" — Piper was removed).
	 * Drives the banner label so it reflects the configured engine. */
	ttsEngine?: string;
	/** Server-default TTS voice. */
	ttsVoice?: string;
	/** Configured spoken-rewrite model override from /api/health
	 * ("provider/modelId"), used so the TTS banner names the model actually
	 * doing the rewrite, not the session model. */
	voiceRewriteModel?: string;
	/** Whisper (STT) model id in use (e.g. "base", "medium"). Display-only. */
	whisperModel?: string;
	/** Resolved image-generation model (pi-venice-image), with provenance:
	 * "override" = ~/.config/acb/image-model, "env" = VENICE_IMAGE_MODEL,
	 * "default" = z-image-turbo. Display-only mirror of the extension's chain. */
	imageModel?: { model: string; source: "override" | "env" | "default" };
	/** Resolved vision (image/video analysis) model + mode, mirroring
	 * pi-multimodal-proxy: PI_VISION_PROXY_MODEL env → multimodal-proxy.json
	 * → default anthropic/claude-sonnet-4-5. mode is fallback/always/off. */
	visionModel?: {
		model: string;
		source: "env" | "config" | "default";
		mode: "fallback" | "always" | "off";
	};
	/** Whether the Gemini key is configured for pi-web-access (web search /
	 * fetch / YouTube transcripts). The model itself is implicit in the
	 * extension, so only key presence is reported. */
	geminiKey?: boolean;
	/**
	 * Whether semantic session search is enabled on this server. When false,
	 * the sidebar shows no search box. An optional, pluggable feature — see
	 * src/server/search/.
	 */
	search?: boolean;
}

export async function getHealth(): Promise<HealthInfo> {
	const res = await fetch(`${BASE}/api/health`);
	if (!res.ok) throw new Error(`health failed: ${res.status}`);
	return (await res.json()) as HealthInfo;
}

/** A single model entry returned by /api/models. */
export interface ModelInfo {
	id: string;
	provider: string;
	name: string;
	reasoning: boolean;
	thinkingLevels: import("../shared/thinking.js").ThinkingLevel[];
}

/**
 * Returns the list of models the client can pick from. Only includes
 * providers that have an API key configured on the server.
 */
export async function getModels(): Promise<ModelInfo[]> {
	const res = await fetch(`${BASE}/api/models`);
	if (!res.ok) throw new Error(`models failed: ${res.status}`);
	const data = (await res.json()) as { models: ModelInfo[] };
	return data.models;
}

/**
 * Local TTS via /api/tts. Returns the WAV bytes. Caller is responsible
 * for turning them into playable audio (we use a single shared <audio>
 * element in the renderer to avoid multiple voices overlapping).
 */
export async function synthesizeSpeech(
	text: string,
	voice?: string,
	signal?: AbortSignal,
): Promise<Blob> {
	const res = await fetch(`${BASE}/api/tts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, voice }),
		signal,
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`tts failed: ${res.status} ${body.slice(0, 200)}`);
	}
	return await res.blob();
}

/**
 * Streaming TTS via /api/tts/stream. Yields one WAV Blob per synthesized
 * text chunk, in playback order, the instant each is ready — so the caller
 * can start playing the first chunk while later chunks are still being
 * synthesized. This is what makes long voice replies feel responsive
 * instead of stalling for seconds on end before the first sound.
 *
 * The body is a binary frame stream (one frame per chunk):
 *   [1 byte type][uint32 LE length N][N bytes payload]
 *     0x01 DATA → payload = a complete WAV file for one chunk
 *     0x00 END  → clean end of stream
 *     0x80 ERR  → payload = UTF-8 error message
 *
 * Throws on a non-OK HTTP status (caller falls back to synthesizeSpeech)
 * or on an ERR frame arriving mid-stream.
 */
export async function* streamSynthesizeSpeech(
	text: string,
	voice?: string,
	signal?: AbortSignal,
): AsyncGenerator<Blob> {
	const res = await fetch(`${BASE}/api/tts/stream`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, voice }),
		signal,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`tts stream failed: ${res.status} ${body.slice(0, 200)}`);
	}
	if (!res.body) throw new Error("tts stream: empty response body");

	const reader = res.body.getReader();
	// Sliding byte buffer: we may receive partial frames or several frames
	// coalesced in one network chunk, so we accumulate and parse on demand.
	let buf = new Uint8Array(0);
	const append = (chunk: Uint8Array): void => {
		const next = new Uint8Array(buf.length + chunk.length);
		next.set(buf, 0);
		next.set(chunk, buf.length);
		buf = next;
	};
	const ensure = async (n: number): Promise<boolean> => {
		while (buf.length < n) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (value) append(value);
		}
		return true;
	};
	try {
		while (true) {
			if (!(await ensure(5))) return; // need the 5-byte frame header
			const type = buf[0]!;
			const len = (buf[1]! | (buf[2]! << 8) | (buf[3]! << 16) | (buf[4]! << 24)) >>> 0;
			if (!(await ensure(5 + len))) return; // need the full payload
			const payload = buf.subarray(5, 5 + len);
			buf = buf.subarray(5 + len);
			if (type === 0x01) {
				// Detach into its own buffer so the Blob owns it independently of
				// our read buffer (which keeps growing as more frames arrive).
				yield new Blob([payload.slice()], { type: "audio/wav" });
			} else if (type === 0x80) {
				throw new Error(new TextDecoder().decode(payload) || "tts stream error");
			} else if (type === 0x00) {
				return; // END
			}
			// Unknown frame types are skipped (forward-compatible).
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* already released */
		}
	}
}

/**
 * Whether a session id is known to the server. Used by the client to
 * validate a shareable `/s/<id>` link before resuming: a stale link
 * (session deleted, or shared from another machine) should start a
 * fresh chat rather than hand `pi` a missing session id. The server
 * searches every known project cwd (+ orphans), so a link to a
 * PROJECT chat survives a refresh — no project needs to be encoded
 * in the URL.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
	try {
		const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
			method: "HEAD",
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function listVoices(): Promise<VoicesResponse> {
	const res = await fetch(`${BASE}/api/tts/voices`);
	if (!res.ok) throw new Error(`voices failed: ${res.status}`);
	return (await res.json()) as VoicesResponse;
}

/** One semantic search hit returned by /api/sessions/search. */
export interface SessionSearchHit {
	sessionId: string;
	msgIdx: number;
	role: string;
	snippet: string;
	createdAt: string;
	similarity: number;
	title: string;
	modifiedAt: string;
	messageCount: number;
}

/**
 * Semantic search across saved session transcripts. Returns messages whose
 * meaning is closest to `query`, regardless of exact wording. Only available
 * when the server reports `search: true` in /api/health.
 */
export async function searchSessions(query: string, limit = 10): Promise<SessionSearchHit[]> {
	const url = `${BASE}/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`search failed: ${res.status}`);
	const data = (await res.json()) as { results: SessionSearchHit[] };
	return data.results;
}
