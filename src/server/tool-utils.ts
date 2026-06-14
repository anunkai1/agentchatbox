/**
 * Shared helpers for tool modules (tools.ts, web-tools.ts).
 *
 * Both files wrap the pi Agent's AgentTool contract with the same pattern:
 *   - text() / errContent(): build a TextContent literal
 *   - ok(): wrap a result in the standard { content, details } shape
 *   - ToolError: a typed Error so the SDK's tool loop can render the message
 *
 * Keeping them in one place means both modules' tool definitions stay small
 * and there's no risk of the error-text format drifting between them.
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export function text(s: string): TextContent {
	return { type: "text", text: s };
}

export function errContent(s: string): TextContent {
	return { type: "text", text: `Error: ${s}` };
}

export function ok<T>(content: TextContent[], details: T): AgentToolResult<T> {
	return { content, details };
}

/**
 * Tool failure path: throw the error. The agent-loop catches it, emits a
 * tool result with `isError: true`, and the model sees the message. The
 * client's `toolResult.isError` flag drives red styling.
 */
export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}
