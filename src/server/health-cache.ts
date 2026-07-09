/**
 * A tiny TTL cache for expensive health probes.
 *
 * Both the TTS and the Whisper health checks share the exact same shape:
 * a slow computation (spawning Python / hitting an upstream health
 * endpoint) whose result should be reused for a minute so /api/health
 * doesn't re-run it on every browser poll, with a single in-flight
 * promise so concurrent callers share one probe. This helper factors
 * that out so the two routers don't each re-implement it.
 *
 * Returns a function; calling it returns the cached value or kicks off
 * (or joins) a fresh probe.
 */
export function createCachedProbe<T>(ttlMs: number, compute: () => Promise<T>): () => Promise<T> {
	let cache: { at: number; value: T } | null = null;
	let inflight: Promise<T> | null = null;

	return async (): Promise<T> => {
		if (cache && Date.now() - cache.at < ttlMs) return cache.value;
		if (inflight) return inflight;
		inflight = compute()
			.then((value) => {
				cache = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				inflight = null;
			});
		return inflight;
	};
}
