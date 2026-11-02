import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishInternalEndpoint } from "../src/server/internal-endpoint.js";

describe("private internal transport discovery", () => {
	it("publishes privately and replaces the boot token without invalidating port identity", () => {
		const home = mkdtempSync(join(tmpdir(), "acb-endpoint-"));
		try {
			const dir = join(home, ".config/acb/internal");
			const file = join(dir, "3500.json");
			publishInternalEndpoint(3500, "first-boot", home);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			publishInternalEndpoint(3500, "next-boot", home);
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
				url: "http://127.0.0.1:3500",
				token: "next-boot",
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
