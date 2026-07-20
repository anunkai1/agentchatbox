/**
 * chat.ts::resolveInitDefaults — the rule that brand-new sessions (a
 * freshly opened tab, no sessionId) start in the Global project's
 * configured default model, while reconnects (sessionId present) keep
 * the client's live model. This is the core of "make a model the
 * default so all new tabs load it first".
 *
 * Pure function — no `pi` child, no WebSocket, no projects file. We
 * hand it synthetic ProjectRecord shapes and assert what it resolves.
 */

import { describe, expect, it } from "vitest";
import type { InitMessage } from "../src/server/session-registry.js";
import type { ProjectRecord } from "../src/server/projects.js";
import { resolveInitDefaults } from "../src/server/chat.js";

const globalWithDefault = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
	id: "global",
	name: "Global",
	icon: "🌐",
	cwd: "/tmp",
	builtin: true,
	defaultModelId: "kimi-k2",
	defaultProvider: "moonshot",
	defaultThinkingLevel: "medium",
	...overrides,
});

describe("resolveInitDefaults", () => {
	it("applies the Global default for a brand-new session (no sessionId)", () => {
		// A freshly opened tab: the client sends its fallback model
		// (glm-5.2) because it can't know the configured default before
		// the projects list loads. The server overrides it.
		const init: InitMessage = {
			provider: "zai",
			modelId: "glm-5.2",
			thinkingLevel: "high",
		};
		const out = resolveInitDefaults(init, globalWithDefault());
		expect(out.modelId).toBe("kimi-k2");
		expect(out.provider).toBe("moonshot");
		expect(out.thinkingLevel).toBe("medium");
	});

	it("keeps the client model on reconnect (sessionId present)", () => {
		// Resuming a live session: the client knows the real model, so
		// the Global default must NOT clobber it (otherwise resuming a
		// chat that was using a different model would silently switch it).
		const init: InitMessage = {
			provider: "zai",
			modelId: "glm-5.2",
			thinkingLevel: "high",
			sessionId: "abc-123",
		};
		const out = resolveInitDefaults(init, globalWithDefault());
		expect(out.modelId).toBe("glm-5.2");
		expect(out.provider).toBe("zai");
		expect(out.thinkingLevel).toBe("high");
	});

	it("leaves init untouched when Global has no default configured", () => {
		// Backward compatibility: no default set → new chats fall back to
		// whatever the client sent (today, the first available model).
		const init: InitMessage = {
			provider: "zai",
			modelId: "glm-5.2",
			thinkingLevel: "high",
		};
		const out = resolveInitDefaults(
			init,
			globalWithDefault({
				defaultModelId: null,
				defaultProvider: null,
				defaultThinkingLevel: null,
			}),
		);
		expect(out).toBe(init);
	});

	it("fills only the fields the Global default provides", () => {
		// A default model+provider but no thinking level: thinking stays
		// the client's value (partial defaults don't wipe the rest).
		const init: InitMessage = {
			provider: "zai",
			modelId: "glm-5.2",
			thinkingLevel: "high",
		};
		const out = resolveInitDefaults(
			init,
			globalWithDefault({ defaultThinkingLevel: null }),
		);
		expect(out.modelId).toBe("kimi-k2");
		expect(out.provider).toBe("moonshot");
		expect(out.thinkingLevel).toBe("high");
	});

	it("returns init unchanged when there is no Global project record", () => {
		const init: InitMessage = {
			provider: "zai",
			modelId: "glm-5.2",
			thinkingLevel: "high",
		};
		expect(resolveInitDefaults(init, undefined)).toBe(init);
	});

	it("preserves a client-supplied cwd alongside the resolved model", () => {
		const init: InitMessage = {
			provider: "zai",
			modelId: "glm-5.2",
			thinkingLevel: "high",
			cwd: "/some/project",
		};
		const out = resolveInitDefaults(init, globalWithDefault());
		expect(out.cwd).toBe("/some/project");
		expect(out.modelId).toBe("kimi-k2");
	});
});
