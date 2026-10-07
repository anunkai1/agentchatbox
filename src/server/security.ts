import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

/**
 * Security headers for every application response. Upload responses add a
 * stricter sandbox policy in uploads-serving.ts.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
	res.setHeader(
		"Content-Security-Policy",
		[
			"default-src 'self'",
			"base-uri 'none'",
			"frame-ancestors 'none'",
			"form-action 'self'",
			"object-src 'none'",
			"script-src 'self'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob: https:",
			"media-src 'self' blob:",
			"connect-src 'self'",
			"font-src 'self'",
		].join("; "),
	);
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
	res.setHeader("Strict-Transport-Security", "max-age=31536000");
	next();
}

/** Exact Origin allowlist used for the WebSocket upgrade. */
export function isAllowedWsOrigin(origin: string | undefined): boolean {
	if (!origin) return config.allowMissingWsOrigin;
	return config.allowedOrigins.has(origin);
}
