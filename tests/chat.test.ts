/**
 * chat.ts — WebSocket session plumbing.
 *
 * Locks down the regression for fix/cwd-and-subscription-leak: when a
 * client sends `{ type: "setModel", ... }`, the OLD agent's subscription
 * is released. Before the fix, the new subscription was created but the
 * unsubscribe fn was discarded, so every model switch leaked a listener
 * on the dead agent.
 *
 * We mock `./agent.js` to return a fake Agent whose `subscribe()` we
 * control. The fake records how many times the unsubscribe it returned
 * was called — that's the signal we assert.
 *
 * The chat.ts import is dynamic (inside the test body) so the
 * vi.mock factory is in effect when chat.ts loads its `createAgent`
 * import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

type Listener = (e: unknown) => void;

const mocks = vi.hoisted(() => {
	const make = () => {
		const listeners = new Set<Listener>();
		let unsubscribed = 0;
		const agent = {
			state: { messages: [] as unknown[], thinkingLevel: "off" },
			abort: vi.fn(),
			prompt: vi.fn(async () => {}),
			subscribe: vi.fn((l: Listener) => {
				listeners.add(l);
				return () => {
					unsubscribed++;
					listeners.delete(l);
				};
			}),
		};
		return {
			agent,
			unsubscribed: () => unsubscribed,
			listenerCount: () => listeners.size,
		};
	};
	return { current: null as ReturnType<typeof make> | null, make };
});

vi.mock("../src/server/agent.js", () => ({
	DEFAULT_MODEL_ID: "m1",
	DEFAULT_PROVIDER: "p1",
	DEFAULT_THINKING: "off",
	createAgent: () => {
		if (!mocks.current) throw new Error("test forgot to set mocks.current");
		return {
			agent: mocks.current.agent,
			model: { id: "m1" },
			provider: "p1",
			apiKeySource: "server" as const,
			thinkingLevel: "off" as const,
		};
	},
}));

type AnyMsg = { type: string; [k: string]: unknown };

/** Drains the WS into an array. The listener is registered
 *  immediately so we don't miss the `ready` frame that fires on
 *  connect. The caller polls the array to wait for the expected
 *  number of messages. */
function collectMessages(ws: WebSocket): { all: () => AnyMsg[]; waitFor: (n: number) => Promise<AnyMsg[]> } {
	const out: AnyMsg[] = [];
	ws.on("message", (raw) => {
		const text = (raw as { toString(): string }).toString();
		try {
			out.push(JSON.parse(text) as AnyMsg);
		} catch {
			// ignore malformed
		}
	});
	return {
		all: () => out.slice(),
		waitFor: async (n: number) => {
			const deadline = Date.now() + 2000;
			while (out.length < n && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 10));
			}
			return out.slice();
		},
	};
}

describe("mountChatWs — setModel regression", () => {
	let server: HttpServer;
	let port: number;
	let first: ReturnType<typeof mocks.make>;
	let second: ReturnType<typeof mocks.make>;

	beforeEach(async () => {
		first = mocks.make();
		second = mocks.make();
		mocks.current = first;

		server = createServer();
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		mocks.current = null;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("releases the old agent's subscription when the client switches models", async () => {
		const { mountChatWs } = await import("../src/server/chat.js");
		mountChatWs(server);

		// Register the inbox listener BEFORE connecting so the `ready`
		// frame that fires immediately on open doesn't get missed.
		// (EventEmitter doesn't deliver events to listeners added
		// after the event was emitted.)
		const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat`);
		const inbox = collectMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});

		// Wait for the first `ready` (emitted on connect).
		const afterConnect = await inbox.waitFor(1);
		expect(afterConnect[0]?.type).toBe("ready");
		expect(afterConnect[0]?.modelId).toBe("m1");
		expect(first.agent.subscribe).toHaveBeenCalledTimes(1);
		expect(first.unsubscribed()).toBe(0);

		// Swap in the second fake and ask the server to switch.
		mocks.current = second;
		ws.send(JSON.stringify({ type: "setModel", modelId: "m2", provider: "p2" }));

		// Wait for the second `ready` (emitted after the swap).
		const afterSwap = await inbox.waitFor(2);
		expect(afterSwap[1]?.type).toBe("ready");

		// Regression for fix/cwd-and-subscription-leak: the old agent's
		// subscription must have been released. Before the fix, this
		// was 0 and the listener was leaked.
		expect(first.unsubscribed()).toBe(1);
		expect(second.agent.subscribe).toHaveBeenCalledTimes(1);
		expect(second.listenerCount()).toBe(1);
		expect(first.listenerCount()).toBe(0);

		ws.close();
	});
});
