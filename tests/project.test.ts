/**
 * Tests for the transcript → PersistedMessage projection.
 *
 * The headline case: a session interrupted mid-turn (assistant message
 * ending in `toolUse` with no `toolResult` ever written) must render
 * those tool calls as `interrupted`, NOT as the indefinite "running…"
 * spinner. Before the fix, the 1:1 projection dropped the assistant's
 * toolCall blocks entirely and emitted a row per toolResult — so
 * dangling calls silently vanished, and if pi re-emitted them live on
 * resume they spun forever.
 */
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { projectTranscript } from "../src/client/project.js";

/** Helper: build a user message. */
function user(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

/** Helper: build an assistant message with arbitrary content blocks. */
function assistant(blocks: unknown[]): Message {
	return {
		role: "assistant",
		content: blocks,
	} as unknown as Message;
}

/** Helper: build a toolResult message. */
function toolResult(toolCallId: string, toolName: string, text: string, isError = false): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
	} as unknown as Message;
}

describe("projectTranscript", () => {
	it("projects user and assistant text/thinking", () => {
		const out = projectTranscript([
			user("hello"),
			assistant([
				{ type: "thinking", thinking: "pondering" },
				{ type: "text", text: "hi there" },
			]),
		]);
		expect(out).toEqual([
			{ kind: "user", text: "hello" },
			{ kind: "assistant", text: "hi there", thinking: "pondering" },
		]);
	});

	it("correlates a toolCall with its toolResult by id and keeps real args", () => {
		const out = projectTranscript([
			user("list files"),
			assistant([
				{ type: "text", text: "running ls" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
			]),
			toolResult("call_1", "bash", "file_a\nfile_b"),
		]);
		expect(out).toEqual([
			{ kind: "user", text: "list files" },
			{ kind: "assistant", text: "running ls", thinking: "" },
			{
				kind: "tool",
				name: "bash",
				args: { command: "ls" },
				result: "file_a\nfile_b",
				isError: false,
			},
		]);
	});

	it("does NOT duplicate tool rows — one row per toolCall, not per toolResult", () => {
		const out = projectTranscript([
			assistant([{ type: "toolCall", id: "x", name: "bash", arguments: {} }]),
			toolResult("x", "bash", "done"),
		]);
		const toolRows = out.filter((m) => m.kind === "tool");
		expect(toolRows).toHaveLength(1);
	});

	it("marks dangling tool calls (no result) as interrupted, not running", () => {
		// This is the interrupted-session bug: the assistant turn ended in
		// toolUse but the session died before any toolResult was written.
		const out = projectTranscript([
			user("search the web"),
			assistant([
				{ type: "text", text: "let me search" },
				{ type: "toolCall", id: "dangling", name: "web_search", arguments: { query: "x" } },
			]),
			// NOTE: no toolResult for "dangling"
		]);
		expect(out).toEqual([
			{ kind: "user", text: "search the web" },
			{ kind: "assistant", text: "let me search", thinking: "" },
			{
				kind: "tool",
				name: "web_search",
				args: { query: "x" },
				interrupted: true,
			},
		]);
		// Critical: the dangling row must NOT carry a result and must NOT
		// be left as a bare {kind:"tool"} (which the renderer would paint
		// as the indefinite "running…" spinner).
		const tool = out[2];
		if (tool.kind !== "tool") throw new Error("expected tool row");
		expect(tool.result).toBeUndefined();
		expect(tool.interrupted).toBe(true);
	});

	it("handles multiple toolCalls where some completed and some dangled", () => {
		const out = projectTranscript([
			assistant([
				{ type: "toolCall", id: "ok", name: "bash", arguments: { command: "pwd" } },
				{ type: "toolCall", id: "hung", name: "web_search", arguments: { query: "q" } },
			]),
			toolResult("ok", "bash", "/home"),
		]);
		const tools = out.filter((m) => m.kind === "tool");
		expect(tools).toHaveLength(2);
		const [a, b] = tools as Extract<
			{ kind: "tool"; interrupted?: boolean; result?: string },
			{ kind: "tool" }
		>[];
		expect(a.result).toBe("/home");
		expect(a.interrupted).toBeUndefined();
		expect(b.result).toBeUndefined();
		expect(b.interrupted).toBe(true);
	});

	it("preserves isError from the toolResult", () => {
		const out = projectTranscript([
			assistant([{ type: "toolCall", id: "e", name: "bash", arguments: {} }]),
			toolResult("e", "bash", "boom", true),
		]);
		const tool = out[1];
		if (tool.kind !== "tool") throw new Error("expected tool");
		expect(tool.isError).toBe(true);
	});

	it("returns an empty array for an empty transcript", () => {
		expect(projectTranscript([])).toEqual([]);
	});
});
