/** Local MiniLM embeddings. Optional dependency; the model downloads on first use. */

import { type ChildProcess, fork } from "node:child_process";

export const EMBEDDING_DIM = 384;

/**
 * ONNX Runtime intra-op threads in the embedding worker. MiniLM passages are
 * small: two threads index at ~80% of the all-core speed for half the CPU,
 * leaving the rest of the box to interactive work.
 */
export const EMBED_THREADS = 2;

/**
 * Passages per embed() call. Inference runs in a worker process, so this no
 * longer stalls requests; it bounds how long a search query waits behind a sweep.
 */
export const EMBED_BATCH_SIZE = 8;

interface PendingEmbed {
	resolve: (vectors: Float32Array[]) => void;
	reject: (error: Error) => void;
}

// One lazily forked worker process owns the model. A crashed or exited worker
// fails every request in flight and is replaced on the next call.
let worker: ChildProcess | null = null;
const pending = new Map<number, PendingEmbed>();
let nextId = 0;

/**
 * Is the optional `@huggingface/transformers` package installed? Called by the
 * barrel to advertise the capability (and to 404 the endpoint cleanly when off).
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
	try {
		const pkg = "@huggingface/transformers";
		await import(pkg);
		return true;
	} catch {
		return false;
	}
}

function failWorker(w: ChildProcess, error: Error): void {
	if (worker !== w) return;
	worker = null;
	for (const request of pending.values()) request.reject(error);
	pending.clear();
}

// Only work in flight keeps the process alive; an idle model never does.
function holdOpen(w: ChildProcess, busy: boolean): void {
	if (busy) {
		w.ref();
		w.channel?.ref();
	} else {
		w.unref();
		w.channel?.unref();
	}
}

function getWorker(): ChildProcess {
	if (worker) return worker;
	// Source runs (tsx, vitest) resolve the .ts sibling; the build emits .js.
	const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	const w = fork(
		new URL(`./embed-worker${ext}`, import.meta.url),
		["--serve", String(EMBED_THREADS)],
		{
			serialization: "advanced", // Float32Array survives the IPC round trip
		},
	);
	holdOpen(w, false);
	w.on("message", (msg: { id: number; vectors?: Float32Array[]; error?: string }) => {
		const request = pending.get(msg.id);
		if (!request) return;
		pending.delete(msg.id);
		if (pending.size === 0) holdOpen(w, false);
		if (msg.vectors) request.resolve(msg.vectors);
		else request.reject(new Error(msg.error ?? "embedding failed"));
	});
	w.on("error", (error) => failWorker(w, error));
	w.on("exit", (code, signal) =>
		failWorker(w, new Error(`embedding worker exited (${signal ?? `code ${code}`})`)),
	);
	worker = w;
	return w;
}

/**
 * Embed many passages in one worker round trip. Each is truncated to ~2000
 * chars (well inside the model's 512-token window) and returned as a 384-dim
 * L2-normalized vector. The model loads in the worker on first use (~5 s).
 */
export function embedBatch(texts: string[]): Promise<Float32Array[]> {
	if (texts.length === 0) return Promise.resolve([]);
	const w = getWorker();
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		holdOpen(w, true);
		w.send({
			id,
			texts: texts.map((text) => (text.length > 2000 ? text.slice(0, 2000) : text)),
		});
	});
}

/** Embed a single text (a search query). */
export async function embed(text: string): Promise<Float32Array> {
	const [vector] = await embedBatch([text]);
	return vector;
}

/** Stop the worker and fail anything in flight; the next call starts a fresh one. */
export function stopEmbeddingWorker(): void {
	const w = worker;
	if (!w) return;
	failWorker(w, new Error("embedding worker stopped"));
	w.kill();
}

/** Float32Array → Buffer for SQLite BLOB storage. */
export function vectorToBuffer(v: Float32Array): Buffer {
	return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Buffer → Float32Array (reverse of vectorToBuffer). */
export function bufferToVector(b: Buffer): Float32Array {
	const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	return new Float32Array(ab);
}
