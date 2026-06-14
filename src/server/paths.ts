/**
 * Resolve filesystem paths relative to the project root, not the current
 * working directory.
 *
 * The server may be started from any directory (e.g. systemd with no
 * `WorkingDirectory=` set, or a supervisor that drops you in `/`).
 * Hardcoding `process.cwd()` in path resolution means helpers like
 * `scripts/transcribe.py` silently fail in those environments.
 *
 * The fix: derive the project root from the location of this file. The
 * compiled output lives at `<project>/dist/server/paths.js`, so the
 * project root is two parents up at runtime. During `tsx` dev, the source
 * is at `<project>/src/server/paths.ts` — also two parents up. The same
 * `..` works for both.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the project root. Available even when the process
 * working directory is somewhere else (systemd, container init, etc.).
 */
export const projectRoot = resolve(here, "..", "..");
