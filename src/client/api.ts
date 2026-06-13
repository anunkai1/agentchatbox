/**
 * Client-side API for talking to the agentchatbox server.
 *
 * The Agent in the browser calls `proxiedStreamFn` for every LLM request.
 * We replace the default direct-to-provider call with a POST to our server,
 * which forwards the call to the LLM provider using the API key configured
 * server-side. The browser never sees the key.
 */

import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { StreamRequest } from "../shared/protocol.js";

/** Empty AssistantMessage used to report proxy errors. */
function emptyAssistantMessage(model: Model<Api>, errorMessage: string) {
	return {
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error" as const,
		errorMessage,
		timestamp: Date.now(),
	};
}

/**
 * Custom stream function for the Agent.
 *
 * Synchronous: creates an event stream, fires off the fetch in the background,
 * and returns the stream immediately. Events are pushed into it as the SSE
 * response is read.
 */
export const proxiedStreamFn: StreamFn = (
	model: Model<Api>,
	context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const out = createAssistantMessageEventStream();
	const body: StreamRequest = { model, context, options };

	void (async () => {
		try {
			const response = await fetch("/api/stream", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!response.ok || !response.body) {
				const text = await response.text().catch(() => "");
				out.push({
					type: "error",
					reason: "error",
					error: emptyAssistantMessage(model, `proxy: ${response.status} ${text}`),
				});
				out.end();
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				let frameEnd: number;
				while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
					const raw = buffer.slice(0, frameEnd);
					buffer = buffer.slice(frameEnd + 2);

					const lines = raw.split("\n");
					let eventName = "message";
					let data = "";
					for (const line of lines) {
						if (line.startsWith("event: ")) eventName = line.slice(7).trim();
						else if (line.startsWith("data: ")) data += line.slice(6);
					}
					if (eventName === "error") {
						try {
							const parsed = JSON.parse(data) as { error: string };
							out.push({
								type: "error",
								reason: "error",
								error: emptyAssistantMessage(model, parsed.error),
							});
						} catch {
							/* ignore */
						}
					} else if (eventName === "message" && data) {
						try {
							out.push(JSON.parse(data));
						} catch {
							/* ignore */
						}
					}
				}
			}
			out.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			out.push({
				type: "error",
				reason: "error",
				error: emptyAssistantMessage(model, message),
			});
			out.end();
		}
	})();

	return out;
};

/** Upload a file to the server. Returns the URL to use in attachments. */
export async function uploadFile(
	file: File,
): Promise<{ url: string; filename: string; mimeType: string; size: number }> {
	const form = new FormData();
	form.append("file", file);
	const res = await fetch("/api/upload", { method: "POST", body: form });
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`upload failed: ${res.status} ${text}`);
	}
	return res.json() as Promise<{ url: string; filename: string; mimeType: string; size: number }>;
}

/** Transcribe an audio blob to text via the server's Whisper endpoint. */
export async function transcribeAudio(audio: Blob, filename = "voice.webm"): Promise<string> {
	const form = new FormData();
	form.append("audio", audio, filename);
	const res = await fetch("/api/transcribe", { method: "POST", body: form });
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`transcribe failed: ${res.status} ${text}`);
	}
	const data = (await res.json()) as { text: string };
	return data.text;
}
