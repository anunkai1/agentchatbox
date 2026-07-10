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

export async function uploadFile(file: File): Promise<UploadResponse> {
	const form = new FormData();
	form.append("file", file);
	const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`upload failed: ${res.status} ${text}`);
	}
	return (await res.json()) as UploadResponse;
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
	/** TTS engine id from /api/health: "kokoro" or "piper". Drives the
	 * banner label so it reflects the actually-configured engine. */
	ttsEngine?: string;
	/** Server-default TTS voice (kokoro/piper). */
	ttsVoice?: string;
	/** Configured spoken-rewrite model override from /api/health
	 * ("provider/modelId"), used so the TTS banner names the model actually
	 * doing the rewrite, not the session model. */
	voiceRewriteModel?: string;
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

/** Capabilities of the pi Agent — what tools, skills, extensions are loaded. */
export interface CapabilitiesInfo {
	packages: CapabilityPackage[];
	tools: CapabilityTool[];
	skills: CapabilitySkill[];
}

export interface CapabilityPackage {
	name: string;
	path: string;
	version?: string;
	description?: string;
}

export interface CapabilityTool {
	name: string;
	/** Package that provides this tool */
	package: string;
}

export interface CapabilitySkill {
	name: string;
	/** Package that provides this skill */
	package: string;
}

/** Returns the tools, skills, and extensions that pi has loaded. */
/**
 * Whether a session id is known to the server for this cwd. Used by the
 * client to validate a shareable `/s/<id>` link before resuming: a stale
 * link (session deleted, or shared from another machine/project) should
 * start a fresh chat rather than hand `pi` a missing session id.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
	try {
		const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}`);
		return res.ok;
	} catch {
		return false;
	}
}

export async function getCapabilities(): Promise<CapabilitiesInfo> {
	const res = await fetch(`${BASE}/api/capabilities`);
	if (!res.ok) throw new Error(`capabilities failed: ${res.status}`);
	return (await res.json()) as CapabilitiesInfo;
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
