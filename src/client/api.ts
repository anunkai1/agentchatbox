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

import type { UploadResponse, TranscribeResponse } from "../shared/protocol.js";

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
	const res = await fetch(`${BASE}/api/transcribe`, { method: "POST", body: form });
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
}

export async function getHealth(): Promise<HealthInfo> {
	const res = await fetch(`${BASE}/api/health`);
	if (!res.ok) throw new Error(`health failed: ${res.status}`);
	return (await res.json()) as HealthInfo;
}
