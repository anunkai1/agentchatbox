import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_MESSAGE } from "../src/shared/relay.js";

const drawerState = {
	lastStatus: "",
	statuses: [] as string[],
	onDismiss: null as (() => void) | null,
};

function makeEl(tag: string) {
	return {
		tagName: tag.toUpperCase(),
		textContent: "",
		title: "",
		value: "",
		href: "",
		hidden: false,
		disabled: false,
		dataset: {} as Record<string, string>,
		attrs: new Map<string, string>(),
		childNodes: [] as unknown[],
		scrollHeight: 0,
		clientHeight: 0,
		scrollTop: 0,
		setAttribute(name: string, val: string) {
			this.attrs.set(name, val);
		},
		hasAttribute(name: string) {
			return this.attrs.has(name);
		},
		append(...nodes: unknown[]) {
			this.childNodes.push(...nodes);
		},
		replaceChildren(...nodes: unknown[]) {
			this.childNodes = [...nodes];
		},
		querySelector: () => null,
		click() {},
	};
}

vi.mock("../src/client/dom.js", () => ({
	el: (tag: string) => makeEl(tag),
	mountModal: () => ({ dismiss: vi.fn() }),
	uuid: () => "test-uuid",
}));
vi.mock("../src/client/linkify.js", () => ({
	setRichText: vi.fn(),
	setUserRichText: vi.fn(),
}));
vi.mock("../src/client/relay-drawer.js", () => ({
	mountRelayDrawer: (_box: unknown, onDismiss: () => void) => {
		drawerState.onDismiss = onDismiss;
		return {
			setStatus: (text: string) => {
				drawerState.lastStatus = text;
				drawerState.statuses.push(text);
			},
			setPause: vi.fn(),
			reveal: vi.fn(),
			dismiss: () => onDismiss(),
		};
	},
}));
vi.mock("../src/client/kokoro-tts.js", () => ({
	createZonosSpeaker: () => ({
		connect: vi.fn(),
		disconnect: vi.fn(),
		stop: vi.fn(),
		close: vi.fn(),
		pause: vi.fn(async () => {}),
		resume: vi.fn(async () => {}),
		beginUtterance: vi.fn(),
		enqueueSegment: vi.fn(),
		finishUtterance: vi.fn(),
		hasAudio: false,
	}),
	formatKokoroPlayedHistory: vi.fn(() => ""),
}));
vi.mock("../src/client/relay-wake-lock.js", () => ({
	createRelayWakeLock: () => vi.fn(),
}));
vi.mock("../src/client/voice.js", () => ({
	cancelVoiceRecord: vi.fn(),
	captureConversation: vi.fn(),
	stopAllVoice: vi.fn(),
}));

import { services } from "../src/client/services.js";
import { state } from "../src/client/state.js";
import { endRelayVoice, openRelay } from "../src/client/voice-test.js";

describe("Relay startup error handling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		drawerState.lastStatus = "";
		drawerState.statuses = [];
		drawerState.onDismiss = null;
		state.currentProvider = "openai";
		state.currentModelId = "work-model";
		state.currentThinking = "high";
		state.sessionId = null;
		state.messages = [];
		vi.stubGlobal("document", {
			visibilityState: "visible",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		});
		vi.stubGlobal("window", {
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		});
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(() => null),
			setItem: vi.fn(),
			removeItem: vi.fn(),
		});
	});

	afterEach(() => {
		endRelayVoice();
		services.openRelayChat = undefined;
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("settles immediately on pre-ready error without firing the 20 s startup timer or closing the socket", () => {
		let onMessage!: (wire: Record<string, unknown>) => void;
		const sent: unknown[] = [];
		const close = vi.fn();
		services.openRelayChat = (opts) => {
			onMessage = opts.onMessage;
			return {
				send: (msg) => {
					sent.push(msg);
					return true;
				},
				close,
				isOpen: () => true,
			};
		};

		openRelay(true);
		onMessage({ type: "ready", sessionId: "relay-s1" });
		onMessage({ type: "capabilities", commands: [{ name: "relay" }] });

		const startPrompts = () =>
			sent.filter(
				(msg) =>
					typeof msg === "object" &&
					msg !== null &&
					"type" in msg &&
					msg.type === "prompt" &&
					"text" in msg &&
					typeof msg.text === "string" &&
					msg.text.startsWith("/relay start"),
			);
		expect(startPrompts()).toHaveLength(1);

		const busyMessage = "Wait for the current reply to finish or stop it before starting Relay";
		onMessage({
			type: "event",
			event: {
				type: "message_end",
				message: {
					role: "custom",
					customType: RELAY_MESSAGE,
					details: { kind: "error", text: busyMessage },
				},
			},
		});

		expect(drawerState.lastStatus).toBe(`Error: ${busyMessage}`);
		expect(close).not.toHaveBeenCalled();

		// Past the 20 s startupTimer window: must NOT overwrite the error or close the socket.
		vi.advanceTimersByTime(25_000);
		expect(drawerState.lastStatus).toBe(`Error: ${busyMessage}`);
		expect(close).not.toHaveBeenCalled();

		// startSent was reset to false, so a subsequent capabilities round-trip can retry /relay start.
		onMessage({ type: "capabilities", commands: [{ name: "relay" }] });
		expect(startPrompts()).toHaveLength(2);
	});
});
