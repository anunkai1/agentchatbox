/**
 * session-list.ts — verify the `pi` JSONL parser.
 *
 * `pi` stores sessions as JSONL files under
 *   `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl`
 * We point PI_CODING_AGENT_SESSION_DIR at a temp dir, write a few
 * fake JSONL files, and check the parser extracts the right
 * summaries and reads back the right messages.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string | null = null;
let cwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
	// We pretend the sessions belong to /home/test/project.
	cwd = "/home/test/project";
	mkdirSync(join(root, "--home-test-project--"), { recursive: true });
	mkdirSync(join(root, "--home-other-project--"), { recursive: true });
	process.env.PI_CODING_AGENT_SESSION_DIR = root;
});

afterEach(() => {
	if (root) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		root = null;
	}
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
});

function writeSession(
	cwdDir: string,
	name: string,
	id: string,
	timestamp: string,
	userTexts: string[],
): void {
	const lines: string[] = [JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })];
	for (const text of userTexts) {
		// We add both the user and assistant message so messageCount
		// counts user+assistant. (Real pi JSONL includes tool results
		// too; we keep the fake small.)
		lines.push(
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text }],
					timestamp: 1,
				},
			}),
		);
		lines.push(
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					timestamp: 2,
				},
			}),
		);
	}
	writeFileSync(join(root!, cwdDir, name), `${lines.join("\n")}\n`);
}

describe("listPiSessions", () => {
	it("returns an empty array when the cwd directory does not exist", async () => {
		// Fresh root, no --<cwd>-- subdir at all.
		rmSync(join(root!, "--home-test-project--"), {
			recursive: true,
			force: true,
		});
		const { listPiSessions } = await import("../src/server/session-list.js");
		expect(listPiSessions(cwd)).toEqual([]);
	});

	it("returns sessions newest-first and ignores other-cwd files", async () => {
		writeSession(
			"--home-test-project--",
			"2026-06-15T10-00-00_aaa.jsonl",
			"aaa",
			"2026-06-15T10:00:00.000Z",
			["first prompt"],
		);
		writeSession(
			"--home-test-project--",
			"2026-06-15T12-00-00_ccc.jsonl",
			"ccc",
			"2026-06-15T12:00:00.000Z",
			["third prompt"],
		);
		writeSession(
			"--home-test-project--",
			"2026-06-15T11-00-00_bbb.jsonl",
			"bbb",
			"2026-06-15T11:00:00.000Z",
			["second prompt"],
		);
		// Other-cwd file — must be filtered out by the cwd check.
		writeSession(
			"--home-other-project--",
			"2026-06-15T13-00-00_other.jsonl",
			"other",
			"2026-06-15T13:00:00.000Z",
			["other cwd prompt"],
		);

		const { listPiSessions } = await import("../src/server/session-list.js");
		const sessions = listPiSessions(cwd);
		expect(sessions.map((s) => s.id)).toEqual(["ccc", "bbb", "aaa"]);
		// The other-cwd session should be filtered out, leaving 3.
		expect(sessions).toHaveLength(3);
		// Title is the first user text.
		expect(sessions[0].title).toBe("third prompt");
		// messageCount counts both user and assistant messages.
		expect(sessions[0].messageCount).toBe(2);
	});

	it("truncates long titles to 60 chars with an ellipsis", async () => {
		const longText = "x".repeat(100);
		writeSession(
			"--home-test-project--",
			"2026-06-15T10-00-00_zzz.jsonl",
			"zzz",
			"2026-06-15T10:00:00.000Z",
			[longText],
		);
		const { listPiSessions } = await import("../src/server/session-list.js");
		const sessions = listPiSessions(cwd);
		expect(sessions[0].title.length).toBeLessThanOrEqual(60);
		expect(sessions[0].title.endsWith("…")).toBe(true);
	});
});

describe("readPiSessionMessages", () => {
	it("returns an empty array for an unknown session id", async () => {
		const { readPiSessionMessages } = await import("../src/server/session-list.js");
		expect(readPiSessionMessages(cwd, "does-not-exist")).toEqual([]);
	});

	it("returns the message objects in order, skipping non-message entries", async () => {
		writeSession(
			"--home-test-project--",
			"2026-06-15T10-00-00_aaa.jsonl",
			"aaa",
			"2026-06-15T10:00:00.000Z",
			["hi", "follow up"],
		);
		const { readPiSessionMessages } = await import("../src/server/session-list.js");
		const msgs = readPiSessionMessages(cwd, "aaa");
		// 2 user + 2 assistant = 4 messages.
		expect(msgs).toHaveLength(4);
		expect((msgs[0] as { role: string }).role).toBe("user");
		expect((msgs[2] as { role: string }).role).toBe("user");
		// The first user message text is preserved.
		expect((msgs[0] as { content: Array<{ text: string }> }).content[0].text).toBe("hi");
		expect((msgs[2] as { content: Array<{ text: string }> }).content[0].text).toBe("follow up");
	});
});
