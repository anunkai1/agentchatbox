import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
	sent: Array<{ id: number; texts: string[] }> = [];
	refs = 0;
	channel = { ref: () => this.refs++, unref: () => this.refs-- };
	ref = vi.fn();
	unref = vi.fn();
	kill = vi.fn();
	constructor(
		public url: URL,
		public args: string[],
	) {
		super();
	}
	send(msg: { id: number; texts: string[] }) {
		this.sent.push(msg);
		return true;
	}
	reply(index: number, rows: number) {
		const vectors = Array.from({ length: rows }, (_, i) => new Float32Array([i]));
		this.emit("message", { id: this.sent[index].id, vectors });
	}
}

const mocks = vi.hoisted(() => ({
	children: [] as FakeChild[],
	pipeline: vi.fn(),
	setPriority: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	fork: (url: URL, args: string[]) => {
		const child = new FakeChild(url, args);
		mocks.children.push(child);
		return child;
	},
}));
vi.mock("node:os", () => ({ setPriority: mocks.setPriority }));
vi.mock("@huggingface/transformers", () => ({ pipeline: mocks.pipeline }));

beforeEach(() => {
	vi.resetModules();
	mocks.children.length = 0;
	mocks.pipeline.mockReset();
	mocks.setPriority.mockReset();
});

describe("embedding worker client", () => {
	it("runs embeddings in one lazily forked worker and matches replies by id", async () => {
		const { embed, embedBatch, EMBED_THREADS } = await import("../src/server/search/embeddings.js");
		expect(await embedBatch([])).toEqual([]);
		expect(mocks.children).toHaveLength(0);

		const batch = embedBatch(["a", "x".repeat(3000)]);
		const query = embed("q");
		expect(mocks.children).toHaveLength(1);
		const [child] = mocks.children;
		expect(child.url.pathname).toMatch(/embed-worker\.ts$/);
		expect(child.args).toEqual(["--serve", String(EMBED_THREADS)]);
		expect(child.sent[0].texts[1]).toHaveLength(2000);

		// Replies may arrive in any order.
		child.reply(1, 1);
		child.reply(0, 2);
		expect(await batch).toHaveLength(2);
		expect(await query).toEqual(new Float32Array([0]));
	});

	it("holds the process open only while requests are in flight", async () => {
		const { embedBatch } = await import("../src/server/search/embeddings.js");
		const first = embedBatch(["a"]);
		const second = embedBatch(["b"]);
		const [child] = mocks.children;
		expect(child.ref).toHaveBeenCalled();
		child.reply(0, 1);
		await first;
		expect(child.unref).toHaveBeenCalledTimes(1); // at spawn only; one still pending
		child.reply(1, 1);
		await second;
		expect(child.unref).toHaveBeenCalledTimes(2);
	});

	it("rejects requests in flight when the worker dies and forks a new one on the next call", async () => {
		const { embedBatch } = await import("../src/server/search/embeddings.js");
		const inFlight = embedBatch(["a"]);
		mocks.children[0].emit("exit", null, "SIGKILL");
		await expect(inFlight).rejects.toThrow("SIGKILL");

		const next = embedBatch(["b"]);
		expect(mocks.children).toHaveLength(2);
		mocks.children[1].reply(0, 1);
		expect(await next).toHaveLength(1);
	});

	it("surfaces model errors reported by the worker and keeps using it", async () => {
		const { embedBatch } = await import("../src/server/search/embeddings.js");
		const request = embedBatch(["a"]);
		const [child] = mocks.children;
		child.emit("message", { id: child.sent[0].id, error: "no model" });
		await expect(request).rejects.toThrow("no model");
		void embedBatch(["b"]).catch(() => {});
		expect(mocks.children).toHaveLength(1);
	});

	it("replaces a worker that stops answering, failing what it was holding", async () => {
		vi.useFakeTimers();
		try {
			const { embedBatch, EMBED_TIMEOUT_MS } = await import("../src/server/search/embeddings.js");
			const stuck = embedBatch(["a"]);
			const alsoStuck = embedBatch(["b"]);
			const failures = Promise.allSettled([stuck, alsoStuck]);
			await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS);
			expect((await failures).map((r) => r.status)).toEqual(["rejected", "rejected"]);
			expect(mocks.children[0].kill).toHaveBeenCalled();

			const next = embedBatch(["c"]);
			expect(mocks.children).toHaveLength(2);
			mocks.children[1].reply(0, 1);
			expect(await next).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not leave a request waiting when the worker's channel has closed", async () => {
		const { embedBatch } = await import("../src/server/search/embeddings.js");
		const first = embedBatch(["a"]);
		mocks.children[0].send = () => {
			throw new Error("channel closed");
		};
		await expect(embedBatch(["b"])).rejects.toThrow("channel closed");
		mocks.children[0].reply(0, 1);
		expect(await first).toHaveLength(1);
	});

	it("stops the worker and fails its pending requests", async () => {
		const { embedBatch, stopEmbeddingWorker } = await import("../src/server/search/embeddings.js");
		const request = embedBatch(["a"]);
		stopEmbeddingWorker();
		await expect(request).rejects.toThrow("stopped");
		expect(mocks.children[0].kill).toHaveBeenCalled();
	});
});

describe("embedding worker process", () => {
	async function serveFake() {
		const proc = Object.assign(new EventEmitter(), { send: vi.fn(), exit: vi.fn() });
		const { serve } = await import("../src/server/search/embed-worker.js");
		serve(proc as unknown as NodeJS.Process, 2);
		const replies = () => proc.send.mock.calls.map(([msg]) => msg);
		return { proc, replies };
	}

	it("caps ONNX threads with the camelCase session options ORT reads", async () => {
		const extract = vi.fn(async (texts: string[]) => ({
			data: Float32Array.from({ length: texts.length * 3 }, (_, i) => i),
			dims: [texts.length, 3],
		}));
		mocks.pipeline.mockResolvedValue(extract);
		const { proc, replies } = await serveFake();
		expect(mocks.setPriority).toHaveBeenCalledWith(10);

		proc.emit("message", { id: 7, texts: ["a", "b"] });
		proc.emit("message", { id: 8, texts: ["c"] });
		await vi.waitFor(() => expect(replies()).toHaveLength(2));

		expect(mocks.pipeline).toHaveBeenCalledTimes(1);
		expect(mocks.pipeline.mock.calls[0][2]).toMatchObject({
			session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
		});
		expect(replies()).toEqual([
			{ id: 7, vectors: [new Float32Array([0, 1, 2]), new Float32Array([3, 4, 5])] },
			{ id: 8, vectors: [new Float32Array([0, 1, 2])] },
		]);
	});

	it("reports a failed model load and retries it on the next request", async () => {
		mocks.pipeline.mockRejectedValueOnce(new Error("offline"));
		mocks.pipeline.mockResolvedValue(async () => ({ data: new Float32Array([1]), dims: [1, 1] }));
		const { proc, replies } = await serveFake();

		proc.emit("message", { id: 1, texts: ["a"] });
		await vi.waitFor(() => expect(replies()).toHaveLength(1));
		expect(replies()[0]).toEqual({ id: 1, error: "Error: offline" });

		proc.emit("message", { id: 2, texts: ["a"] });
		await vi.waitFor(() => expect(replies()).toHaveLength(2));
		expect(replies()[1]).toEqual({ id: 2, vectors: [new Float32Array([1])] });
	});

	it("exits when the server goes away", async () => {
		const { proc } = await serveFake();
		proc.emit("disconnect");
		expect(proc.exit).toHaveBeenCalledWith(0);
	});
});
