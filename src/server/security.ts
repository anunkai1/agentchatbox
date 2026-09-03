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

/**
 * Market-data hosts reachable from pages under /experiments/. The app CSP
 * keeps connect-src 'self' for everything else; experiments are self-contained
 * static pages that fetch public crypto APIs directly from the browser.
 */
const EXPERIMENT_CONNECT_SRC = [
	"https://fapi.binance.com",
	"https://api.binance.com",
	"https://api.hyperliquid.xyz",
	"wss://fstream.binance.com",
	"wss://api.hyperliquid.xyz",
	"wss://stream.binance.com",
];

export function experimentSecurityHeaders(req: Request, res: Response, next: NextFunction): void {
	if (req.path === "/experiments" || req.path.startsWith("/experiments/")) {
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
				`connect-src 'self' ${EXPERIMENT_CONNECT_SRC.join(" ")}`,
				"font-src 'self'",
			].join("; "),
		);
	}
	next();
}
