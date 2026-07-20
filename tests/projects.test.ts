/**
 * projects.ts — the project store.
 *
 * Each Project is a real folder whose path becomes `pi`'s cwd; its
 * instructions live in `<cwd>/AGENTS.md`. These tests verify CRUD,
 * the always-present builtin Global project, AGENTS.md round-trip,
 * cwd→projectId derivation, and that deleting a project removes its
 * folder without touching session JSONLs.
 *
 * The store points at a temp `data/projects.json` and a temp `piCwd`
 * (via PI_CWD) so `.projects/<id>/` folders are created in isolation.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let piCwd: string;

beforeAll(() => {
	// config.piCwd is captured at module-load time, so PI_CWD must be set
	// BEFORE the first import of projects.js/config.js and stay constant
	// for the whole file. The store file is reset per-test instead.
	dataDir = mkdtempSync(join(tmpdir(), "acb-projects-data-"));
	piCwd = mkdtempSync(join(tmpdir(), "acb-projects-picwd-"));
	process.env.AGENTCHATBOX_PROJECTS_FILE = join(dataDir, "projects.json");
	process.env.PI_CWD = piCwd;
});

afterAll(() => {
	for (const d of [dataDir, piCwd]) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
	delete process.env.AGENTCHATBOX_PROJECTS_FILE;
	delete process.env.PI_CWD;
});

beforeEach(() => {
	// Reset the store to empty (Global is auto-reinjected on read). Also
	// wipe any leftover project folders from the previous test.
	try {
		unlinkSync(process.env.AGENTCHATBOX_PROJECTS_FILE!);
	} catch {
		/* may not exist */
	}
	try {
		rmSync(join(piCwd, ".projects"), { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

afterEach(() => {});

describe("listProjects", () => {
	it("always includes the builtin Global project whose cwd is piCwd", async () => {
		const { listProjects, GLOBAL_PROJECT_ID } = await import("../src/server/projects.js");
		const projects = listProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0].id).toBe(GLOBAL_PROJECT_ID);
		expect(projects[0].builtin).toBe(true);
		expect(resolve(projects[0].cwd)).toBe(resolve(piCwd!));
	});

	it("survives a corrupt store file by resetting to Global-only", async () => {
		writeFileSync(process.env.AGENTCHATBOX_PROJECTS_FILE!, "{ not valid json");
		const { listProjects } = await import("../src/server/projects.js");
		expect(listProjects()).toHaveLength(1); // Global
	});
});

describe("createProject", () => {
	it("creates a folder under piCwd/.projects/<id>/ and writes the AGENTS.md", async () => {
		const { createProject, listProjects } = await import("../src/server/projects.js");
		const p = createProject({ name: "Pirate", icon: "🏴", instructions: "Talk like a pirate." });
		expect(p.name).toBe("Pirate");
		expect(p.icon).toBe("🏴");
		expect(existsSync(join(piCwd!, ".projects", p.id))).toBe(true);
		expect(readFileSync(join(piCwd!, ".projects", p.id, "AGENTS.md"), "utf8")).toBe(
			"Talk like a pirate.",
		);
		// Global + the new one.
		expect(listProjects()).toHaveLength(2);
	});

	it("defaults name and icon when blank", async () => {
		const { createProject } = await import("../src/server/projects.js");
		const p = createProject({ name: "  ", icon: "" });
		expect(p.name).toBe("New project");
		expect(p.icon).toBe("📁");
	});
});

describe("updateProject", () => {
	it("updates metadata and rewrites the AGENTS.md", async () => {
		const { createProject, updateProject, getProject, readProjectInstructions } = await import(
			"../src/server/projects.js"
		);
		const p = createProject({ name: "old", instructions: "a" });
		const updated = updateProject(p.id, { name: "new", icon: "✨", instructions: "b" });
		expect(updated?.name).toBe("new");
		expect(updated?.icon).toBe("✨");
		expect(getProject(p.id)?.name).toBe("new");
		expect(readProjectInstructions(p.id)).toBe("b");
	});

	it("returns undefined for an unknown id", async () => {
		const { updateProject } = await import("../src/server/projects.js");
		expect(updateProject("nope", { name: "x" })).toBeUndefined();
	});

	// Regression: readStore() used to replace the Global record with a
	// pristine globalProject() on every read, wiping the operator's
	// default-model-for-new-chats. updateProject wrote the defaults to
	// disk, but getProject("global") then read them back as empty — so
	// resolveInitDefaults never applied them and new tabs ignored the
	// configured default. The fix merges the on-disk Global over a fresh
	// globalProject(), preserving defaults while still tracking piCwd.
	it("preserves Global default-model-for-new-chats across reads", async () => {
		const { updateProject, getProject, GLOBAL_PROJECT_ID } = await import(
			"../src/server/projects.js"
		);
		updateProject(GLOBAL_PROJECT_ID, {
			defaultModelId: "glm-4.7",
			defaultProvider: "zai",
			defaultThinkingLevel: "high",
		});
		// A fresh getProject re-reads the store (cache is mtime-invalidated);
		// the defaults must survive, not be wiped by the Global re-injection.
		const g = getProject(GLOBAL_PROJECT_ID);
		expect(g?.defaultModelId).toBe("glm-4.7");
		expect(g?.defaultProvider).toBe("zai");
		expect(g?.defaultThinkingLevel).toBe("high");
		// And the builtin/config-derived fields still track config.
		expect(g?.builtin).toBe(true);
		expect(g?.cwd).toBe(piCwd);
	});
});

describe("deleteProject", () => {
	it("removes the metadata, sidebar entry, and folder", async () => {
		const { createProject, deleteProject, listProjects, getProject } = await import(
			"../src/server/projects.js"
		);
		const p = createProject({ name: "temp" });
		expect(deleteProject(p.id)).toBe(true);
		expect(getProject(p.id)).toBeUndefined();
		expect(listProjects()).toHaveLength(1); // Global only
		expect(existsSync(join(piCwd!, ".projects", p.id))).toBe(false);
	});

	it("refuses to delete the builtin Global project", async () => {
		const { deleteProject, GLOBAL_PROJECT_ID, listProjects } = await import(
			"../src/server/projects.js"
		);
		expect(deleteProject(GLOBAL_PROJECT_ID)).toBe(false);
		expect(listProjects()).toHaveLength(1);
	});
});

describe("projectIdForCwd", () => {
	it("derives the project id from a cwd, falling back to global", async () => {
		const { createProject, projectIdForCwd, GLOBAL_PROJECT_ID } = await import(
			"../src/server/projects.js"
		);
		const p = createProject({ name: "x" });
		expect(projectIdForCwd(p.cwd)).toBe(p.id);
		expect(projectIdForCwd(piCwd!)).toBe(GLOBAL_PROJECT_ID);
		expect(projectIdForCwd("/nonexistent/elsewhere")).toBe(GLOBAL_PROJECT_ID);
	});
});

describe("reorderProjects", () => {
	it("reorders non-global projects while keeping Global first", async () => {
		const { createProject, reorderProjects, listProjects } = await import(
			"../src/server/projects.js"
		);
		const a = createProject({ name: "a" });
		const b = createProject({ name: "b" });
		reorderProjects([b.id, a.id]);
		const order = listProjects().map((p) => p.id);
		expect(order[0]).toBe("global");
		expect(order.slice(1)).toEqual([b.id, a.id]);
	});
});
