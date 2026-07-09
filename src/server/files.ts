/**
 * File download route: GET /api/file?path=<absolute path>
 *
 * Serves any regular file the agent can read — when a tool call carries
 * a `path` arg (write / edit / read), the renderer turns it into a
 * download link pointing here.
 *
 * This is transport-layer only: it resolves the path, verifies it is a
 * regular file, and streams the bytes. No agent logic, no business rules.
 *
 * Scope: ANY regular file on the host. This is consistent with the
 * threat model documented in §XIX of the server2 overview — agentchatbox
 * is "effectively a remote shell" behind Authelia MFA, and pi's own
 * `read`/`bash` tools already have full filesystem access and can print
 * any file's contents into the chat. Restricting this endpoint to
 * `config.piCwd` was stricter than the agent's actual capabilities, so
 * it only broke the UX (download links appeared for files the endpoint
 * then refused to serve) without adding any real security. We still
 * refuse non-regular files (directories, devices, sockets, FIFOs) so a
 * `path` pointing at `/dev/` or a mount point can't be streamed.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";

export function createFilesRouter(): Router {
	const router = express.Router();

	router.get("/", async (req: Request, res: Response) => {
		const raw = typeof req.query.path === "string" ? req.query.path : "";
		if (!raw) {
			res.status(400).json({ error: "missing ?path=<absolute path>" });
			return;
		}

		// `resolve` collapses `..` segments so a traversal like
		// "../../etc/passwd" still lands on a real absolute path; the
		// only remaining gate is that it must be a regular file.
		const target = resolve(raw);

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
		// Stream the file instead of buffering it. The agent routinely
		// touches multi-GB logs; loading one into a Buffer to `res.send()`
		// would spike memory and can OOM the server. Piping reads + sends
		// in chunks so peak memory stays flat regardless of file size.
		createReadStream(target)
			.on("error", (err: NodeJS.ErrnoException) => {
				if (!res.headersSent) {
					res.status(500).json({
						error: `failed to read file: ${err.message}`,
					});
				} else {
					// Headers already flushed (we're mid-stream) — just end.
					try {
						res.end();
					} catch {
						/* client may be gone */
					}
				}
			})
			.pipe(res);
	});

	return router;
}
