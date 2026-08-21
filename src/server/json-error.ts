/**
 * JSON error handler for the Express app.
 *
 * Mounted as the LAST middleware so it is the catch-all for any error
 * forwarded via `next(err)` by a route or middleware above (notably
 * multer's `LIMIT_FILE_SIZE` on oversized uploads and express.json's
 * parse failures on malformed bodies). Without it these fall through to
 * Express's built-in finalhandler, which returns an HTML error page —
 * inconsistent with the `{ error: string }` JSON every other path here
 * returns, and useless to the browser client that only parses JSON.
 *
 * Extracted into its own module so it can be unit-tested in isolation
 * (the app entry in index.ts otherwise can't be exercised without
 * booting the whole server). Returns the 4-arg error middleware.
 *
 * Status resolution order:
 *   1. an error-supplied numeric `status` (body-parser sets 400),
 *   2. multer's `LIMIT_*` codes → 413 (Payload Too Large),
 *   3. fallback 500.
 */

import type { NextFunction, Request, Response } from "express";
import { log } from "./logger.js";

/** Detect a multer payload-limit error by its `LIMIT_*` code. */
function isMulterLimit(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" && code.startsWith("LIMIT_");
}

/** Resolve the HTTP status for a forwarded error (see file header). */
export function statusForError(err: unknown): number {
	const maybeStatus = (err as { status?: unknown } | null)?.status;
	if (
		typeof maybeStatus === "number" &&
		Number.isInteger(maybeStatus) &&
		maybeStatus >= 400 &&
		maybeStatus <= 599
	) {
		return maybeStatus;
	}
	if (isMulterLimit(err)) return 413;
	return 500;
}

/** Human-readable message for a forwarded error. */
export function messageForError(err: unknown): string {
	return err instanceof Error
		? err.message
		: typeof err === "string"
			? err
			: "internal server error";
}

/** The Express error-handling middleware. */
export function jsonErrorHandler(
	err: unknown,
	_req: Request,
	res: Response,
	next: NextFunction,
): void {
	if (res.headersSent) {
		// Headers already flushed (e.g. mid-stream on /api/file or /api/tts);
		// hand off to Express's default so it can end the response.
		next(err);
		return;
	}
	const status = statusForError(err);
	const internalMessage = messageForError(err);
	const expose = status < 500 || (err as { expose?: unknown } | null)?.expose === true;
	if (status >= 500 && expose) {
		// Deliberate operational rejections such as aggregate quota exhaustion
		// are not unhandled server faults and should not trigger error alerts.
		log.info("route request rejected", { status, message: internalMessage });
	} else if (status >= 500) {
		log.error("unhandled route error", { message: internalMessage });
	}
	res.status(status).json({ error: expose ? internalMessage : "internal server error" });
}
