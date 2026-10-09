import { afterEach, describe, expect, it, vi } from "vitest";
import { forkPath, readForkFromUrl } from "../src/client/url.js";

function at(pathname: string): void {
	vi.stubGlobal("location", { pathname });
}

describe("fork URLs", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("round-trips the path the fork link builds", () => {
		at(forkPath("abc-123", 7));
		expect(readForkFromUrl()).toEqual({ sessionId: "abc-123", messageCount: 7 });
	});

	it("accepts a trailing slash and a zero count", () => {
		at("/fork/abc/0/");
		expect(readForkFromUrl()).toEqual({ sessionId: "abc", messageCount: 0 });
	});

	it("ignores anything that is not /fork/<id>/<n>", () => {
		for (const path of ["/", "/s/abc", "/fork/abc", "/fork/abc/x", "/fork/abc/-1", "/fork/a/b/3"]) {
			at(path);
			expect(readForkFromUrl(), path).toBeNull();
		}
	});
});
