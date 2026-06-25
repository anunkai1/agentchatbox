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

function line(level: string, msg: string, fields?: Fields): string {
	const obj: Fields = {
		ts: new Date().toISOString(),
		level,
		msg,
	};
	if (fields) Object.assign(obj, fields);
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
