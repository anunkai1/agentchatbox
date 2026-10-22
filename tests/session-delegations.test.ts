import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionDelegation } from "../src/server/session-delegations.js";
import { listPiSessions, sessionsDirFor } from "../src/server/session-list.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "acb-sidebar-delegations-"));
	vi.stubEnv("ACB_DELEGATIONS_DIR", dir);
	vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(dir, "sessions"));
	vi.stubEnv("AGENTCHATBOX_SESSION_CACHE_FILE", join(dir, "cache.json"));
	vi.stubEnv("AGENTCHATBOX_PINS_FILE", join(dir, "pins.json"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});
const record = (extra = {}) =>
	writeFileSync(
		join(dir, "worker.json"),
		JSON.stringify({
			id: "worker",
			parentSessionId: "parent",
			status: "working",
			task: "private brief not exposed",
			...extra,
		}),
	);

describe("delegation sidebar projection", () => {
	it("reads existing relationships and refreshes changed or deleted records", () => {
		record();
		expect(sessionDelegation("worker")).toEqual({ parentSessionId: "parent", status: "working" });
		record({ status: "needs_input" });
		expect(sessionDelegation("worker")?.status).toBe("needs_input");
		rmSync(join(dir, "worker.json"));
		expect(sessionDelegation("worker")).toBeNull();
	});
	it("ignores malformed records and traversal IDs", () => {
		record({ id: "different-worker" });
		expect(sessionDelegation("worker")).toBeNull();
		expect(sessionDelegation("../worker")).toBeNull();
		writeFileSync(join(dir, "worker.json"), "not json");
		expect(sessionDelegation("worker")).toBeNull();
	});
	it("enriches old and cached transcripts without rewriting cwd, title or files", () => {
		const cwd = "/repo/worker";
		const path = sessionsDirFor(cwd);
		mkdirSync(path, { recursive: true });
		const transcript = [
			{ type: "session", id: "worker", cwd, timestamp: "2026-01-01T00:00:00Z" },
			{ type: "custom", customType: "delegation", data: { status: "working" } },
			{ type: "session_info", name: "My renamed worker" },
		]
			.map((line) => JSON.stringify(line))
			.join("\n");
		const file = join(path, "worker.jsonl");
		writeFileSync(file, transcript);
		expect(listPiSessions(cwd)[0].delegation).toEqual({ status: "working" });
		record({ status: "done" });
		const summary = listPiSessions(cwd)[0];
		expect(summary.delegation).toEqual({ parentSessionId: "parent", status: "done" });
		expect(summary.cwd).toBe(cwd);
		expect(summary.title).toBe("My renamed worker");
		expect(readFileSync(file, "utf8")).toBe(transcript);
		expect(JSON.stringify(summary)).not.toContain("private brief");
		rmSync(join(dir, "worker.json"));
		expect(listPiSessions(cwd)[0].delegation).toEqual({ status: "working" });
	});
});
