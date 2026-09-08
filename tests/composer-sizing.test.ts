import { afterEach, describe, expect, it, vi } from "vitest";
import { autoSize, refreshStatus } from "../src/client/render.js";
import { state } from "../src/client/state.js";

// Layout checks do not render Markdown; its browser-only DOMPurify setup
// is exercised in Chrome rather than emulated by these narrow unit tests.
vi.mock("../src/client/linkify.js", () => ({ setRichText: vi.fn(), setUserRichText: vi.fn() }));

const streamingBefore = state.isStreaming;
afterEach(() => {
	state.isStreaming = streamingBefore;
	vi.unstubAllGlobals();
});

describe("composer layout", () => {
	it("does not collapse or measure the focused textarea with native sizing", () => {
		const style = { height: "" };
		const textarea = {
			style,
			get scrollHeight(): number {
				throw new Error("native sizing must not force a collapsed layout measurement");
			},
		};
		vi.stubGlobal("document", { querySelector: () => textarea });
		vi.stubGlobal("CSS", { supports: () => true });
		autoSize();
		expect(style.height).toBe("");
	});

	it("retains bounded manual sizing in browsers without field-sizing", () => {
		const textarea = { style: { height: "" }, scrollHeight: 300 };
		vi.stubGlobal("document", { querySelector: () => textarea });
		vi.stubGlobal("CSS", { supports: () => false });
		autoSize();
		expect(textarea.style.height).toBe("200px");
		textarea.scrollHeight = 41;
		autoSize();
		expect(textarea.style.height).toBe("41px");
	});

	it("keeps streaming status out of composer flow without consulting scroll position", () => {
		const added: string[] = [];
		const line = {
			className: "",
			replaceChildren: vi.fn(),
			classList: { add: (name: string) => added.push(name) },
		};
		const slot = { innerHTML: "", textContent: "", title: "" };
		vi.stubGlobal("document", {
			getElementById: (id: string) => (id === "composer-state" ? line : null),
			querySelector: (selector: string) => {
				if (selector === ".messages-wrap" || selector === "#messages") {
					throw new Error("status must not measure the scrolling viewport");
				}
				return slot;
			},
		});
		state.isStreaming = true;
		refreshStatus();
		expect(added).toContain("hidden");
	});
});
