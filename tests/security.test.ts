import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/server/config.js";
import { isAllowedWsOrigin, securityHeaders } from "../src/server/security.js";
import { safeInlineMime } from "../src/server/uploads-serving.js";

let server: Server | null = null;
afterEach(() => {
	if (server) return new Promise<void>((resolve) => server!.close(() => resolve()));
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
});
