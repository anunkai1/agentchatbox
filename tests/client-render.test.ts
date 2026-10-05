import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesVoiceHint, refreshCapabilitiesBadge, voiceHintFor } from "../src/client/render.js";
import { state } from "../src/client/state.js";

// Markdown rendering needs a browser; these tests only touch the pieces that do not.
vi.mock("../src/client/linkify.js", () => ({ setRichText: vi.fn(), setUserRichText: vi.fn() }));

afterEach(() => {
	vi.unstubAllGlobals();
	state.capabilities = [];
	state.extensionStatusLabels = {};
});

describe("voice variant hint", () => {
	it("names the reply by its opening words, so the right row is voiced", () => {
		const first = "The invoice is due on Friday.\n\nIt is for $120.";
		const second = "Your parcel arrives tomorrow.";
		const hint = voiceHintFor(first);
		expect(matchesVoiceHint(first, hint)).toBe(true);
		expect(matchesVoiceHint(second, hint)).toBe(false);
	});

	it("ignores case and line breaks when matching", () => {
		expect(matchesVoiceHint("Hello\n  there   friend", "hello there")).toBe(true);
	});
});

describe("Claude Code header toggle", () => {
	const button = () => {
		const attributes: Record<string, string> = {};
		const on = new Set<string>();
		return {
			style: { display: "none" },
			title: "",
			attributes,
			classList: {
				toggle: (name: string, force: boolean) => (force ? on.add(name) : on.delete(name)),
				contains: (name: string) => on.has(name),
			},
			setAttribute: (name: string, value: string) => {
				attributes[name] = value;
			},
		};
	};
	const mount = (cc: ReturnType<typeof button>) =>
		vi.stubGlobal("document", {
			getElementById: (id: string) => (id === "cc-toggle" ? cc : null),
		});

	it("is hidden when the claude command is not installed", () => {
		const cc = button();
		mount(cc);
		state.capabilities = [];
		refreshCapabilitiesBadge();
		expect(cc.style.display).toBe("none");
	});

	it("shows off until the extension reports the chat is on Claude Code", () => {
		const cc = button();
		mount(cc);
		state.capabilities = [{ name: "claude", source: "extension" }];
		refreshCapabilitiesBadge();
		expect(cc.style.display).toBe("");
		expect(cc.classList.contains("on")).toBe(false);
		expect(cc.attributes["aria-pressed"]).toBe("false");
		expect(cc.title).toContain("/cc on");
	});

	it("shows on, and offers /cc off, once the chat's status says so", () => {
		const cc = button();
		mount(cc);
		state.capabilities = [{ name: "claude", source: "extension" }];
		state.extensionStatusLabels = { "claude-sticky": "Opus" };
		refreshCapabilitiesBadge();
		expect(cc.classList.contains("on")).toBe(true);
		expect(cc.attributes["aria-pressed"]).toBe("true");
		expect(cc.title).toContain("/cc off");
	});
});
