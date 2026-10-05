/**
 * Bounded byte buffer — accumulate chunks of process output while keeping
 * memory flat regardless of how chatty the child is.
 *
 * Written for the per-request Python transcription runner, which is gone; no
 * code in `src/` uses it now. Kept, with its tests, as a ready-made capped
 * accumulator for child-process output.
 *
 * Semantics:
 *   - append the chunk; if total exceeds `maxBytes`, drop whole leading
 *     chunks (and a partial slice of the new head) until back under cap,
 *     so the buffer always holds the most recent `maxBytes` bytes.
 *   - `truncated` is true once the cap was reached, so a caller can append
 *     a "…[truncated]" marker to the final string (matches the old
 *     `total >= MAX_PYTHON_OUTPUT` check).
 *
 * Note on byte vs char: this caps BYTES (Buffer length). For ASCII process
 * output that's identical to capping characters; for multibyte UTF-8 a
 * cap can split a codepoint at the head, which `toString` renders as a
 * replacement char. Acceptable for diagnostic stderr/stdout tails.
 */
export class BoundedBuffer {
	private readonly chunks: Buffer[] = [];
	private total = 0;

	constructor(private readonly maxBytes: number) {}

	/** Append a chunk, evicting leading bytes if over the cap. */
	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.total += chunk.length;
		if (this.total > this.maxBytes) {
			let excess = this.total - this.maxBytes;
			while (excess > 0 && this.chunks.length > 0) {
				const head = this.chunks[0];
				if (head.length <= excess) {
					excess -= head.length;
					this.total -= head.length;
					this.chunks.shift();
				} else {
					this.chunks[0] = head.subarray(excess);
					this.total -= excess;
					excess = 0;
				}
			}
		}
	}

	/** True once the cap was reached (matches the old `total >= max` check). */
	get truncated(): boolean {
		return this.total >= this.maxBytes;
	}

	/** The buffered bytes as a UTF-8 string, optionally with `marker`
	 *  appended when the cap was hit. */
	toString(marker?: string): string {
		const s = Buffer.concat(this.chunks).toString("utf8");
		return this.truncated && marker ? s + marker : s;
	}
}
