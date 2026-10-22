import { describe, expect, it } from "vitest";
import { buildSessionTree, visibleSessionRows } from "../src/client/session-tree.js";
import type { SessionSummary } from "../src/shared/protocol.js";

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	title: id,
	cwd: "/repo/parent",
	projectId: "global",
	createdAt: "2026-01-01T00:00:00Z",
	modifiedAt: "2026-01-01T00:00:00Z",
	messageCount: 2,
	...extra,
});
const worker = (id: string, parent: string, extra: Partial<SessionSummary> = {}) =>
	session(id, {
		cwd: "/repo/worker",
		projectId: "worker-project",
		delegation: { parentSessionId: parent, status: "done" },
		...extra,
	});

describe("sidebar delegation tree", () => {
	it("nests across repositories without changing session context or duplicating rows", () => {
		const input = [session("parent"), worker("child", "parent"), worker("grandchild", "child")];
		const before = structuredClone(input);
		const { roots, parents } = buildSessionTree(input);
		expect(roots.map((n) => n.session.id)).toEqual(["parent"]);
		expect(visibleSessionRows(roots, new Set()).map((r) => [r.node.session.id, r.depth])).toEqual([
			["parent", 0],
			["child", 1],
			["grandchild", 2],
		]);
		expect(parents.get("child")).toBe("parent");
		expect(input).toEqual(before);
		expect(roots[0].workerCount).toBe(2);
	});
	it("keeps deleted-parent workers accessible and breaks corrupt cycles", () => {
		const { roots } = buildSessionTree([
			worker("orphan", "deleted"),
			worker("self", "self"),
			worker("a", "b"),
			worker("b", "a"),
			worker("c", "b"),
		]);
		const rows = visibleSessionRows(roots, new Set());
		expect(rows).toHaveLength(5);
		expect(new Set(rows.map((r) => r.node.session.id)).size).toBe(5);
		expect(roots.map((n) => n.session.id)).toEqual(expect.arrayContaining(["orphan", "self"]));
	});
	it("counts attention across descendants and orders families by worker activity", () => {
		const { roots } = buildSessionTree([
			session("older-parent"),
			session("other", { modifiedAt: "2026-02-01T00:00:00Z" }),
			worker("child", "older-parent", {
				delegation: { parentSessionId: "older-parent", status: "needs_input" },
				modifiedAt: "2026-03-01T00:00:00Z",
			}),
		]);
		expect(roots[0].session.id).toBe("older-parent");
		expect(roots[0].needsInputCount).toBe(1);
		expect(
			visibleSessionRows(roots, new Set(["older-parent"])).map((r) => r.node.session.id),
		).toEqual(["older-parent", "other"]);
	});
	it("pins roots as families and pinned children never escape their parent", () => {
		const { roots } = buildSessionTree([
			session("parent"),
			session("pinned", { pinned: true }),
			worker("pinned-child", "parent", { pinned: true }),
		]);
		expect(roots.map((n) => n.session.id)).toEqual(["pinned", "parent"]);
		expect(roots[1].children[0].session.id).toBe("pinned-child");
	});
});
