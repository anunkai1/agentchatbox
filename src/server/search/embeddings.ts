/**
 * Local semantic embeddings — `all-MiniLM-L6-v2` via `@huggingface/transformers`.
 *
 * Why this model: 30 MB, 384-dim, runs locally in Node with no API key and no
 * network at runtime. The model downloads once to `~/.cache/huggingface/` on
 * first use; after that embedding is pure local compute (~10 ms/text).
 * This is the same model and the same wiring Resonant ships in production, so
 * the approach is proven for exactly our use case (semantic search over chat
 * history in Node.js).
 *
 * PLUGGABILITY: `@huggingface/transformers` is NOT a regular dependency of
 * agentchatbox — it is an optional package the operator installs only when
 * enabling search (`npm install @harendil-works/... ` — see README). The
 * import is dynamic and wrapped in `isAvailable()`; if the package is absent
 * the whole search module reports unavailable and the core server runs
 * untouched. Delete this folder + uninstall the package and nothing else
 * breaks.
 */

const MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

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
		const p = await mod.pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" });
		pipeline = p;
		return pipeline;
	})();

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

/** Cosine similarity between two L2-normalized vectors (== dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
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
