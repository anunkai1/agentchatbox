import type { SessionSummary } from "../shared/protocol.js";

export interface SessionNode {
	session: SessionSummary;
	children: SessionNode[];
	workerCount: number;
	needsInputCount: number;
	modifiedAt: string;
}
export interface SessionTreeRow {
	node: SessionNode;
	depth: number;
}

/** Project grouping happens AFTER ancestry: a child can work in another repo.
 * Missing parents become roots; malformed cycles must never hide a session. */
export function buildSessionTree(sessions: SessionSummary[]): {
	roots: SessionNode[];
	parents: Map<string, string>;
} {
	const nodes = new Map(
		sessions.map((session) => [
			session.id,
			{
				session,
				children: [],
				workerCount: 0,
				needsInputCount: 0,
				modifiedAt: session.modifiedAt,
			} as SessionNode,
		]),
	);
	const parents = new Map<string, string>();
	for (const session of sessions) {
		const parent = session.delegation?.parentSessionId;
		if (parent && parent !== session.id && nodes.has(parent)) parents.set(session.id, parent);
	}
	for (const id of parents.keys()) {
		const seen = new Set([id]);
		let parent = parents.get(id);
		while (parent) {
			if (seen.has(parent)) {
				parents.delete(id);
				break;
			}
			seen.add(parent);
			parent = parents.get(parent);
		}
	}
	const roots: SessionNode[] = [];
	for (const [id, node] of nodes) {
		const parent = parents.get(id);
		if (parent) nodes.get(parent)!.children.push(node);
		else roots.push(node);
	}
	const sort = (siblings: SessionNode[]) => {
		for (const node of siblings) {
			sort(node.children);
			for (const child of node.children) {
				node.workerCount += 1 + child.workerCount;
				node.needsInputCount +=
					Number(child.session.delegation?.status === "needs_input") + child.needsInputCount;
				if (child.modifiedAt > node.modifiedAt) node.modifiedAt = child.modifiedAt;
			}
		}
		siblings.sort(
			(a, b) =>
				Number(!!b.session.pinned) - Number(!!a.session.pinned) ||
				b.modifiedAt.localeCompare(a.modifiedAt) ||
				b.session.createdAt.localeCompare(a.session.createdAt),
		);
	};
	sort(roots);
	return { roots, parents };
}

/** Flatten only expanded rows, keeping the existing fixed-height virtual list. */
export function visibleSessionRows(roots: SessionNode[], collapsed: Set<string>): SessionTreeRow[] {
	const rows: SessionTreeRow[] = [];
	const visit = (nodes: SessionNode[], depth: number) => {
		for (const node of nodes) {
			rows.push({ node, depth });
			if (!collapsed.has(node.session.id)) visit(node.children, depth + 1);
		}
	};
	visit(roots, 0);
	return rows;
}
