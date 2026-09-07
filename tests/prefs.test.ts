import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySessionPrefs, saveSessionPrefs } from "../src/client/prefs.js";
import { state } from "../src/client/state.js";

class MemoryStorage implements Storage {
	private values = new Map<string, string>();

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return Array.from(this.values.keys())[index] ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

const originalLocalStorage = globalThis.localStorage;
let storage: MemoryStorage;

beforeEach(() => {
	storage = new MemoryStorage();
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
	state.sessionId = "prefs-test-session";
	state.showThinking = true;
	state.showToolCalls = true;
});

afterEach(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: originalLocalStorage,
	});
});

describe("chat display preferences", () => {
	it("defaults both internal detail toggles to hidden when no session prefs exist", () => {
		applySessionPrefs();

		expect(state.showThinking).toBe(false);
		expect(state.showToolCalls).toBe(false);
	});

	it("persists thinking and tool-call visibility independently", () => {
		state.showThinking = true;
		state.showToolCalls = false;
		saveSessionPrefs();

		state.showThinking = false;
		state.showToolCalls = true;
		state.sessionId = "another-session";
		applySessionPrefs();

		expect(state.showThinking).toBe(true);
		expect(state.showToolCalls).toBe(false);
	});

	it("saves display choices before a session id exists", () => {
		state.sessionId = null;
		state.showThinking = true;
		state.showToolCalls = true;
		saveSessionPrefs();

		state.sessionId = "new-session";
		state.showThinking = false;
		state.showToolCalls = false;
		applySessionPrefs();

		expect(state.showThinking).toBe(true);
		expect(state.showToolCalls).toBe(true);
	});

	it("migrates legacy per-session display choices", () => {
		storage.setItem(
			"acb:prefs:legacy-session",
			JSON.stringify({ showThinking: true, showToolCalls: false }),
		);
		state.sessionId = "legacy-session";
		applySessionPrefs();

		expect(state.showThinking).toBe(true);
		expect(state.showToolCalls).toBe(false);

		state.sessionId = "another-session";
		applySessionPrefs();
		expect(state.showThinking).toBe(true);
		expect(state.showToolCalls).toBe(false);
	});
});
