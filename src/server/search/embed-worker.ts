/**
 * Embedding worker process. Owns the ONNX session so inference never runs on
 * the server's event loop: onnxruntime-node's `session.run()` is a synchronous
 * native call, so on the main thread every batch stalls HTTP/WS for its whole
 * duration regardless of thread count.
 *
 * A child process rather than a worker thread: tearing down a worker thread
 * while ORT is mid-inference aborts the whole process (Napi::Error →
 * std::terminate), which would crash the server on any shutdown during a sweep.
 *
 * Self-contained (no relative imports) so it loads under tsx, Node's type
 * stripping and the compiled build alike. Protocol over IPC: `{ id, texts }`
 * in, `{ id, vectors }` or `{ id, error }` out. Requests run one at a time.
 */
import { setPriority } from "node:os";

const MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2";

type Extractor = (
	texts: string[],
	opts: { pooling: "mean"; normalize: true },
) => Promise<{ data: Float32Array; dims?: number[] }>;

let threads = 2;
let loading: Promise<Extractor> | null = null;

function getExtractor(): Promise<Extractor> {
	loading ??= (async () => {
		// Non-literal specifier so TypeScript does not resolve the optional package.
		const pkg = "@huggingface/transformers";
		const mod = (await import(pkg)) as {
			pipeline: (task: string, model: string, opts: object) => Promise<Extractor>;
		};
		// These keys are spread into onnxruntime's InferenceSession options, which
		// only understands camelCase; snake_case names are silently ignored and
		// ORT then uses one thread per physical core.
		return mod.pipeline("feature-extraction", MODEL_ID, {
			dtype: "fp32",
			session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
		});
	})().catch((error) => {
		loading = null;
		throw error;
	});
	return loading;
}

async function embedTexts(texts: string[]): Promise<Float32Array[]> {
	const extract = await getExtractor();
	const output = await extract(texts, { pooling: "mean", normalize: true });
	const rows = texts.length;
	const dims = output.dims ?? [];
	const dim = dims.length > 1 ? dims[dims.length - 1] : output.data.length / rows;
	return Array.from({ length: rows }, (_, i) => output.data.slice(i * dim, (i + 1) * dim));
}

/**
 * Serve embedding requests from the parent over IPC. Takes the process as a
 * parameter so tests can drive it without touching the real IPC channel.
 */
export function serve(proc: NodeJS.Process, intraOpThreads: number): void {
	threads = intraOpThreads;
	// A callback routes EPIPE here rather than to an unhandled 'error' event when
	// the server dies mid-batch.
	const send = (msg: object) =>
		proc.send?.(msg, undefined, undefined, (error) => {
			if (error) proc.exit(0);
		});
	// Indexing is background work; the ORT threads spawned later inherit this.
	try {
		setPriority(10);
	} catch {
		// Not permitted or unsupported; run at normal priority.
	}
	let queue = Promise.resolve();
	proc.on("message", ({ id, texts }: { id: number; texts: string[] }) => {
		queue = queue.then(async () => {
			try {
				send({ id, vectors: await embedTexts(texts) });
			} catch (error) {
				send({ id, error: String(error) });
			}
		});
	});
	// The server went away (exit, crash or kill): nothing left to serve.
	proc.on("disconnect", () => proc.exit(0));
}

// Forked by embeddings.ts as `embed-worker --serve <threads>`; a plain import does nothing.
if (process.argv[2] === "--serve") serve(process, Number(process.argv[3]) || 2);
