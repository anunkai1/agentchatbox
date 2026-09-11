import { describe, expect, it, vi } from "vitest";
import { browserEvent, deliver, type PiSocket } from "../src/server/session-registry.js";

const text = Object.freeze({ type: "text", text: "[photo.png](/uploads/photo.png)" });
const image = Object.freeze({ type: "image", data: "private-image-bytes", mimeType: "image/png" });
const content = Object.freeze([text, image]);
const details = Object.freeze({ providerResponse: "private-provider-payload" });
const user = Object.freeze({ role: "user", content, timestamp: 1 });
const result = Object.freeze({ content, details });
const tool = Object.freeze({ role: "toolResult", toolCallId: "call-1", isError: false, ...result });
const safeTool = { role: "toolResult", toolCallId: "call-1", isError: false, content: [text] };

describe("browser RPC event projection", () => {
	it.each([
		"message_start",
		"message_update",
		"message_end",
	])("strips images from %s without mutating the source", (type) => {
		const event = Object.freeze({ type, message: user });
		expect(browserEvent(event)).toEqual({ type, message: { ...user, content: [text] } });
		expect(user.content).toBe(content);
	});

	it("projects every message in agent_end, retaining text, metadata and custom details", () => {
		const custom = Object.freeze({
			role: "custom",
			content: "voice reply",
			details: { short: "Hi" },
		});
		const messages = Object.freeze([user, tool, custom]);
		const event = Object.freeze({ type: "agent_end", messages, willRetry: false });
		expect(browserEvent(event)).toEqual({
			...event,
			messages: [{ ...user, content: [text] }, safeTool, custom],
		});
		expect(event.messages).toBe(messages);
		expect(tool.details).toBe(details);
		expect(tool.content).toBe(content);
	});

	it("projects both turn_end.message and all toolResults", () => {
		const event = Object.freeze({
			type: "turn_end",
			message: user,
			toolResults: Object.freeze([tool]),
		});
		expect(browserEvent(event)).toEqual({
			type: "turn_end",
			message: { ...user, content: [text] },
			toolResults: [safeTool],
		});
	});

	it.each([
		["tool_execution_update", "partialResult"],
		["tool_execution_end", "result"],
	])("projects role-less %s payloads, including details-only results", (type, field) => {
		for (const payload of [result, Object.freeze({ details })]) {
			const event = Object.freeze({ type, toolCallId: "call-1", isError: false, [field]: payload });
			expect(browserEvent(event)).toEqual({
				...event,
				[field]: "content" in payload ? { content: [text] } : {},
			});
			expect(payload.details).toBe(details);
		}
	});

	it("projects legacy cumulative partials without removing deltas or tool-call arguments", () => {
		const args = Object.freeze({ content: [image], details });
		const call = Object.freeze({
			type: "toolCall",
			id: "call-1",
			name: "example",
			arguments: args,
		});
		const message = Object.freeze({
			role: "assistant",
			content: Object.freeze([text, image, call]),
		});
		const update = Object.freeze({ type: "text_delta", delta: "hello", partial: message });
		const event = Object.freeze({ type: "message_update", message, assistantMessageEvent: update });
		const safe = { ...message, content: [text, call] };
		expect(browserEvent(event)).toEqual({
			...event,
			message: safe,
			assistantMessageEvent: { ...update, partial: safe },
		});
		expect(call.arguments).toBe(args);
	});

	it.each([
		{ type: "agent_start" },
		{ type: "agent_end", messages: [null, "unknown", { role: "user", content: "hello" }] },
		{ type: "turn_end", message: null, toolResults: "invalid" },
		{ type: "tool_execution_update", partialResult: null },
		{ type: "tool_execution_end", result: [] },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } },
		{ type: "message_start", message: { role: "custom", content: "voice", details } },
		{ type: "extension_ui_request", result, messages: [user], args: { content, details } },
	])("leaves unrelated or already-safe events unchanged: $type", (event) => {
		expect(browserEvent(event)).toBe(event);
	});

	it("delivers an image-heavy agent_end below the WS limit without omission or disconnection", () => {
		// Three individually valid 9 MiB images exceed the 32 MiB WS budget
		// when base64 encoded. No large files or real sockets are needed.
		const largeImage = { ...image, data: "A".repeat(12 * 1024 * 1024) };
		const original = {
			type: "agent_end",
			messages: [{ ...user, content: [text, largeImage, largeImage, largeImage] }],
		};
		expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(32 * 1024 * 1024);
		const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
		deliver(ws as unknown as PiSocket, { type: "event", event: browserEvent(original) });
		expect(ws.close).not.toHaveBeenCalled();
		expect(ws.send).toHaveBeenCalledOnce();
		expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
			type: "event",
			event: { type: "agent_end", messages: [{ ...user, content: [text] }] },
		});
		expect(original.messages[0].content[1]).toBe(largeImage);
	});
});
