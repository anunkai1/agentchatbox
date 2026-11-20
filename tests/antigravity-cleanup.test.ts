import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanAntigravityArtifacts } from "../src/server/antigravity-cleanup.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "acb-agy-cleanup-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("cleanAntigravityArtifacts", () => {
	const now = Date.parse("2026-11-20T05:00:00Z");
	const day = 86_400_000;

	it("removes old brain/conversations UUID groups while keeping active WAL and non-UUID files", () => {
		const root = makeTempDir();
		const acpHome = join(root, "acp");
		const brain = join(acpHome, "brain");
		const conv = join(acpHome, "conversations");
		mkdirSync(brain, { recursive: true });
		mkdirSync(conv, { recursive: true });

		const oldId = "11111111-1111-4111-8111-111111111111";
		const activeId = "22222222-2222-4222-8222-222222222222";

		// Old session: both brain and conversations older than 14 days.
		mkdirSync(join(brain, oldId), { recursive: true });
		writeFileSync(join(brain, oldId, "note.md"), "old");
		writeFileSync(join(conv, `${oldId}.db`), "123456");
		writeFileSync(join(conv, `${oldId}.meta`), "meta");
		const oldSec = (now - 16 * day) / 1000;
		utimesSync(join(brain, oldId, "note.md"), oldSec, oldSec);
		utimesSync(join(brain, oldId), oldSec, oldSec);
		utimesSync(join(conv, `${oldId}.db`), oldSec, oldSec);
		utimesSync(join(conv, `${oldId}.meta`), oldSec, oldSec);

		// Active session: .db is old, but .db-wal is recent -> entire group kept!
		mkdirSync(join(brain, activeId), { recursive: true });
		writeFileSync(join(brain, activeId, "active.md"), "active");
		writeFileSync(join(conv, `${activeId}.db`), "db");
		writeFileSync(join(conv, `${activeId}.db-wal`), "wal");
		const recentSec = (now - 1 * day) / 1000;
		utimesSync(join(brain, activeId, "active.md"), oldSec, oldSec);
		utimesSync(join(brain, activeId), oldSec, oldSec);
		utimesSync(join(conv, `${activeId}.db`), oldSec, oldSec);
		utimesSync(join(conv, `${activeId}.db-wal`), recentSec, recentSec);

		// Unrelated file must never be removed.
		writeFileSync(join(conv, "notes.txt"), "keep");
		utimesSync(join(conv, "notes.txt"), oldSec, oldSec);

		const res = cleanAntigravityArtifacts({
			acpHomeDir: acpHome,
			tmpDir: join(root, "missing-tmp"),
			nowMs: now,
		});

		expect(res.removedSessions).toBe(1);
		expect(res.freedBytes).toBeGreaterThan(0);
		expect(existsSync(join(brain, oldId))).toBe(false);
		expect(existsSync(join(conv, `${oldId}.db`))).toBe(false);
		expect(existsSync(join(conv, `${oldId}.meta`))).toBe(false);
		expect(existsSync(join(brain, activeId))).toBe(true);
		expect(existsSync(join(conv, `${activeId}.db`))).toBe(true);
		expect(existsSync(join(conv, `${activeId}.db-wal`))).toBe(true);
		expect(existsSync(join(conv, "notes.txt"))).toBe(true);
	});

	it("prunes old INFO/ERROR logs at 2d and WARNING logs after 9d while protecting active symlinks", () => {
		const root = makeTempDir();
		const tmp = join(root, "tmp");
		mkdirSync(tmp, { recursive: true });

		const activeInfo = "agy_acp_server.par.host.u.log.INFO.20261101-000000.1";
		const oldInfo = "agy_acp_server.par.host.u.log.INFO.20261116-000000.2";
		const recentWarn = "agy_acp_server.par.host.u.log.WARNING.20261113-000000.3";
		const oldWarn = "agy_acp_server.par.host.u.log.WARNING.20261105-000000.4";
		const oldError = "agy_acp_server.par.host.u.log.ERROR.20261116-000000.5";

		for (const name of [activeInfo, oldInfo, recentWarn, oldWarn, oldError]) {
			writeFileSync(join(tmp, name), "logdata");
		}
		symlinkSync(activeInfo, join(tmp, "agy_acp_server.par.INFO"));

		const setAgeDays = (name: string, days: number) => {
			const s = (now - days * day) / 1000;
			utimesSync(join(tmp, name), s, s);
		};
		setAgeDays(activeInfo, 12); // old mtime, but active symlink target -> keep!
		setAgeDays(oldInfo, 3);
		setAgeDays(recentWarn, 7); // inside 8d /gemini-usage window -> keep!
		setAgeDays(oldWarn, 10);
		setAgeDays(oldError, 3);

		const res = cleanAntigravityArtifacts({
			acpHomeDir: join(root, "missing-acp"),
			tmpDir: tmp,
			nowMs: now,
		});

		expect(res.removedTmpLogs).toBe(3);
		expect(existsSync(join(tmp, activeInfo))).toBe(true);
		expect(existsSync(join(tmp, recentWarn))).toBe(true);
		expect(existsSync(join(tmp, oldInfo))).toBe(false);
		expect(existsSync(join(tmp, oldWarn))).toBe(false);
		expect(existsSync(join(tmp, oldError))).toBe(false);
	});
});
