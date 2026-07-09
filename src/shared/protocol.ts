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

// ---------------------------------------------------------------------------
// Projects (selectable workspaces, each with its own AGENTS.md + cwd)
// ---------------------------------------------------------------------------
//
// A Project is a named workspace whose folder is the `cwd` passed to
// `pi --mode rpc`. Its instructions live in `<cwd>/AGENTS.md`, which pi
// auto-loads — so a Project is literally "a folder pi already understands".
// Session→Project membership is derived from cwd, never stored.

/** A project summary sent to the client (mirrors `ProjectRecord` in src/server/projects.ts). */
export interface ProjectSummary {
	id: string;
	name: string;
	icon: string;
	cwd: string;
	builtin?: boolean;
	defaultModelId?: string | null;
	defaultProvider?: string | null;
	defaultThinkingLevel?: ThinkingLevel | null;
}

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
	/**
	 * True if the user pinned this session to the top of the sidebar.
	 * Pin state is stored server-side in `data/pins.json` (NOT in pi's
	 * session JSONL — pi has no pin concept), so it syncs across devices.
	 * `title`, by contrast, comes from pi's `set_session_name` /
	 * `session_info` line and is inherently cross-device.
	 */
	pinned?: boolean;
	/**
	 * The project this session belongs to, derived from its cwd
	 * (matched against the project list server-side). `"global"` when
	 * the cwd is config.piCwd; absent/"other" only if the cwd matches
	 * no known project (a deleted project's orphaned sessions).
	 */
	projectId?: string;
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
			/**
			 * Whether pi is mid-run (between agent_start and agent_end),
			 * reported by the server from the events it already observes as
			 * a transport pipe. Lets a freshly-loaded tab (hard refresh,
			 * which wipes the browser's local isStreaming) recover the
			 * correct state so the Stop button stays visible/correct.
			 */
			isStreaming?: boolean;
	  }
	| { type: "event"; event: Record<string, unknown> }
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "transcript"; sessionId: string; messages: Message[] }
	| { type: "projects"; projects: ProjectSummary[] }
	| { type: "ping" }
	| { type: "error"; message: string }
	/** Reply to forkSession: the new session's id, ready to resume. */
	| { type: "forked"; sessionId: string }
	/**
	 * Confirms a model or thinking-level change. Sent by the server
	 * after `set_model` / `set_thinking_level` returns from pi (success
	 * or failure). Carries the session's CURRENT model+thinking — i.e.
	 * the same model pi is actually using, NOT the user's last click if
	 * that click was rejected (e.g. a model id that isn't in pi's
	 * registry). The client adopts this to keep the picker truthful
	 * without waiting for a page refresh.
	 */
	| {
			type: "modelState";
			provider: string;
			modelId: string;
			thinkingLevel: ThinkingLevel;
	  };

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
	| { type: "abortRetry" }
	| { type: "setModel"; modelId: string; provider: string }
	/**
	 * User picked a new default image model in the picker (e.g. for the
	 * `venice_generate_image` tool). Server persists it to a file
	 * (`/home/lepton/.config/acb/image-model`) that the pi-venice-image
	 * extension reads on each tool call — live update, no respawn.
	 * `modelId` may be `null` to clear the override (tool falls back to
	 * the extension's own default).
	 */
	| { type: "setImageModel"; modelId: string | null }
	| { type: "setThinking"; level: ThinkingLevel }
	| { type: "listSessions" }
	| { type: "resumeSession"; sessionId: string }
	/**
	 * Start a fresh session. `projectId` selects which project's cwd the
	 * new `pi` child runs in (defaults to Global = config.piCwd).
	 * Instructions for that project come from its AGENTS.md, which pi
	 * auto-loads from cwd — no system-prompt wiring needed.
	 */
	| { type: "newSession"; projectId?: string }
	| { type: "renameSession"; name: string }
	/**
	 * Rename ANY session (not just the current one) by id. The server
	 * appends a `session_info` line to that session's JSONL (pi's own
	 * persistence format), so the rename is visible to every device and
	 * survives across browsers. `renameSession` (above) still exists for
	 * renaming the *current* session via the live pi child (`/name`).
	 */
	| { type: "renameSessionById"; sessionId: string; name: string }
	/**
	 * Pin or unpin ANY session (not just the current one) to the top of
	 * the sidebar. Server writes it to `data/pins.json` and rebroadcasts
	 * the session list to every connected client so all devices stay in
	 * sync. Pin state is agentchatbox UI state, not pi state — there is no
	 * pi RPC for it.
	 */
	| { type: "setSessionPinned"; sessionId: string; pinned: boolean }
	/**
	 * Fork (branch) a session into a new one. The server copies the
	 * source session's JSONL — its `session` header rewritten with a
	 * fresh id/timestamp, plus the first `messageCount` `type:"message"`
	 * entries (and any interleaved metadata lines within that range) —
	 * into a brand-new session file in the same cwd. Replies with
	 * `{type:"forked", sessionId}` so the client can resumeSession the
	 * fork. The source session is left untouched. Pure filesystem
	 * copying of pi's own persistence format; no agent logic crosses
	 * the transport boundary.
	 */
	| { type: "forkSession"; sessionId: string; messageCount: number }
	// --- Projects ---------------------------------------------------------
	| { type: "listProjects" }
	| {
			type: "createProject";
			name: string;
			icon?: string;
			instructions?: string;
			defaultModelId?: string | null;
			defaultProvider?: string | null;
			defaultThinkingLevel?: ThinkingLevel | null;
	  }
	| {
			type: "updateProject";
			id: string;
			name?: string;
			icon?: string;
			instructions?: string;
			defaultModelId?: string | null;
			defaultProvider?: string | null;
			defaultThinkingLevel?: ThinkingLevel | null;
	  }
	| { type: "deleteProject"; id: string }
	| { type: "reorderProjects"; order: string[] };

// Re-export the AgentEvent union so existing client code that imports
// `AgentEvent` from this file keeps working. The client doesn't use
// AgentEvent directly (the wire format is whatever `pi` emits), but
// some files still import the type for renderer-side switch coverage.
export type { AgentEvent };
