/**
 * Shared types between client and server.
 *
 * The client (in the browser) talks to the server (Node) using these shapes.
 * The LLM stream is forwarded as Server-Sent Events, one event per
 * `AssistantMessageEvent` from `@earendil-works/pi-ai`.
 */

import type {
	Api,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

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
