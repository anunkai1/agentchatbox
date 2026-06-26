/**
 * Shared types between client and server.
 *
 * The client (in the browser) talks to the server (Node) using these shapes.
 *
 * Transport: a single WebSocket at `/api/chat` — the client sends prompts,
 * the server forwards every `pi --mode rpc` event as JSON.
 *
 * The `/api/chat` WS protocol is a thin envelope around the upstream
 * `pi --mode rpc` protocol (see /usr/lib/node_modules/@earendil-works/
 * pi-coding-agent/docs/rpc.md). Every line of `pi`'s stdout is forwarded
 * to the browser as `{type: "event", event: <line>}` — the same
 * `pi` event the TUI would see, unchanged.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

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
// Wire format: one JSON object per message. No envelopes.
//
// Handshake: the client must send `{type:"init",...}` as its FIRST message
// after the WS opens. The server uses it to spawn a `pi --mode rpc` child
// with the right provider, model, thinking level, and (optionally) resume
// a session by id. After the init, the server sends `{type:"ready"}` so
// the client knows the child is up; from then on, pi events flow as
// `{type:"event", event: <line>}`.
//
// Server → client:
//   { type: "ready", modelId, provider, thinkingLevel, sessionId? }
//       after the child is spawned and we've gotten its first `session`
//       line. Lets the client know the model/thinking it should display.
//   { type: "event", event: <piRpcLine> }
//       every parsed NDJSON line from `pi`'s stdout, verbatim.
//   { type: "sessions", sessions: SessionSummary[] }
//       response to client.listSessions()
//   { type: "transcript", sessionId, messages: Message[] }
//       on resume: the prior transcript replayed before live events flow
//   { type: "error", message }
//
// Note: there is no separate "sessionResumed" message. newSession /
// resumeSession respawn the `pi` child, which re-emits `ready` (and
// `transcript` for resume) — the client reacts to those.
//       unrecoverable error (child spawn failed, etc.)
//   { type: "ping" }
//       heartbeat sent every ~20s. The client uses it to detect
//       dead connections (e.g. Android killing the WS when the tab
//       is backgrounded) — if no message arrives for ~40s the client
//       treats the socket as wedged and reconnects.
//
// Client → server:
//   { type: "init", provider, modelId, thinkingLevel, sessionId? }
//       FIRST message after open. Spawns the `pi` child.
//   { type: "prompt", text, images? }
//       send a user prompt (with optional images). Translated to the
//       `pi` `prompt` RPC command.
//   { type: "steer", text, images? }
//       queue a steering message while the agent is running. Delivered
//       after the current assistant turn finishes its tool calls,
//       before the next LLM call. Translated to `pi` `steer`.
//   { type: "abort" }
//       abort the current run. Translated to `pi` `abort`.
//   { type: "setModel", modelId, provider }
//       in-process model switch. Translated to `pi` `set_model`.
//   { type: "setThinking", level }
//       in-process thinking level change. Translated to `pi`
//       `set_thinking_level`.
//   { type: "listSessions" }
//       request the list of saved sessions (server reads the JSONL
//       directory; replies with `{type:"sessions",...}`).
//   { type: "resumeSession", sessionId }
//       kill current child, spawn `pi --session <id>`, replay
//       transcript, then forward live events. The new child emits a
//       fresh `ready` (and a `transcript` replay) the client reacts to.
//   { type: "newSession" }
//       kill current child, spawn a fresh one (no --session). The new
//       child emits a fresh `ready` the client reacts to.
//   { type: "renameSession", name }
//       Translated to `pi` `set_session_name`.

import type { ThinkingLevel as ThinkingLevelSdk } from "@earendil-works/pi-agent-core";
export type ThinkingLevel = ThinkingLevelSdk;

/** Base64-encoded image attached to a user prompt. */
export interface PromptImage {
	/** Base64-encoded image bytes (no data: URL prefix). */
	data: string;
	/** MIME type, e.g. "image/jpeg", "image/png". */
	mimeType: string;
}

/**
 * A summary of a `pi` session for the `/sessions` picker. Mirrors the
 * shape of `SessionSummary` in `src/server/session-list.ts`. The two
 * are kept in lockstep because the server's REST endpoint returns the
 * same JSON the WS `sessions` message returns.
 */
export interface SessionSummary {
	id: string;
	cwd: string;
	createdAt: string;
	modifiedAt: string;
	title: string;
	messageCount: number;
}

/** A replayed prior transcript: the session id plus its `Message` entries,
 *  read back from `pi`'s session JSONL. Typed as the SDK's `Message` union
 *  (user / assistant / toolResult) because that's exactly what `pi` writes
 *  to disk on every `type: "message"` line. */
export interface TranscriptPayload {
	sessionId: string;
	messages: Message[];
}

/** Server → client. */
export type ServerMessage =
	| {
			type: "ready";
			modelId: string;
			provider: string;
			thinkingLevel: ThinkingLevel;
			sessionId?: string;
	  }
	| { type: "event"; event: Record<string, unknown> }
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "transcript"; sessionId: string; messages: Message[] }
	| { type: "ping" }
	| { type: "error"; message: string };

/** Client → server. */
export type ClientMessage =
	| {
			type: "init";
			provider: string;
			modelId: string;
			thinkingLevel: ThinkingLevel;
			sessionId?: string;
	  }
	| { type: "prompt"; text: string; images?: PromptImage[] }
	| { type: "steer"; text: string; images?: PromptImage[] }
	| { type: "abort" }
	| { type: "setModel"; modelId: string; provider: string }
	| { type: "setThinking"; level: ThinkingLevel }
	| { type: "listSessions" }
	| { type: "resumeSession"; sessionId: string }
	| { type: "newSession" }
	| { type: "renameSession"; name: string };

// Re-export the AgentEvent union so existing client code that imports
// `AgentEvent` from this file keeps working. The client doesn't use
// AgentEvent directly (the wire format is whatever `pi` emits), but
// some files still import the type for renderer-side switch coverage.
export type { AgentEvent };
