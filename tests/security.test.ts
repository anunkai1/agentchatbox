import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/server/config.js";
import { isAllowedWsOrigin, securityHeaders } from "../src/server/security.js";
import { createUploadsServingRouter, safeInlineMime } from "../src/server/uploads-serving.js";

const originalUploadsDir = config.uploadsDir;
let server: Server | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
	config.uploadsDir = originalUploadsDir;
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = null;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HTTP and upload security", () => {
	it("sets browser hardening headers without CORS", async () => {
		const app = express();
		app.disable("x-powered-by");
		app.use(securityHeaders);
		app.get("/", (_req, res) => res.json({ ok: true }));
		server = createServer(app);
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing test address");
		const response = await fetch(`http://127.0.0.1:${address.port}/`);
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(response.headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
		expect(response.headers.get("content-security-policy")).not.toContain("'unsafe-eval'");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-powered-by")).toBeNull();
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("uses an exact WebSocket Origin allowlist", () => {
		const allowed = [...config.allowedOrigins][0];
		expect(allowed).toBeTruthy();
		expect(isAllowedWsOrigin(allowed)).toBe(true);
		expect(isAllowedWsOrigin("https://example.com")).toBe(false);
	});

	it("inlines only magic-matching raster images and (sandboxed) SVG", () => {
		expect(safeInlineMime("safe.png", Buffer.from("89504e470d0a1a0a", "hex"))).toBe("image/png");
		expect(safeInlineMime("logo.SVG", Buffer.from("<svg>"))).toBe("image/svg+xml");
		expect(safeInlineMime("attack.html", Buffer.from("<script>alert(1)"))).toBeNull();
		expect(safeInlineMime("fake.png", Buffer.from("<script>alert(1)"))).toBeNull();
	});

	it("serves uploaded SVGs inline under sandbox CSP and forces HTML downloads", async () => {
		const uploadsDir = mkdtempSync(join(tmpdir(), "acb-uploads-sec-"));
		tempDirs.push(uploadsDir);
		writeFileSync(
			join(uploadsDir, "badge.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		);
		writeFileSync(join(uploadsDir, "attack.html"), "<script>alert(1)</script>");
		config.uploadsDir = uploadsDir;

		const app = express();
		app.use("/uploads", createUploadsServingRouter());
		server = createServer(app);
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing test address");
		const baseUrl = `http://127.0.0.1:${address.port}/uploads`;

		const svgRes = await fetch(`${baseUrl}/badge.svg`);
		expect(svgRes.status).toBe(200);
		expect(svgRes.headers.get("content-type")).toMatch(/^image\/svg\+xml\b/);
		expect(svgRes.headers.get("content-disposition")).toBe("inline");
		expect(svgRes.headers.get("content-security-policy")).toContain("sandbox");
		expect(svgRes.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");

		const htmlRes = await fetch(`${baseUrl}/attack.html`);
		expect(htmlRes.status).toBe(200);
		expect(htmlRes.headers.get("content-type")).toBe("application/octet-stream");
		expect(htmlRes.headers.get("content-disposition")).toBe('attachment; filename="attack.html"');
		expect(htmlRes.headers.get("content-security-policy")).toContain("sandbox");
		expect(htmlRes.headers.get("x-content-type-options")).toBe("nosniff");
	});
});
