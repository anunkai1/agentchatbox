/**
 * Wrap an async Express route handler so a rejected promise (or any
 * thrown error) is forwarded to `next(err)` instead of becoming an
 * unhandled rejection.
 *
 * Why this exists: Express 4 does NOT auto-catch rejected promises in
 * async route handlers. Without this wrapper, a `throw` or `await`-ed
 * rejection inside a route leaves the response hanging forever AND, on
 * modern Node, surfaces as an `unhandledRejection` that can terminate
 * the whole process — taking every active chat session down with it.
 * systemd restarts, but orphaned `pi` children from prior sessions
 * survive holding file locks, so a crash can cascade.
 *
 * The forwarded error reaches the app-level JSON error handler mounted
 * last in index.ts (`jsonErrorHandler`), which turns it into a `{ error }`
 * JSON response with a sane status (or 500).
 *
 * Domain-specific try/catch inside a route (e.g. `stat` ENOENT → 404,
 * upstream `fetch` failure → 502) should stay — those encode correct
 * behavior. This wrapper is the backstop for anything unexpected.
 *
 * Type-only `import type` keeps the module runtime-dependency-free
 * (erased at compile time; no express require in the emitted JS).
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
	fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
	return (req, res, next) => {
		Promise.resolve(fn(req, res, next)).catch(next);
	};
}
