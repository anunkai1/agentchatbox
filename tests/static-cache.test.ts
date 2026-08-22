import { describe, expect, it } from "vitest";
import { staticCacheControl } from "../src/server/static-cache.js";

describe("staticCacheControl", () => {
	it("never caches the SPA document", () => {
		expect(staticCacheControl("/srv/public/index.html", "/")).toContain("no-store");
	});

	it("caches content-addressed assets immutably", () => {
		expect(staticCacheControl("/srv/public/app.js", "/app.js?v=0123456789ab")).toBe(
			"public, max-age=31536000, immutable",
		);
	});

	it("gives stable-name assets a bounded repeat-load cache", () => {
		expect(staticCacheControl("/srv/public/favicon-32.png", "/favicon-32.png")).toBe(
			"public, max-age=86400",
		);
		expect(staticCacheControl("/srv/public/app.js", "/app.js?v=not-a-hash")).toBe(
			"public, max-age=86400",
		);
	});
});
