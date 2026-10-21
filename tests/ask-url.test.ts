import { afterEach, describe, expect, it, vi } from "vitest";
import { readAskFromUrl } from "../src/client/url.js";

function at(pathname: string, search = ""): void {
	vi.stubGlobal("location", { pathname, search });
}

describe("ask URLs", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reads the decoded question from /?ask=", () => {
		at("/", `?ask=${encodeURIComponent("Tell me more:\n\n### A & B")}`);
		expect(readAskFromUrl()).toBe("Tell me more:\n\n### A & B");
	});

	it("ignores blank questions and other paths", () => {
		at("/", "?ask=%20%20");
		expect(readAskFromUrl()).toBeNull();
		at("/s/abc", "?ask=hi");
		expect(readAskFromUrl()).toBeNull();
		at("/");
		expect(readAskFromUrl()).toBeNull();
	});
});
