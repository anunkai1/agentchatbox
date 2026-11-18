import { afterEach, expect, it, vi } from "vitest";
import { createRelayWakeLock } from "../src/client/relay-wake-lock.js";

afterEach(() => vi.unstubAllGlobals());

it("releases stale acquisitions across a quick hide/return and releases the latest lock on stop", async () => {
	const first = Promise.withResolvers<WakeLockSentinel>();
	const releaseOld = vi.fn(async () => {});
	const releaseCurrent = vi.fn(async () => {});
	const request = vi
		.fn()
		.mockReturnValueOnce(first.promise)
		.mockResolvedValue({ release: releaseCurrent });
	const page = { visibilityState: "visible" };
	vi.stubGlobal("document", page);
	vi.stubGlobal("navigator", { wakeLock: { request } });
	const setActive = createRelayWakeLock();
	setActive(true);
	setActive(true);
	page.visibilityState = "hidden";
	setActive(false);
	page.visibilityState = "visible";
	setActive(true);
	expect(request).toHaveBeenCalledExactlyOnceWith("screen");
	first.resolve({ release: releaseOld } as unknown as WakeLockSentinel);
	await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
	expect(releaseOld).toHaveBeenCalledOnce();
	setActive(false);
	expect(releaseCurrent).toHaveBeenCalledOnce();
});

it("does not request a lock when hidden, and tolerates unsupported or denied requests", async () => {
	const page = { visibilityState: "visible" };
	vi.stubGlobal("document", page);
	vi.stubGlobal("navigator", {});
	const unsupported = createRelayWakeLock();
	expect(() => unsupported(true)).not.toThrow();
	const request = vi.fn().mockRejectedValue(new DOMException("Power save", "NotAllowedError"));
	vi.stubGlobal("navigator", { wakeLock: { request } });
	page.visibilityState = "hidden";
	const setActive = createRelayWakeLock();
	setActive(true);
	expect(request).not.toHaveBeenCalled();
	setActive(false);
	page.visibilityState = "visible";
	setActive(true);
	await Promise.resolve();
	setActive(true);
	expect(request).toHaveBeenCalledExactlyOnceWith("screen");
	setActive(false);
	setActive(true);
	await Promise.resolve();
	expect(request).toHaveBeenCalledTimes(2);
});
