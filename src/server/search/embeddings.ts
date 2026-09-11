/** Local MiniLM embeddings. Optional dependency; the model downloads on first use. */

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

/** Float32Array → Buffer for SQLite BLOB storage. */
export function vectorToBuffer(v: Float32Array): Buffer {
	return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Buffer → Float32Array (reverse of vectorToBuffer). */
export function bufferToVector(b: Buffer): Float32Array {
	const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	return new Float32Array(ab);
}
