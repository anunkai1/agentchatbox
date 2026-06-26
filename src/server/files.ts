/**
 * File download route: GET /api/file?path=<absolute path>
 *
 * Serves any file that lives inside the agent's project directory
 * (`config.piCwd`). This is what lets the browser download files the
 * agent created or edited — when a tool call carries a `path` arg
 * (write / edit / read), the renderer turns it into a download link
 * pointing here.
 *
 * This is transport-layer only: it resolves the path, checks that it
 * is contained within piCwd (so a stray `../../../etc/passwd` is
 * refused), and streams the bytes. No agent logic, no business rules.
 *
 * We deliberately allow ANY file under piCwd (not just files the agent
 * touched) because the server is stateless about which paths the agent
 * has written — the renderer only links paths it saw in tool calls, so
 * in practice the user only ever sees links to files pi actually used.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import { config } from "./config.js";

/** Resolve `root` once at router construction. */
const ROOT = resolve(config.piCwd);

/**
 * True iff `target` is `root` itself or lives somewhere beneath it.
 * Uses `path.relative` rather than a string prefix so trailing slashes
 * and `..` segments can't trick the containment check
 * (e.g. `/home/foo/project-evil` would wrongly match a `/home/foo/project`
 * string prefix).
 */
function isWithinRoot(target: string): boolean {
	const rel = relative(ROOT, target);
	return rel === "" || !rel.startsWith("..");
}

export function createFilesRouter(): Router {
	const router = express.Router();

	router.get("/", async (req: Request, res: Response) => {
		const raw = typeof req.query.path === "string" ? req.query.path : "";
		if (!raw) {
			res.status(400).json({ error: "missing ?path=<absolute path>" });
			return;
		}

		// Resolve against the project root so a relative path like
		// "src/foo.ts" still works, then verify containment. `resolve`
		// collapses `..` segments before the containment check, which is
		// what makes the check safe.
		const target = resolve(ROOT, raw);
		if (!isWithinRoot(target)) {
			res.status(403).json({
				error: "path is outside the agent project directory",
			});
			return;
		}

		let s: Awaited<ReturnType<typeof stat>>;
		try {
			s = await stat(target);
		} catch {
			res.status(404).json({ error: "file not found" });
			return;
		}
		if (!s.isFile()) {
			res.status(400).json({ error: "path is not a regular file" });
			return;
		}

		let data: Buffer;
		try {
			data = await readFile(target);
		} catch (e) {
			res.status(500).json({
				error: `failed to read file: ${e instanceof Error ? e.message : String(e)}`,
			});
			return;
		}

		// Force a download (attachment) with the basename as the
		// suggested filename. `encodeURIComponent` keeps unicode names
		// intact across browsers; RFC 5987 `filename*` is the
		// broadly-supported way to encode non-ASCII filenames.
		const name = basename(target);
		res.setHeader(
			"Content-Disposition",
			`attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		);
		// Let the browser sniff a sane content type from the bytes /
		// extension; we don't ship a mime DB on purpose.
		res.setHeader("Content-Type", "application/octet-stream");
		res.setHeader("Content-Length", String(s.size));
		res.send(data);
	});

	return router;
}
