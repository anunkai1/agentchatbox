#!/usr/bin/env node
/** Read-only upload storage report. Never deletes files. */
import "dotenv/config";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.env.UPLOADS_DIR || new URL("../uploads", import.meta.url).pathname);
const ageArg = process.argv.find((arg) => arg.startsWith("--older-than-days="));
const olderThanDays = ageArg ? Number(ageArg.split("=", 2)[1]) : 90;
if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
	throw new Error("--older-than-days must be a non-negative number");
}
const cutoff = Date.now() - olderThanDays * 86_400_000;
const files = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
	if (!entry.isFile()) continue;
	const stat = statSync(resolve(root, entry.name));
	files.push({
		name: entry.name,
		bytes: stat.size,
		modified: stat.mtime.toISOString(),
		old: stat.mtimeMs < cutoff,
	});
}
files.sort((a, b) => b.bytes - a.bytes);
const total = files.reduce((sum, file) => sum + file.bytes, 0);
const old = files.filter((file) => file.old);
const oldBytes = old.reduce((sum, file) => sum + file.bytes, 0);
console.log(
	JSON.stringify(
		{
			root,
			files: files.length,
			bytes: total,
			olderThanDays,
			oldFiles: old.length,
			oldBytes,
			largest: files.slice(0, 25),
		},
		null,
		2,
	),
);
