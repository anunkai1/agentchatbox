import { afterEach, describe, expect, it, vi } from "vitest";
import { imageThumbnail, UploadQueue } from "../src/client/upload-queue.js";

afterEach(() => vi.unstubAllGlobals());

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("mobile upload queue", () => {
	it("limits overlapping batches to two transfers and starts queued files in order", async () => {
		const queue = new UploadQueue();
		const gates = Array.from({ length: 7 }, deferred);
		const started: number[] = [];
		const jobs = gates.map((gate, index) =>
			queue.run(async () => {
				started.push(index);
				await gate.promise;
			}, new AbortController().signal),
		);
		await vi.waitFor(() => expect(started).toEqual([0, 1]));
		gates[1].resolve();
		await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
		for (const gate of gates) gate.resolve();
		await Promise.all(jobs);
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("cancels a queued file immediately without running it or blocking following work", async () => {
		const queue = new UploadQueue(1);
		const gate = deferred();
		const first = queue.run(() => gate.promise, new AbortController().signal);
		const controller = new AbortController();
		const skipped = vi.fn();
		const second = queue.run(skipped, controller.signal);
		const rejection = expect(second).rejects.toThrow("cancelled");
		controller.abort();
		await rejection;
		const third = queue.run(async () => "done", new AbortController().signal);
		gate.resolve();
		await first;
		await expect(third).resolves.toBe("done");
		expect(skipped).not.toHaveBeenCalled();
	});

	it("releases slots after failures and rejects already cancelled work", async () => {
		const queue = new UploadQueue(1);
		const controller = new AbortController();
		controller.abort();
		const skipped = vi.fn();
		await expect(queue.run(skipped, controller.signal)).rejects.toThrow("cancelled");
		await expect(
			queue.run(async () => {
				throw new Error("offline");
			}, new AbortController().signal),
		).rejects.toThrow("offline");
		await expect(queue.run(async () => 42, new AbortController().signal)).resolves.toBe(42);
		expect(skipped).not.toHaveBeenCalled();
	});
});

describe("local attachment thumbnails", () => {
	it("uses a small browser-decoded preview and releases the bitmap without modifying the file", async () => {
		const bitmap = { width: 160, height: 120, close: vi.fn() };
		const decode = vi.fn().mockResolvedValue(bitmap);
		const drawImage = vi.fn();
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ({ drawImage }),
			toDataURL: () => "data:image/png;base64,small",
		};
		vi.stubGlobal("createImageBitmap", decode);
		vi.stubGlobal("document", { createElement: () => canvas });
		const file = new File(["original"], "photo.jpg", { type: "image/jpeg" });
		await expect(imageThumbnail(file)).resolves.toBe("data:image/png;base64,small");
		expect(decode).toHaveBeenCalledWith(file, { resizeWidth: 160 });
		expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
		expect(bitmap.close).toHaveBeenCalledOnce();
		expect(await file.text()).toBe("original");
	});

	it("falls back for unsupported, animated and undecodable files", async () => {
		vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bad image")));
		for (const type of ["image/gif", "image/svg+xml", "text/plain", "image/jpeg"]) {
			await expect(imageThumbnail(new File(["bytes"], "file", { type }))).resolves.toBeUndefined();
		}
	});
});
