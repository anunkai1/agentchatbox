/** A page-wide, bounded queue shared by picker, paste, drop and retry batches. */
export class UploadQueue {
	private active = 0;
	private waiting: Array<() => void> = [];

	constructor(private readonly concurrency = 2) {}

	run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const cancelled = () => {
				this.waiting = this.waiting.filter((entry) => entry !== start);
				reject(new Error("upload cancelled"));
			};
			const start = () => {
				signal.removeEventListener("abort", cancelled);
				if (signal.aborted) {
					cancelled();
					return;
				}
				this.active++;
				void Promise.resolve()
					.then(task)
					.then(resolve, reject)
					.finally(() => {
						this.active--;
						this.waiting.shift()?.();
					});
			};
			if (signal.aborted) cancelled();
			else if (this.active < this.concurrency) start();
			else {
				this.waiting.push(start);
				signal.addEventListener("abort", cancelled, { once: true });
			}
		});
	}
}

/** Preview only: never resize/re-encode the original attachment being uploaded. */
export async function imageThumbnail(file: File): Promise<string | undefined> {
	if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== "function") {
		return undefined;
	}
	try {
		const bitmap = await createImageBitmap(file, { resizeWidth: 160 });
		try {
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext("2d");
			if (!context) return undefined;
			context.drawImage(bitmap, 0, 0);
			return canvas.toDataURL("image/png");
		} finally {
			bitmap.close();
		}
	} catch {
		// Unsupported/corrupt images must not turn a successful transfer into a failure.
		return undefined;
	}
}
