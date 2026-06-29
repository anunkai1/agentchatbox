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
	ttsVoice?: string;
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
export async function synthesizeSpeech(text: string, voice?: string): Promise<Blob> {
	const res = await fetch(`${BASE}/api/tts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, voice }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`tts failed: ${res.status} ${body.slice(0, 200)}`);
	}
	return await res.blob();
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
