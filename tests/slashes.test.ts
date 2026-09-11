import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	input: { value: "" },
	state: { capabilities: [] as Array<{ name: string; source: string; description?: string }> },
	send: vi.fn(),
	append: vi.fn(),
	refresh: vi.fn(),
}));
vi.mock("../src/client/api.js", () => ({}));
vi.mock("../src/client/dom.js", () => ({ $: () => mocks.input }));
vi.mock("../src/client/prefs.js", () => ({}));
vi.mock("../src/client/render.js", () => ({
	appendNode: mocks.append,
	refreshStatus: mocks.refresh,
}));
vi.mock("../src/client/services.js", () => ({ services: { sendSlashCommand: mocks.send } }));
vi.mock("../src/client/state.js", () => ({ state: mocks.state }));
vi.mock("../src/client/url.js", () => ({}));

import { handleSlash, isKnownSlash, SLASH_COMMANDS } from "../src/client/slashes.js";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.state.capabilities = [];
	mocks.input.value = "pending command";
});

describe("Pi-owned slash commands", () => {
	it.each([
		"fast",
		"imggen",
		"imagemodel",
		"image",
	])("discovers and forwards /%s without changing arguments", (name) => {
		expect(SLASH_COMMANDS).not.toHaveProperty(name);
		expect(isKnownSlash(`/${name}`)).toBe(false);
		mocks.state.capabilities = [{ name, source: "extension" }];
		expect(isKnownSlash(`/${name}`)).toBe(true);
		const command = `${name}  example "two words" --flag`;
		handleSlash(command);
		expect(mocks.send).toHaveBeenCalledWith(`/${command}`);
		expect(mocks.input.value).toBe("");
	});

	it("retains the intentional research alias", () => {
		handleSlash("websearch find something");
		expect(mocks.send).toHaveBeenCalledWith("/research find something");
	});

	it("does not forward unavailable commands or skills", () => {
		mocks.state.capabilities = [{ name: "image", source: "skill" }];
		expect(isKnownSlash("/image")).toBe(false);
		handleSlash("image");
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("includes discovered commands in help without duplicating built-ins", () => {
		vi.stubGlobal("document", { createElement: () => ({ className: "", textContent: "" }) });
		try {
			mocks.state.capabilities = [
				{ name: "imagemodel", source: "extension", description: "Pi image picker" },
				{ name: "model", source: "extension", description: "Duplicate model" },
			];
			handleSlash("help");
			const text = mocks.append.mock.calls[0][0].textContent;
			expect(text).toContain("/imagemodel Pi image picker");
			expect(text).not.toContain("Duplicate model");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
