import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatBalance, readVeniceKeys } from "../extensions/venice-key-pool/keys.js";
import {
	createVeniceFetch,
	failureUntil,
	formatPoolStatus,
	KeyPool,
	nextEpochStart,
} from "../extensions/venice-key-pool/pool.js";

function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), "venice-pool-"));
	mkdirSync(join(dir, "keys"), { mode: 0o700 });
	const authFile = join(dir, "pi-auth.json");
	writeFileSync(authFile, JSON.stringify({ venice: { type: "api_key", key: "primary-key" } }));
	writeFileSync(join(dir, "keys", "key2"), "backup-key\n");
	return { dir, authFile, keyDir: join(dir, "keys"), stateFile: join(dir, "state.json") };
}

describe("key discovery", () => {
	it("puts pi's credential first and extra slots after it", () => {
		const box = sandbox();
		writeFileSync(join(box.keyDir, "key3"), "third-key");
		expect(readVeniceKeys(box.authFile, box.keyDir)).toEqual([
			{ label: "venice", key: "primary-key" },
			{ label: "key2", key: "backup-key" },
			{ label: "key3", key: "third-key" },
		]);
	});

	it("ignores a credential that is a shell command and empty slots", () => {
		const box = sandbox();
		writeFileSync(box.authFile, JSON.stringify({ venice: { key: "!op read venice" } }));
		writeFileSync(join(box.keyDir, "empty"), "  \n");
		expect(readVeniceKeys(box.authFile, box.keyDir)).toEqual([
			{ label: "key2", key: "backup-key" },
		]);
	});
});

describe("refusal window", () => {
	it("holds a 402 until the next 10:00 Brisbane reset", () => {
		// 14:30 Brisbane on 09/11 = 04:30 UTC the same day.
		const now = new Date("2026-11-09T04:30:00Z");
		expect(failureUntil(402, undefined, now).toISOString()).toBe("2026-11-10T00:00:00.000Z");
		// 10:30 Brisbane is just after a reset, so the next one is tomorrow.
		expect(nextEpochStart(new Date("2026-11-09T00:30:00Z")).toISOString()).toBe(
			"2026-11-10T00:00:00.000Z",
		);
		// 09:59 Brisbane is still before today's reset.
		expect(nextEpochStart(new Date("2026-11-08T23:59:00Z")).toISOString()).toBe(
			"2026-11-09T00:00:00.000Z",
		);
	});

	it("honours Retry-After on a 429", () => {
		const now = new Date("2026-11-09T04:30:00Z");
		expect(failureUntil(429, 12, now).toISOString()).toBe("2026-11-09T04:30:12.000Z");
		expect(failureUntil(429, undefined, now).toISOString()).toBe("2026-11-09T04:31:00.000Z");
	});
});

describe("pool state", () => {
	it("prefers the primary and falls back while it is refused", () => {
		const box = sandbox();
		const pool = new KeyPool(box);
		expect(pool.candidates().map((key) => key.label)).toEqual(["venice", "key2"]);

		pool.markFailure("venice", 402, undefined);
		expect(pool.candidates().map((key) => key.label)).toEqual(["key2"]);

		const stored = JSON.parse(readFileSync(box.stateFile, "utf8"));
		expect(stored.failures.venice.status).toBe(402);

		pool.markSuccess("key2");
		pool.markSuccess("venice");
		expect(pool.candidates().map((key) => key.label)).toEqual(["venice", "key2"]);
	});

	it("expires a refusal once its window passes", () => {
		const box = sandbox();
		const pool = new KeyPool(box);
		writeFileSync(
			box.stateFile,
			JSON.stringify({ failures: { venice: { until: "2026-11-09T00:00:00.000Z", status: 402 } } }),
		);
		const now = new Date("2026-11-09T00:00:01Z");
		expect(pool.candidates(now).map((key) => key.label)).toEqual(["venice", "key2"]);
	});

	it("ignores a key repeated in two slots", () => {
		const box = sandbox();
		writeFileSync(join(box.keyDir, "dup"), "primary-key");
		expect(new KeyPool(box).keys().map((key) => key.label)).toEqual(["venice", "key2"]);
	});

	it("describes the pool for /venice-keys", () => {
		const box = sandbox();
		const pool = new KeyPool(box);
		pool.markFailure("venice", 402, undefined);
		const lines = formatPoolStatus(pool);
		expect(lines[0]).toContain("venice: primary");
		expect(lines[0]).toContain("refused (HTTP 402) until");
		expect(lines[1]).toContain("key2: backup · in use · available");
	});
});

describe("request failover", () => {
	const url = "https://api.venice.ai/api/v1/chat/completions";
	const ok = () => new Response("stream", { status: 200 });
	const refused = () => new Response("{}", { status: 402 });

	it("replays the same request with the next key and returns only the success", async () => {
		const box = sandbox();
		const pool = new KeyPool(box);
		const seen: Array<string | null> = [];
		const inner = vi.fn(async (_url: string, init?: RequestInit) => {
			const auth = (init?.headers as Headers).get("authorization");
			seen.push(auth);
			return seen.length === 1 ? refused() : ok();
		});

		const response = await createVeniceFetch(
			pool,
			inner as unknown as typeof fetch,
			() => new Date(),
		)(url, {
			method: "POST",
			body: JSON.stringify({ model: "x" }),
			headers: { "content-type": "application/json", authorization: "Bearer stale" },
		});

		expect(response.status).toBe(200);
		expect(seen).toEqual(["Bearer primary-key", "Bearer backup-key"]);
		// The successful key is trusted, the refused one sits out until the reset.
		expect(pool.candidates().map((key) => key.label)).toEqual(["key2"]);
	});

	it("leaves unrelated hosts and non-key errors alone", async () => {
		const pool = new KeyPool(sandbox());
		const inner = vi.fn(async (_url: string) => new Response("{}", { status: 402 }));

		expect(
			(await createVeniceFetch(pool, inner as unknown as typeof fetch)("https://example.com/x"))
				.status,
		).toBe(402);
		expect(inner).toHaveBeenCalledTimes(1);

		inner.mockClear();
		inner.mockImplementation(async () => new Response("{}", { status: 400 }));
		const bad = await createVeniceFetch(pool, inner as unknown as typeof fetch)(url, {
			method: "POST",
			body: "{}",
		});
		expect(bad.status).toBe(400);
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("keeps the caller's own key when a request asks to be solo", async () => {
		const pool = new KeyPool(sandbox());
		const seen: Array<string | null> = [];
		const inner = vi.fn(async (_url: string, init?: RequestInit) => {
			seen.push((init?.headers as Headers).get("authorization"));
			return new Response("{}", { status: 200 });
		});

		await createVeniceFetch(pool, inner as unknown as typeof fetch)(
			"https://api.venice.ai/api/v1/api_keys/rate_limits",
			{ headers: { authorization: "Bearer probe-key", "x-acb-venice-solo": "1" } },
		);

		expect(seen).toEqual(["Bearer probe-key"]);
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it.each(["URLSearchParams", "FormData"])(
		"passes a non-replayable %s body through unchanged for one attempt",
		async (kind) => {
			const pool = new KeyPool(sandbox());
			const candidates = vi.spyOn(pool, "candidates");
			const body =
				kind === "URLSearchParams"
					? new URLSearchParams({ message: "preserve-me" })
					: new FormData();
			if (body instanceof FormData) body.append("message", "preserve-me");
			const inner = vi.fn(async (_url: string, init?: RequestInit) => {
				expect(init?.body).toBe(body);
				expect(init?.cache).toBe("no-store");
				return ok();
			});

			const response = await createVeniceFetch(pool, inner as unknown as typeof fetch)(url, {
				method: "POST",
				body,
				cache: "no-store",
			});

			expect(response.status).toBe(200);
			expect(inner).toHaveBeenCalledTimes(1);
			expect(candidates).not.toHaveBeenCalled();
		},
	);

	it("returns the refusal when every key is out", async () => {
		const box = sandbox();
		const pool = new KeyPool(box);
		const inner = vi.fn(async () => refused());
		const response = await createVeniceFetch(pool, inner as unknown as typeof fetch)(url, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(402);
		expect(inner).toHaveBeenCalledTimes(2);
	});
});

describe("balance formatting", () => {
	it("treats DIEM or bundled credits as usable despite a spent USD balance", () => {
		const { text, ok } = formatBalance("venice", {
			accessPermitted: true,
			apiTier: { id: "paid" },
			balances: { USD: -0.00205443, DIEM: 1.4, BUNDLED_CREDITS: 1 },
			nextEpochBegins: "2026-11-10T00:00:00.000Z",
		});
		expect(ok).toBe(true);
		expect(text).toContain("USD -0.002054");
		expect(text).toContain("usable · paid · resets");
	});

	it("reports an empty key as exhausted", () => {
		const { text, ok } = formatBalance("key2", {
			accessPermitted: true,
			balances: { USD: 0, DIEM: 0, BUNDLED_CREDITS: 0 },
		});
		expect(ok).toBe(false);
		expect(text).toContain("exhausted");
	});
});
