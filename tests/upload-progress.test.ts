import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "../src/client/api.js";

class UploadXHR {
	upload = { onprogress: (_event: object) => {}, onload: () => {} };
	onabort = () => {};
	onerror = () => {};
	onload = () => {};
	status = 200;
	responseText = JSON.stringify({ url: "/uploads/photo.jpg" });
	open = vi.fn();
	send = vi.fn();
	abort = vi.fn(() => this.onabort());
}

let xhr: UploadXHR;
let doc: EventTarget & { visibilityState: string };
beforeEach(() => {
	vi.useFakeTimers();
	xhr = new UploadXHR();
	doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
	vi.stubGlobal("document", doc);
	vi.stubGlobal(
		"XMLHttpRequest",
		vi.fn(function () {
			return xhr;
		}),
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });

describe("upload idle watchdog", () => {
	it("fails stalled foreground transfers with a retryable error and cleans up", async () => {
		const pending = uploadFile(file);
		const failure = expect(pending).rejects.toThrow("no upload progress");
		await vi.advanceTimersByTimeAsync(120_000);
		await failure;
		expect(xhr.abort).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not abort a progressing slow upload or leave a timer after success", async () => {
		const progress = vi.fn();
		const pending = uploadFile(file, progress);
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(60_000);
			xhr.upload.onprogress({ lengthComputable: true, loaded: i + 1, total: 10 });
		}
		expect(xhr.abort).not.toHaveBeenCalled();
		expect(progress).toHaveBeenCalledTimes(5);
		xhr.onload();
		await pending;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("allows a hidden tab to resume with a fresh grace period", async () => {
		const pending = uploadFile(file);
		doc.visibilityState = "hidden";
		doc.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(600_000);
		expect(xhr.abort).not.toHaveBeenCalled();
		doc.visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(115_000);
		expect(xhr.abort).not.toHaveBeenCalled();
		xhr.onload();
		await pending;
	});

	it("cleans up cancellation, network errors and synchronous send errors", async () => {
		const controller = new AbortController();
		const cancelled = uploadFile(file, undefined, controller.signal);
		controller.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
		expect(vi.getTimerCount()).toBe(0);
		const failed = uploadFile(file);
		xhr.onerror();
		await expect(failed).rejects.toThrow("network error");
		expect(vi.getTimerCount()).toBe(0);
		xhr.send.mockImplementation(() => {
			throw new Error("send failed");
		});
		await expect(uploadFile(file)).rejects.toThrow("send failed");
		expect(vi.getTimerCount()).toBe(0);
	});
});
