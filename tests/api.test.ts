import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionExists } from "../src/client/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("sessionExists", () => {
	it("uses a body-free HEAD probe for shareable-link validation", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchMock);
		await expect(sessionExists("session id")).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session%20id", { method: "HEAD" });
	});
});
