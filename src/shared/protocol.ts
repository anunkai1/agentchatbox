/**
 * Shared types between client and server.
 *
 * The client (in the browser) talks to the server (Node) using these shapes.
 *
 * Two transport channels:
 *   1. POST /api/stream (legacy) — raw LLM streaming proxy (SSE out).
 *      Used as a back-compat path while the WS-based agent lives in /api/chat.
 *   2. WS  /api/chat   (new)     — bidirectional: client sends prompts,
 *      server forwards every pi Agent event as JSON.
 */

import type {
	Api,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

/** POST body for /api/stream: a single LLM call proxied through the server. */
export interface StreamRequest {
	model: Model<Api>;
	context: Context;
	options?: SimpleStreamOptions;
}

/** An SSE frame is just an AssistantMessageEvent from the LLM stream. */
export type StreamEvent = AssistantMessageEvent;

/** Multipart upload response. */
export interface UploadResponse {
	id: string;
	filename: string;
	mimeType: string;
	size: number;
	/** Public URL the browser can use to download or preview the file. */
	url: string;
}

/** Transcription response. */
export interface TranscribeResponse {
	text: string;
}

/** /api/tts/voices response. */
export interface VoicesResponse {
	default: string;
	available: string[];
}

// ---------------------------------------------------------------------------
// WebSocket protocol for /api/chat
// ---------------------------------------------------------------------------
//
// Wire format: one JSON object per message. No envelopes, no envelopes, no
// envelopes. We use plain WS frames because the events are small and frequent
// and the round-trip cost of envelope parsing would dominate.
//
// Server → client:
//   { type: "ready" }                                     after the Agent is built
//   { type: "event", event: AgentEvent }                  for every pi Agent event
//   { type: "error", message: string }                    unrecoverable error
//
// Client → server:
//   { type: "prompt", text: string }                      send a user prompt
//   { type: "abort" }                                     abort the current run
//   { type: "setModel", modelId: string, provider: string } swap model mid-session
//   { type: "setThinking", level: ThinkingLevel }        swap thinking level
//
// `init` is implicit: the server uses defaults (M3, thinking=high) on first
// connect. `setModel` is the only model switcher. We do not accept a model
// from the client at init time — the server is the source of truth for
// model availability.

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high";

/** Server → client. */
export type ServerMessage =
	| { type: "ready"; modelId: string; provider: string; thinkingLevel: ThinkingLevel }
	| { type: "event"; event: AgentEvent }
	| { type: "error"; message: string };

/** Client → server. */
export type ClientMessage =
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "setModel"; modelId: string; provider: string }
	| { type: "setThinking"; level: ThinkingLevel };
