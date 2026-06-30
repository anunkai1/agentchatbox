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
	// Reset the pins sidecar override so tests don't bleed into each other.
	delete process.env.AGENTCHATBOX_PINS_FILE;
});

function writeSession(
	cwdDir: string,
	name: string,
	id: string,
	timestamp: string,
	userTexts: string[],
	/** Optional extra lines to append (e.g. session_info for a rename). */
	extraLines: string[] = [],
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
	for (const extra of extraLines) lines.push(extra);
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

	it("uses a user-set session name (session_info line) over the first-message title", async () => {
		writeSession(
			"--home-test-project--",
			"2026-06-15T10-00-00_aaa.jsonl",
			"aaa",
			"2026-06-15T10:00:00.000Z",
			["first prompt"],
			// pi writes this line on set_session_name
			[JSON.stringify({ type: "session_info", id: "aaa", name: "my feature work" })],
		);
		const { listPiSessions } = await import("../src/server/session-list.js");
		const sessions = listPiSessions(cwd);
		expect(sessions[0].title).toBe("my feature work");
	});

	it("lets the last session_info line win (a rename overrides the prior name)", async () => {
		writeSession(
			"--home-test-project--",
			"2026-06-15T10-00-00_aaa.jsonl",
			"aaa",
			"2026-06-15T10:00:00.000Z",
			["first prompt"],
			[
				JSON.stringify({ type: "session_info", id: "aaa", name: "old name" }),
				JSON.stringify({ type: "session_info", id: "aaa", name: "new name" }),
			],
		);
		const { listPiSessions } = await import("../src/server/session-list.js");
		const sessions = listPiSessions(cwd);
		expect(sessions[0].title).toBe("new name");
	});

	it("falls back to the first-message title when session_info name is cleared", async () => {
		writeSession(
			"--home-test-project--",
			"2026-06-15T10-00-00_aaa.jsonl",
			"aaa",
			"2026-06-15T10:00:00.000Z",
			["first prompt"],
			[
				JSON.stringify({ type: "session_info", id: "aaa", name: "temp" }),
				// Empty string clears the name (matches pi's set_session_name).
				JSON.stringify({ type: "session_info", id: "aaa", name: "" }),
			],
		);
		const { listPiSessions } = await import("../src/server/session-list.js");
		const sessions = listPiSessions(cwd);
		expect(sessions[0].title).toBe("first prompt");
	});

	it("marks sessions pinned according to the pins sidecar", async () => {
		writeSession(
			"--home-test-project--",
			"2026-06-15T10-00-00_aaa.jsonl",
			"aaa",
			"2026-06-15T10:00:00.000Z",
			["a"],
		);
		writeSession(
			"--home-test-project--",
			"2026-06-15T11-00-00_bbb.jsonl",
			"bbb",
			"2026-06-15T11:00:00.000Z",
			["b"],
		);
		// Point the pins sidecar at a temp file and pin only "aaa".
		const pinsFile = join(root!, "pins.json");
		process.env.AGENTCHATBOX_PINS_FILE = pinsFile;
		const { setPinned } = await import("../src/server/session-pins.js");
		setPinned("aaa", true);

		const { listPiSessions } = await import("../src/server/session-list.js");
		const sessions = listPiSessions(cwd);
		const aaa = sessions.find((s) => s.id === "aaa");
		const bbb = sessions.find((s) => s.id === "bbb");
		expect(aaa?.pinned).toBe(true);
		expect(bbb?.pinned).toBeUndefined();
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

describe("setPiSessionName", () => {
	it("appends a session_info line so listPiSessions picks up the new name", async () => {
		writeSession(
			"--home-test-project--",
			"2026-06-15T10-00-00_aaa.jsonl",
			"aaa",
			"2026-06-15T10:00:00.000Z",
			["first prompt"],
		);
		const { listPiSessions, setPiSessionName } = await import(
			"../src/server/session-list.js"
		);
		// Before: title is the first user message.
		expect(listPiSessions(cwd)[0].title).toBe("first prompt");

		expect(setPiSessionName(cwd, "aaa", "renamed from sidebar")).toBe(true);

		// After: the appended session_info line wins as the title.
		expect(listPiSessions(cwd)[0].title).toBe("renamed from sidebar");
	});

	it("returns false for an unknown session id (no file to append to)", async () => {
		const { setPiSessionName } = await import("../src/server/session-list.js");
		expect(setPiSessionName(cwd, "does-not-exist", "x")).toBe(false);
	});
});
