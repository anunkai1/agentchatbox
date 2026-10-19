/**
 * /api/internal — session transport for pi extensions running inside this
 * server's own `pi` children (the delegate extension). Two primitives:
 *
 *   POST /api/internal/sessions            start a chat in a folder
 *   POST /api/internal/sessions/:id/prompt send a message to a chat,
 *                                          resuming it if no child is live
 *
 * The registry stays the single owner of every child, so a chat started
 * here is the same one the sidebar opens; nothing spawns a duplicate. Which
 * chats to start and what to say belongs to the extension.
 *
 * Every pi child gets a per-boot bearer token in its environment
 * (pi-process.ts). Requests without it get a 404, whichever way they arrive.
 */

import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type NextFunction, type Request, type Response, Router } from "express";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/thinking.js";
import { asyncHandler } from "./async-handler.js";
import { broadcastSessions } from "./chat.js";
import { config } from "./config.js";
import { listProjects } from "./projects.js";
import { findSessionCwd } from "./session-list.js";
import { type LiveSession, registry } from "./session-registry.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MESSAGE_CHARS = 200_000;

class BadRequest extends Error {}

function requireToken(req: Request, res: Response, next: NextFunction): void {
	const header = req.get("authorization") ?? "";
	const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
	const expected = Buffer.from(config.internalToken);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		res.status(404).end();
		return;
	}
	next();
}

function text(value: unknown, field: string, max = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new BadRequest(`${field} is required`);
	}
	return value;
}

function modelFields(body: Record<string, unknown>) {
	const thinkingLevel = body.thinkingLevel ?? "medium";
	if (!THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) {
		throw new BadRequest("thinkingLevel is invalid");
	}
	return {
		provider: text(body.provider, "provider"),
		modelId: text(body.modelId, "modelId"),
		thinkingLevel: thinkingLevel as ThinkingLevel,
	};
}

/** Send a prompt once pi is ready. A busy chat queues it as a follow-up. */
async function prompt(session: LiveSession, message: string): Promise<void> {
	await registry.waitUntilReady(session);
	session.pi.send({
		type: "prompt",
		message,
		...(session.streaming || session.busy ? { streamingBehavior: "followUp" } : {}),
	});
	registry.releaseUnattached(session);
}

export function createInternalSessionsRouter(): Router {
	const router = Router();
	router.use(requireToken);

	router.post(
		"/sessions",
		asyncHandler(async (req, res) => {
			const body = (req.body ?? {}) as Record<string, unknown>;
			const cwd = text(body.cwd, "cwd", 4096);
			if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
				throw new BadRequest("cwd must be an existing absolute folder");
			}
			const session = registry.acquire({ ...modelFields(body), cwd: resolve(cwd) });
			try {
				await registry.waitUntilReady(session);
			} catch (error) {
				registry.kill(session);
				throw error;
			}
			registry.releaseUnattached(session);
			broadcastSessions();
			res.json({ sessionId: session.sessionId });
		}),
	);

	router.post(
		"/sessions/:id/prompt",
		asyncHandler(async (req, res) => {
			const id = req.params.id;
			if (!ID_RE.test(id)) throw new BadRequest("invalid session id");
			const body = (req.body ?? {}) as Record<string, unknown>;
			const message = text(body.message, "message", MAX_MESSAGE_CHARS);
			let session = registry.liveFor(id);
			if (!session) {
				const cwd = findSessionCwd(
					id,
					listProjects().map((p) => p.cwd),
				);
				if (!cwd) {
					res.status(404).json({ error: "session not found" });
					return;
				}
				session = registry.acquire({ ...modelFields(body), sessionId: id, cwd });
			}
			await prompt(session, message);
			res.json({ ok: true });
		}),
	);

	// Callers are our own extensions, so they get the real reason (for
	// example the live session limit) to pass on to the owner.
	router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
		const message = error instanceof Error ? error.message : String(error);
		res.status(error instanceof BadRequest ? 400 : 503).json({ error: message });
	});
	return router;
}
