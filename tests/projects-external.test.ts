import {
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let piCwd: string;
let externalCwd: string;
let projectsFile: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "acb-external-project-"));
	piCwd = join(root, "acb");
	externalCwd = join(root, "mavalieth");
	projectsFile = join(root, "projects.json");
	mkdirSync(piCwd);
	mkdirSync(externalCwd);
	process.env.PI_CWD = piCwd;
	process.env.AGENTCHATBOX_PROJECTS_FILE = projectsFile;
	process.env.AGENTCHATBOX_TRUSTED_EXTERNAL_PROJECTS = `mavalieth:${externalCwd}`;
	vi.resetModules();
});

afterEach(() => {
	delete process.env.PI_CWD;
	delete process.env.AGENTCHATBOX_PROJECTS_FILE;
	delete process.env.AGENTCHATBOX_TRUSTED_EXTERNAL_PROJECTS;
	vi.resetModules();
	rmSync(root, { recursive: true, force: true });
});

function writeStore(projects: unknown[], sidebarOrder = ["global", "mavalieth"]): void {
	writeFileSync(projectsFile, JSON.stringify({ projects, sidebarOrder }));
}

describe("trusted external projects", () => {
	it("accepts the exact configured repository and forces deletion protection", async () => {
		writeStore([
			{ id: "mavalieth", name: "Mavalieth", icon: "📈", cwd: externalCwd },
		]);
		const { deleteProject, listProjects, projectIdForCwd } = await import(
			"../src/server/projects.js"
		);
		const project = listProjects().find((entry) => entry.id === "mavalieth");
		expect(project).toMatchObject({
			id: "mavalieth",
			name: "Mavalieth",
			icon: "📈",
			cwd: resolve(externalCwd),
			builtin: true,
		});
		expect(projectIdForCwd(externalCwd)).toBe("mavalieth");
		expect(deleteProject("mavalieth")).toBe(false);
		expect(existsSync(externalCwd)).toBe(true);
		expect(listProjects().some((entry) => entry.id === "mavalieth")).toBe(true);
	});

	it("does not let sidecar data redirect a trusted id or register another external cwd", async () => {
		const other = join(root, "other");
		mkdirSync(other);
		writeStore([
			{ id: "mavalieth", name: "redirected", icon: "x", cwd: other },
			{ id: "untrusted", name: "untrusted", icon: "x", cwd: other },
		]);
		const { listProjects } = await import("../src/server/projects.js");
		const projects = listProjects();
		expect(projects.some((entry) => entry.id === "untrusted")).toBe(false);
		expect(projects.find((entry) => entry.id === "mavalieth")).toMatchObject({
			name: "mavalieth",
			cwd: resolve(externalCwd),
			builtin: true,
		});
	});

	it("does not follow an AGENTS.md symlink when reading or writing instructions", async () => {
		writeStore([
			{ id: "mavalieth", name: "Mavalieth", icon: "📈", cwd: externalCwd },
		]);
		const outside = join(root, "sensitive.txt");
		const instructions = join(externalCwd, "AGENTS.md");
		writeFileSync(outside, "do not expose or overwrite");
		symlinkSync(outside, instructions);
		const { readProjectInstructions, writeProjectInstructions } = await import(
			"../src/server/projects.js"
		);
		expect(readProjectInstructions("mavalieth")).toBe("");
		writeProjectInstructions("mavalieth", "safe project instructions");
		expect(readFileSync(outside, "utf8")).toBe("do not expose or overwrite");
		expect(lstatSync(instructions).isSymbolicLink()).toBe(false);
		expect(readFileSync(instructions, "utf8")).toBe("safe project instructions");
		expect(statSync(instructions).mode & 0o777).toBe(0o600);
	});
});
