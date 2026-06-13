/**
 * LLM streaming proxy.
 *
 * The official pi-web-ui runs the agent client-side. The agent uses
 * `streamSimple` from `@earendil-works/pi-ai` to call LLM providers.
 *
 * We don't want the browser to know the API key, so we expose this
 * endpoint that:
 *   1. Receives the model + context + options from the browser.
 *   2. Injects the server-side API key for the requested provider.
 *   3. Calls `streamSimple` and forwards each event as an SSE frame.
 *
 * The client reconstructs an `AssistantMessageEventStream` from these frames
 * and feeds it to its local `Agent` instance, so the rest of the web UI
 * works unchanged.
 */

import type { Request, Response } from "express";
import { streamSimple } from "@earendil-works/pi-ai";
import type { StreamRequest } from "../shared/protocol.js";
import { getServerApiKey } from "./config.js";

export function handleStream(req: Request, res: Response): void {
	const body = req.body as StreamRequest;
	if (!body || !body.model || !body.context) {
		res.status(400).json({ error: "missing model or context" });
		return;
	}

	const provider = body.model.provider;
	const serverKey = getServerApiKey(provider);
	// Trust the server key if we have one. The browser may also send a key
	// in options, but the server key wins.
	const apiKey = serverKey ?? body.options?.apiKey;

	if (!apiKey) {
		res.status(401).json({
			error: `no API key configured on the server for provider "${provider}"`,
		});
		return;
	}

	// Set up SSE headers
	res.status(200);
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders?.();

	// Forward aborts from the client to the LLM provider.
	const abortController = new AbortController();
	req.on("close", () => abortController.abort());

	let stream: ReturnType<typeof streamSimple> | undefined;
	try {
		stream = streamSimple(body.model, body.context, {
			...body.options,
			apiKey,
			signal: abortController.signal,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
		res.end();
		return;
	}

	(async () => {
		try {
			for await (const event of stream) {
				res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
			}
			res.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			try {
				res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
			} catch {
				// socket may already be closed
			}
			res.end();
		}
	})();
}
