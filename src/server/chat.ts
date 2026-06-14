/**
 * WebSocket endpoint: /api/chat
 *
 * One Agent per connection. The server:
 *   1. accepts a WS connection
 *   2. constructs an Agent (with the local tools)
 *   3. forwards every Agent event to the client
 *   4. accepts prompts, aborts, model switches from the client
 *   5. on disconnect, aborts the current run and lets GC clean up
 *
 * Stateless across connections. Sessions are persisted in the browser's
 * IndexedDB (history of past runs) and we don't replicate that on the
 * server. The server only knows about the current run.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Agent, type ThinkingLevel as ThinkingLevelSdk } from "@earendil-works/pi-agent-core";
import { createAgent, DEFAULT_MODEL_ID, DEFAULT_PROVIDER, DEFAULT_THINKING } from "./agent.js";
import type { ClientMessage, ServerMessage, ThinkingLevel, PromptImage } from "../shared/protocol.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

export function mountChatWs(server: HttpServer): void {
	const wss = new WebSocketServer({ server, path: "/api/chat" });

	wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
		handleConnection(ws).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			sendError(ws, `failed to start session: ${message}`);
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		});
	});

	console.log("chat: ws listening on /api/chat");
}

async function handleConnection(ws: WebSocket): Promise<void> {
	// Build the agent with defaults. A future protocol can let the client
	// override the model at init time, but for now we use the locked-in
	// defaults (M3, thinking=high).
	const built = createAgent({
		modelId: DEFAULT_MODEL_ID,
		provider: DEFAULT_PROVIDER,
		thinkingLevel: DEFAULT_THINKING,
	});
	// Use the SDK's ThinkingLevel (the wider union incl. "xhigh") for the
	// local binding so we can pass it through to the next agent without
	// re-narrowing on every reassignment.
	let agent: Agent = built.agent;
	let provider: string = built.provider;
	let model = built.model;
	let thinkingLevel: ThinkingLevelSdk = built.thinkingLevel;

	// Forward every Agent event to the WS. `unsubscribe` is a let because
	// `setModel` swaps the agent out from under us mid-session — the old
	// subscription is released and a new one is captured here.
	let unsubscribe = agent.subscribe((event: AgentEvent) => {
		send(ws, { type: "event", event });
	});

	// Tell the client we're ready.
	send(ws, {
		type: "ready",
		modelId: model.id,
		provider,
		thinkingLevel,
	});

	// Drain incoming client messages.
	ws.on("message", (raw) => {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(raw.toString()) as ClientMessage;
		} catch {
			sendError(ws, "malformed JSON");
			return;
		}
		void onClientMessage(ws, msg);
	});

	ws.on("close", () => {
		try {
			agent.abort();
		} catch {
			/* ignore */
		}
		unsubscribe();
	});

	// Local message handler.
	async function onClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
		try {
			switch (msg.type) {
				case "prompt": {
					// Fire-and-forget. The agent emits events as it goes; we
					// forward them via the subscriber above. Errors come
					// through as message_end with stopReason="error" or
					// agent_end with an errorMessage.
					//
					// If the client sent images (e.g. via the file picker),
					// pass them as the second arg so the SDK can build a
					// multimodal request — text + image content blocks — for
					// models whose `input` includes "image". The model
					// receives the actual pixels, not just a URL.
					const images: ImageContent[] | undefined = msg.images?.length
						? msg.images.map((img: PromptImage) => ({
								type: "image",
								data: img.data,
								mimeType: img.mimeType,
							}))
						: undefined;
					if (images) {
						await agent.prompt(msg.text, images);
					} else {
						await agent.prompt(msg.text);
					}
					break;
				}
				case "abort": {
					agent.abort();
					break;
				}
				case "setModel": {
					// Tear down the old agent and start a new one with the
					// requested model. We preserve the current messages so
					// the conversation isn't lost across model switches.
					const messages = agent.state.messages.slice();
					// Release the old subscription BEFORE swapping the agent,
					// so the listener on the dead agent doesn't keep firing
					// on the WS until GC.
					unsubscribe();
					try {
						agent.abort();
					} catch {
						/* ignore */
					}
					const next = createAgent({
						modelId: msg.modelId,
						provider: msg.provider,
						thinkingLevel: agent.state.thinkingLevel,
					});
					// Carry over transcript.
					next.agent.state.messages = messages;
					agent = next.agent;
					provider = next.provider;
					model = next.model;
					thinkingLevel = next.thinkingLevel;
					// Re-subscribe against the new agent and capture the
					// unsubscribe so the NEXT setModel (or ws close) can
					// release it cleanly.
					unsubscribe = agent.subscribe((event: AgentEvent) => {
						send(ws, { type: "event", event });
					});
					send(ws, {
						type: "ready",
						modelId: model.id,
						provider,
						thinkingLevel,
					});
					break;
				}
				case "setThinking": {
					agent.state.thinkingLevel = msg.level;
					thinkingLevel = msg.level;
					break;
				}
				default: {
					// Exhaustiveness check.
					const _exhaustive: never = msg;
					void _exhaustive;
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendError(ws, message);
		}
	}
}

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState !== ws.OPEN) return;
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		/* socket may have closed between the check and the send */
	}
}

function sendError(ws: WebSocket, message: string): void {
	send(ws, { type: "error", message });
}
