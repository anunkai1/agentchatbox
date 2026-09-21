import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A page pins each asset it loads as `<file>?v=<hash>` so the asset URL changes
 * whenever the bytes do. The server keys its cache policy off that query string
 * and serves a stamped URL `immutable` for a year, so a browser that has
 * fetched `app.js?v=<old>` will never revalidate it. Re-stamping the page is
 * therefore the only way a change to a stamped asset reaches a returning
 * browser: ship new bytes under an unchanged stamp and every client keeps the
 * old file (the "it looks right on the desktop but my phone never updated"
 * bug). Assert every stamp on every tracked page matches the bytes on disk.
 */
const root = path.resolve(import.meta.dirname, "..");
const STAMP = /(?:src|href)="([^"]+?)\?v=([0-9a-f]{8,64})"/gi;

function trackedPages(): string[] {
	return execFileSync("git", ["ls-files", "public"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter((file) => file.endsWith("/index.html") || file === "public/index.html");
}

describe("content-hashed asset stamps", () => {
	it("points every stamped page at the current bytes", () => {
		const pages = trackedPages();
		expect(pages).toContain("public/experiments/candle-charts/index.html");
		const problems: string[] = [];
		let checked = 0;
		for (const page of pages) {
			const source = readFileSync(path.join(root, page), "utf8");
			for (const [, reference, stamp] of source.matchAll(STAMP)) {
				// Absolute-site references ("/app.js") resolve from the public root.
				const asset = reference.startsWith("/")
					? path.join(root, "public", reference)
					: path.join(root, path.dirname(page), reference);
				if (!statSync(asset, { throwIfNoEntry: false })) {
					problems.push(`${page}: ${reference} does not exist`);
					continue;
				}
				const digest = createHash("sha256").update(readFileSync(asset)).digest("hex");
				if (!digest.startsWith(stamp)) {
					problems.push(
						`${page}: ${reference}?v=${stamp} is stale, current stamp is ${digest.slice(0, stamp.length)}`,
					);
				}
				checked += 1;
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(problems).toEqual([]);
	});
});
