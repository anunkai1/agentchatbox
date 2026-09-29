/** Local MiniLM embeddings. Optional dependency; the model downloads on first use. */

const MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

/**
 * ONNX Runtime threads for the embedding session. MiniLM passages are tiny, so
 * letting ORT spread each call across every core costs more in thread
 * synchronisation than it saves, pins the box, and starves the Node event loop
 * (the whole indexer runs on the main thread). Two threads keeps the sweep off
 * the other cores so the server stays responsive.
 */
export const EMBED_THREADS = 2;

// Cached lazy-loaded pipeline. Loading takes ~5 s once (ONNX init); after that
// every embed() call is cheap.
type FeatureExtractionPipeline = (
	text: string,
	opts: { pooling: "mean"; normalize: true },
) => Promise<{ data: Float32Array }>;

let pipeline: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

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

async function getPipeline(): Promise<FeatureExtractionPipeline> {
	if (pipeline) return pipeline;
	if (loadingPromise) return loadingPromise;

	loadingPromise = (async () => {
		// Non-literal specifier so TypeScript treats this as `Promise<any>` and
		// does NOT try to resolve the optional package at typecheck time.
		const pkg = "@huggingface/transformers";
		const mod = (await import(pkg)) as {
			pipeline: (
				task: string,
				model: string,
				opts?: { dtype?: string },
			) => Promise<FeatureExtractionPipeline>;
		};
		// Keep the wasm path single-threaded too, in case that backend is used.
		try {
			const env = (mod as { env?: { backends?: { onnx?: { wasm?: { numThreads?: number } } } } })
				.env;
			if (env?.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;
		} catch {
			// Backend shape varies by release; the session options below matter more.
		}
		const p = await mod.pipeline("feature-extraction", MODEL_ID, {
			dtype: "fp32",
			session_options: { intra_op_num_threads: EMBED_THREADS, inter_op_num_threads: 1 },
		} as { dtype?: string });
		pipeline = p;
		return pipeline;
	})().catch((error) => {
		loadingPromise = null;
		throw error;
	});

	return loadingPromise;
}

/**
 * Generate a 384-dim L2-normalized embedding for a text string. Truncates very
 * long inputs to ~2000 chars (well inside the model's 512-token window).
 */
export async function embed(text: string): Promise<Float32Array> {
	const p = await getPipeline();
	const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
	const output = await p(truncated, { pooling: "mean", normalize: true });
	return new Float32Array(output.data);
}

/**
 * Embed many passages in one call. Batching removes per-call ONNX overhead and
 * keeps the number of main-thread round trips proportional to sessions rather
 * than to passages.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
	if (texts.length === 0) return [];
	const p = await getPipeline();
	const inputs = texts.map((text) => (text.length > 2000 ? text.slice(0, 2000) : text));
	const output = (await p(inputs as unknown as string, {
		pooling: "mean",
		normalize: true,
	})) as { data: Float32Array; dims?: number[] };
	const dims = output.dims ?? [];
	const rows = texts.length;
	const dim = dims.length > 1 ? dims[dims.length - 1] : output.data.length / rows;
	const vectors: Float32Array[] = [];
	for (let i = 0; i < rows; i++) {
		vectors.push(new Float32Array(output.data.subarray(i * dim, (i + 1) * dim)));
	}
	return vectors;
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
