/**
 * Minimal structured logger.
 *
 * Emits one JSON object per line to stdout (info) / stderr (error), so
 * logs are machine-parseable by `jq` or any log shipper without pulling
 * in pino or winston as a runtime dependency. Every line carries:
 *
 *   { ts, level, msg, ...fields }
 *
 * `ts` is ISO-8601 UTC with milliseconds — sortable and unambiguous.
 *
 * Why not just console.log: the ad-hoc `console.log` calls scattered
 * through the server produce free-form strings that are hard to grep
 * reliably once the app grows. A single shaped logger keeps the
 * output uniform. If structured logging is ever needed at scale,
 * swap this file's bodies for `pino` — the call sites stay the same.
 */

type Fields = Record<string, unknown>;

export function redactSensitive(value: string): string {
	return value
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
		.replace(/\b(sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[REDACTED]")
		.replace(
			/(\b(?:api[_-]?key|token|secret|password|access|refresh)\b\s*[=:]\s*["']?)[^\s,"'}]+/gi,
			"$1[REDACTED]",
		)
		.slice(0, 16_384);
}

function sanitise(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return redactSensitive(value);
	if (depth >= 4 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitise(entry, depth + 1));
	const out: Fields = {};
	for (const [key, entry] of Object.entries(value as Fields).slice(0, 100)) {
		out[key] = /key|token|secret|password|authorization/i.test(key)
			? "[REDACTED]"
			: sanitise(entry, depth + 1);
	}
	return out;
}

function line(level: string, msg: string, fields?: Fields): string {
	const obj: Fields = {
		ts: new Date().toISOString(),
		level,
		msg: redactSensitive(msg),
	};
	if (fields) Object.assign(obj, sanitise(fields));
	return JSON.stringify(obj);
}

export const log = {
	info(msg: string, fields?: Fields): void {
		process.stdout.write(`${line("info", msg, fields)}\n`);
	},
	warn(msg: string, fields?: Fields): void {
		process.stderr.write(`${line("warn", msg, fields)}\n`);
	},
	error(msg: string, fields?: Fields): void {
		process.stderr.write(`${line("error", msg, fields)}\n`);
	},
};
