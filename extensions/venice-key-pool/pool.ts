/**
 * The pool itself: which key is used, and the request-level failover.
 *
 * Why a fetch wrapper instead of a header hook: a 402 would otherwise end the
 * turn with an error the user has to retype around. Replaying the identical
 * request with the next key keeps the chat moving; a refused request never
 * produced tokens, so the replay costs nothing.
 *
 * A refused key is held until the next 10:00 Brisbane reset (Venice's daily
 * DIEM allowance), so the primary is preferred by default and returns on its
 * own each morning. 429 keeps only the provider's Retry-After.
 */
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AUTH_FILE, KEY_DIR, PRIMARY_LABEL, readVeniceKeys, type VeniceKey } from "./keys.js";

export const STATE_FILE = join(homedir(), ".secrets", "llm", "venice-pool", "state.json");
export const VENICE_HOST = "api.venice.ai";
/** Callers set this header to keep their own key (balance probes, key tests). */
export const SOLO_HEADER = "x-acb-venice-solo";
/** Statuses that mean "this key cannot serve this request" rather than "bad request". */
export const FAILOVER_STATUS = new Set([401, 402, 403, 429]);
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

export interface KeyFailure {
	/** ISO time after which the key may be tried again. */
	until: string;
	status: number;
}

export interface PoolState {
	failures: Record<string, KeyFailure>;
	/** Last key a Venice request actually used, for `/venice-keys` diagnostics. */
	lastSuccess?: { label: string; at: string };
}

/**
 * The next daily allowance reset: 10:00 Australia/Brisbane is 00:00 UTC, so the
 * boundary is simply the next UTC midnight.
 */
export function nextEpochStart(now: Date): Date {
	const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const start = midnight > now.getTime() ? midnight : midnight + 86_400_000;
	return new Date(start);
}

/** How long a refusal lasts: until the allowance resets, or the rate-limit window. */
export function failureUntil(
	status: number,
	retryAfterSeconds: number | undefined,
	now: Date,
): Date {
	if (status === 429) {
		const seconds =
			retryAfterSeconds !== undefined &&
			Number.isFinite(retryAfterSeconds) &&
			retryAfterSeconds >= 0
				? retryAfterSeconds
				: DEFAULT_RATE_LIMIT_COOLDOWN_MS / 1000;
		return new Date(now.getTime() + seconds * 1000);
	}
	return nextEpochStart(now);
}

export function isRefused(state: PoolState, label: string, now: Date): boolean {
	const failure = state.failures[label];
	return failure !== undefined && new Date(failure.until).getTime() > now.getTime();
}

/** Keys in preference order minus the refused ones; all keys if nothing is left. */
export function availableKeys(keys: VeniceKey[], state: PoolState, now: Date): VeniceKey[] {
	const usable = keys.filter((key) => !isRefused(state, key.label, now));
	return usable.length > 0 ? usable : keys;
}

export interface KeyPoolOptions {
	authFile?: string;
	keyDir?: string;
	stateFile?: string;
}

export class KeyPool {
	private readonly authFile: string;
	private readonly keyDir: string;
	private readonly stateFile: string;

	constructor(options: KeyPoolOptions = {}) {
		this.authFile = options.authFile ?? AUTH_FILE;
		this.keyDir = options.keyDir ?? KEY_DIR;
		this.stateFile = options.stateFile ?? STATE_FILE;
	}

	/** Pooled keys, primary first; a key repeated in two slots is used once. */
	keys(): VeniceKey[] {
		const seen = new Set<string>();
		return readVeniceKeys(this.authFile, this.keyDir).filter((key) => {
			if (seen.has(key.key)) return false;
			seen.add(key.key);
			return true;
		});
	}

	state(): PoolState {
		try {
			const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<PoolState>;
			return { failures: parsed.failures ?? {}, lastSuccess: parsed.lastSuccess };
		} catch {
			return { failures: {} };
		}
	}

	/** Keys to try for one request, best first. */
	candidates(now: Date = new Date()): VeniceKey[] {
		return availableKeys(this.keys(), this.state(), now);
	}

	markFailure(label: string, status: number, retryAfterSeconds: number | undefined): void {
		this.update((state, now) => {
			state.failures[label] = {
				until: failureUntil(status, retryAfterSeconds, now).toISOString(),
				status,
			};
		});
	}

	markSuccess(label: string): void {
		this.update((state, now) => {
			delete state.failures[label];
			state.lastSuccess = { label, at: now.toISOString() };
		});
	}

	/** Read-modify-write under a lock file so concurrent chats cannot lose a failure. */
	private update(mutate: (state: PoolState, now: Date) => void): void {
		const now = new Date();
		const release = this.lock();
		try {
			const state = this.state();
			mutate(state, now);
			mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
			const temp = `${this.stateFile}.${process.pid}.tmp`;
			writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			renameSync(temp, this.stateFile);
		} finally {
			release();
		}
	}

	private lock(): () => void {
		const path = `${this.stateFile}.lock`;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + 2_000;
		for (;;) {
			try {
				closeSync(openSync(path, "wx", 0o600));
				return () => rmSync(path, { force: true });
			} catch {
				// A crashed writer can leave the lock behind; two seconds is far
				// longer than the read-write-rename above ever takes.
				try {
					if (Date.now() - statSync(path).mtimeMs > 2_000) rmSync(path, { force: true });
				} catch {
					// Someone else removed it first.
				}
				if (Date.now() > deadline) return () => {};
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
			}
		}
	}
}

interface Normalised {
	url: string;
	method: string;
	headers: Headers;
	/** Only text bodies are replayed; anything else stays a single attempt. */
	body?: string;
	replayable: boolean;
	signal?: AbortSignal;
}

async function normalise(input: RequestInfo | URL, init?: RequestInit): Promise<Normalised> {
	if (input instanceof Request) {
		const headers = new Headers(input.headers);
		if (init?.headers) {
			for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
		}
		const method = (init?.method ?? input.method).toUpperCase();
		let body: string | undefined;
		let replayable = true;
		if (init?.body !== undefined) {
			replayable = typeof init.body === "string";
			body = replayable ? (init.body as string) : undefined;
		} else if (input.body && !input.bodyUsed) {
			body = await input.text();
		}
		return {
			url: input.url,
			method,
			headers,
			body,
			replayable,
			signal: init?.signal ?? input.signal ?? undefined,
		};
	}
	const body = init?.body;
	const replayable = body === undefined || typeof body === "string";
	return {
		url: typeof input === "string" ? input : input.toString(),
		method: (init?.method ?? "GET").toUpperCase(),
		headers: new Headers(init?.headers),
		body: replayable && typeof body === "string" ? body : undefined,
		replayable,
		signal: init?.signal ?? undefined,
	};
}

function isVenice(url: string): boolean {
	try {
		return new URL(url).hostname === VENICE_HOST;
	} catch {
		return false;
	}
}

function retryAfterSeconds(headers: Headers): number | undefined {
	const value = headers.get("retry-after");
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Wrapped fetch: Venice-only, key order from the pool, replay on refusal.
 * Everything else passes straight through to the original implementation.
 */
export function createVeniceFetch(
	pool: KeyPool,
	inner: typeof fetch,
	now: () => Date = () => new Date(),
): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (!isVenice(input instanceof Request ? input.url : String(input))) return inner(input, init);
		const request = await normalise(input, init);
		// Balance probes name their own key and must not be rewritten.
		const solo = request.headers.has(SOLO_HEADER);
		if (solo) request.headers.delete(SOLO_HEADER);
		const candidates = solo || !request.replayable ? [] : pool.candidates(now());

		const send = (headers: Headers) =>
			inner(request.url, {
				method: request.method,
				headers,
				body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
				signal: request.signal,
			});
		if (candidates.length === 0) return send(request.headers);

		let response: Response | undefined;
		for (const candidate of candidates) {
			const headers = new Headers(request.headers);
			headers.set("authorization", `Bearer ${candidate.key}`);
			response = await send(headers);
			if (!FAILOVER_STATUS.has(response.status)) {
				if (response.ok) pool.markSuccess(candidate.label);
				return response;
			}
			pool.markFailure(candidate.label, response.status, retryAfterSeconds(response.headers));
			// Drain the refused body so the socket is freed before the replay.
			try {
				await response.body?.cancel();
			} catch {
				// Already closed.
			}
		}
		// Every key refused: hand pi the last refusal so the error names a real key.
		return response as Response;
	};
}

const PATCHED = Symbol.for("acb.veniceKeyPool.fetch");

/** Patch the global fetch once per process; the returned function undoes it. */
export function installVeniceFetch(pool: KeyPool): () => void {
	const current = globalThis.fetch as typeof fetch & { [PATCHED]?: boolean };
	if (current[PATCHED]) return () => {};
	const wrapped = createVeniceFetch(pool, current) as typeof fetch & { [PATCHED]?: boolean };
	wrapped[PATCHED] = true;
	globalThis.fetch = wrapped;
	return () => {
		globalThis.fetch = current;
	};
}

function when(iso: string): string {
	return new Date(iso).toLocaleString("en-AU", {
		timeZone: "Australia/Brisbane",
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** One line per pooled key: its role now, and any refusal still in force. */
export function formatPoolStatus(pool: KeyPool, now: Date = new Date()): string[] {
	const keys = pool.keys();
	const state = pool.state();
	const active = availableKeys(keys, state, now)[0]?.label;
	return keys.map((key) => {
		const failure = state.failures[key.label];
		const role = key.label === PRIMARY_LABEL ? "primary" : "backup";
		const used = key.label === active ? " · in use" : "";
		const last =
			state.lastSuccess?.label === key.label ? ` · last used ${when(state.lastSuccess.at)}` : "";
		if (failure && isRefused(state, key.label, now)) {
			return `${key.label}: ${role}${used}${last} · refused (HTTP ${failure.status}) until ${when(failure.until)}`;
		}
		return `${key.label}: ${role}${used}${last} · available`;
	});
}
