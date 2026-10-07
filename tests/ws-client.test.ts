/**
 * Client transport (src/client/ws.ts) with a fake WebSocket. The headline
 * case: pressing Reconnect while an automatic reconnect is already pending
 * must leave exactly one live socket and a usable connection, not a tab that
 * receives replies but refuses to send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
	static OPEN = 1;
	static instances: FakeSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	private listeners = new Map<string, Array<(ev: unknown) => void>>();
	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}
	addEventListener(type: string, fn: (ev: unknown) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	send(data: string) {
		this.sent.push(data);
	}
	/** Like a real socket, close() is asynchronous: the event fires later. */
	close() {
		this.readyState = 2;
	}
	emit(type: string, ev: unknown = {}) {
		for (const fn of this.listeners.get(type) ?? []) fn(ev);
	}
	open() {
		this.readyState = FakeSocket.OPEN;
		this.emit("open");
	}
	finishClose(code = 1006) {
		this.readyState = 3;
		this.emit("close", { code });
	}
}

async function makeClient() {
	vi.resetModules();
	const { createChatClient } = await import("../src/client/ws.js");
	return createChatClient();
}

beforeEach(() => {
	vi.useFakeTimers();
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("location", { protocol: "http:", host: "acb.test" });
	vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("chat client reconnect", () => {
	it("Reconnect while an automatic reconnect is pending leaves one working socket", async () => {
		const client = await makeClient();
		const statuses: string[] = [];
		client.onStatus((s) => statuses.push(s));
		const first = FakeSocket.instances[0];
		first.open();

		// Connection drops: an automatic reconnect is now scheduled.
		first.finishClose();
		expect(FakeSocket.instances).toHaveLength(1);

		// The user presses Reconnect before the backoff timer fires.
		client.reconnect();
		expect(FakeSocket.instances).toHaveLength(2);
		const second = FakeSocket.instances[1];
		second.open();

		// The old timer and any late events from the old socket change nothing.
		first.finishClose();
		vi.advanceTimersByTime(15_000);
		expect(FakeSocket.instances).toHaveLength(2);
		expect(statuses.at(-1)).toBe("open");

		client.init({ provider: "p", modelId: "m", thinkingLevel: "off" });
		expect(second.sent).toHaveLength(1);
		client.close();
	});

	it("Reconnect on a live socket ignores the old socket's close event", async () => {
		const client = await makeClient();
		const first = FakeSocket.instances[0];
		first.open();
		client.reconnect();
		const second = FakeSocket.instances[1];
		second.open();
		first.finishClose();
		vi.advanceTimersByTime(15_000);
		expect(FakeSocket.instances).toHaveLength(2);
		client.init({ provider: "p", modelId: "m", thinkingLevel: "off" });
		expect(second.sent).toHaveLength(1);
		client.close();
	});

	it("reconnects automatically after an unexpected close", async () => {
		const client = await makeClient();
		FakeSocket.instances[0].open();
		FakeSocket.instances[0].finishClose();
		vi.advanceTimersByTime(15_000);
		expect(FakeSocket.instances).toHaveLength(2);
		client.close();
	});

	it("does not reconnect after the session was taken over (4001)", async () => {
		const client = await makeClient();
		FakeSocket.instances[0].open();
		FakeSocket.instances[0].finishClose(4001);
		vi.advanceTimersByTime(15_000);
		expect(FakeSocket.instances).toHaveLength(1);
		client.close();
	});
});
