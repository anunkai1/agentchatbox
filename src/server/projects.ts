/**
 * Server-side project store — `data/projects.json`.
 *
 * A "Project" is a named, selectable workspace that carries its own
 * agent instructions. Each Project is a real folder on disk whose path
 * becomes the `cwd` we pass to `pi --mode rpc`. Because `pi` auto-loads
 * `AGENTS.md` from its cwd (see pi docs §Context Files), a Project's
 * instructions are literally just an `AGENTS.md` file in that folder —
 * no `--append-system-prompt` needed, and they survive any
 * agentchatbox rewrite because they're plain files pi already
 * understands.
 *
 * This keeps the transport-layer-only rule intact: the server stores
 * metadata + writes a file pi reads anyway. No agent logic is added.
 *
 * Storage layout:
 *   data/projects.json            — metadata (id, name, icon, cwd, defaults)
 *   <cwd>/AGENTS.md               — per-project instructions (pi loads it)
 *   <config.piCwd>/.projects/<id>/ — ACB-managed project folders
 *   trusted external cwd          — exact operator-allowlisted repos; never deleted
 *
 * The "Global" project is builtin: its cwd is `config.piCwd` itself, so
 * it preserves today's behavior for anyone who doesn't want projects,
 * and its `AGENTS.md` is the existing repo-level rules file. It cannot
 * be deleted.
 *
 * Session→Project membership is DERIVED from cwd (each session carries
 * its cwd; we match it against the project cwds), never stored — so
 * there is zero drift between the sidecar and pi's session JSONLs.
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import type { ThinkingLevel } from "../shared/protocol.js";
import { config } from "./config.js";
import { writeJsonAtomic } from "./json-store.js";
import { projectRoot } from "./paths.js";

/** The builtin Global project id. */
export const GLOBAL_PROJECT_ID = "global";
const PROJECT_ID_RE = /^[a-z0-9]{6}$/;
const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;

/**
 * On-disk project record. `cwd` is the working directory `pi` runs in;
 * `AGENTS.md` inside it holds the instructions. Everything else is UI
 * metadata + optional spawn-time defaults.
 */
export interface ProjectRecord {
	id: string;
	name: string;
	icon: string;
	/** Absolute working directory passed to `pi`. */
	cwd: string;
	/** Builtin/trusted external projects cannot be deleted by ACB. */
	builtin?: boolean;
	/** Optional default model for new chats started in this project. */
	defaultModelId?: string | null;
	/** Optional default provider for new chats. */
	defaultProvider?: string | null;
	/** Optional default thinking level for new chats. */
	defaultThinkingLevel?: ThinkingLevel | null;
}

interface ProjectsFile {
	projects: ProjectRecord[];
	/** Project ids in sidebar display order. */
	sidebarOrder: string[];
}

/** Default location: `<projectRoot>/data/projects.json`. Overridable via AGENTCHATBOX_PROJECTS_FILE for tests. */
function defaultProjectsFile(): string {
	return process.env.AGENTCHATBOX_PROJECTS_FILE
		? resolve(process.env.AGENTCHATBOX_PROJECTS_FILE)
		: resolve(projectRoot, "data", "projects.json");
}

/** Directory that holds non-global project folders. */
function projectsRoot(): string {
	return resolve(config.piCwd, ".projects");
}

/** The Global project record, always present, cwd = config.piCwd. */
function globalProject(): ProjectRecord {
	return {
		id: GLOBAL_PROJECT_ID,
		name: "Global",
		icon: "🌐",
		cwd: config.piCwd,
		builtin: true,
	};
}

/**
 * Read the raw store, ensuring the builtin Global project is always
 * present (in cwd and in the sidebar order). Corrupt / missing file →
 * a fresh store with just Global.
 *
 * Cached by the file's mtime: this is read once per session during a
 * sidebar refresh (via projectIdForCwd), so a busy sidebar previously
 * re-read + re-parsed the same JSON file dozens of times per refresh.
 * The cache is invalidated by mtime and by every writeStore().
 */
let cachedStore: { file: string; mtime: number; data: ProjectsFile } | null = null;

function readStore(): ProjectsFile {
	const file = defaultProjectsFile();
	let mtime = 0;
	try {
		mtime = statSync(file).mtimeMs;
	} catch {
		/* missing — fall through to a fresh store */
	}
	if (cachedStore && cachedStore.file === file && cachedStore.mtime === mtime) {
		return cachedStore.data;
	}

	let parsed: ProjectsFile | null = null;
	if (existsSync(file)) {
		try {
			const raw = readFileSync(file, "utf8");
			const obj = JSON.parse(raw) as unknown;
			if (obj && typeof obj === "object" && !Array.isArray(obj)) {
				const o = obj as Partial<ProjectsFile>;
				if (Array.isArray(o.projects)) {
					parsed = {
						projects: o.projects.filter(isSafeProjectRecord),
						sidebarOrder: Array.isArray(o.sidebarOrder)
							? o.sidebarOrder.filter((x) => typeof x === "string")
							: [],
					};
				}
			}
		} catch {
			// Corrupt — treat as empty; the next write replaces it.
		}
	}
	if (!parsed) parsed = { projects: [], sidebarOrder: [] };

	// Always (re)inject Global so config.piCwd changes (e.g. PI_CWD) are
	// reflected without a manual edit. We MERGE the on-disk Global record
	// over a fresh globalProject() rather than replacing it wholesale:
	// the operator's chosen default model/provider/thinking for new chats
	// (set via the model picker star) live on the Global record itself,
	// and a blind replace would wipe them on every read — so the default
	// would be written to disk by updateProject but never read back, and
	// resolveInitDefaults would always see no default. Only the
	// config-derived fields (cwd, builtin, id) are forced; everything
	// else (name, icon, defaults) is preserved from disk when present.
	const diskGlobal = parsed.projects.find((p) => p.id === GLOBAL_PROJECT_ID);
	const mergedGlobal: ProjectRecord = {
		...globalProject(),
		...(diskGlobal ?? {}),
		id: GLOBAL_PROJECT_ID,
		cwd: config.piCwd,
		builtin: true,
	};
	parsed.projects = parsed.projects.filter((p) => p.id !== GLOBAL_PROJECT_ID);
	parsed.projects.unshift(mergedGlobal);
	parsed.sidebarOrder = parsed.sidebarOrder.filter((id) => id !== GLOBAL_PROJECT_ID);
	parsed.sidebarOrder.unshift(GLOBAL_PROJECT_ID);

	// Trusted external repos are operator-configured trust anchors, not folders
	// owned by the projects sidecar. Preserve safe UI/default metadata from disk,
	// but force the configured canonical cwd and builtin deletion protection.
	// Inject a conservative default record if the sidecar was lost or corrupt.
	for (const [id, cwd] of config.trustedExternalProjects) {
		const disk = parsed.projects.find((project) => project.id === id);
		const external: ProjectRecord = {
			id,
			name: disk?.name || id,
			icon: disk?.icon || "📁",
			cwd,
			builtin: true,
			...(disk?.defaultModelId !== undefined
				? { defaultModelId: disk.defaultModelId }
				: {}),
			...(disk?.defaultProvider !== undefined
				? { defaultProvider: disk.defaultProvider }
				: {}),
			...(disk?.defaultThinkingLevel !== undefined
				? { defaultThinkingLevel: disk.defaultThinkingLevel }
				: {}),
		};
		parsed.projects = parsed.projects.filter((project) => project.id !== id);
		parsed.projects.push(external);
	}
	// Drop any sidebarOrder ids that no longer have a project, and append
	// any projects not yet in the order.
	const known = new Set(parsed.projects.map((p) => p.id));
	parsed.sidebarOrder = parsed.sidebarOrder.filter((id) => known.has(id));
	for (const p of parsed.projects) {
		if (!parsed.sidebarOrder.includes(p.id)) parsed.sidebarOrder.push(p.id);
	}
	cachedStore = { file, mtime, data: parsed };
	return parsed;
}

function writeStore(store: ProjectsFile): void {
	// Atomic write (tmp + rename) via the shared json-store helper: a crash
	// mid-write or a reader racing the write can't leave a truncated JSON
	// that readStore() would silently drop, losing every project definition.
	writeJsonAtomic(defaultProjectsFile(), store);
	// Invalidate the read cache so the next read picks up the new bytes
	// (and its new mtime).
	cachedStore = null;
}

/** List all projects in sidebar order (Global always first). */
export function listProjects(): ProjectRecord[] {
	const store = readStore();
	const byId = new Map(store.projects.map((p) => [p.id, p]));
	const ordered: ProjectRecord[] = [];
	for (const id of store.sidebarOrder) {
		const p = byId.get(id);
		if (p) ordered.push(p);
	}
	return ordered;
}

/** Get a single project by id (undefined if not found). */
export function getProject(id: string): ProjectRecord | undefined {
	return readStore().projects.find((p) => p.id === id);
}

/** Derive the project id for a given cwd (Global if none match). */
export function projectIdForCwd(cwd: string): string {
	const abs = resolve(cwd);
	const projects = readStore().projects;
	for (const p of projects) {
		if (resolve(p.cwd) === abs) return p.id;
	}
	return GLOBAL_PROJECT_ID;
}

/** Path to a project's AGENTS.md instructions file. */
export function agentsMdPath(project: ProjectRecord): string {
	return resolve(project.cwd, "AGENTS.md");
}

/** Read a project's instructions without following a substituted AGENTS.md symlink. */
export function readProjectInstructions(id: string): string {
	const project = getProject(id);
	if (!project || !isCurrentProjectDirectory(project)) return "";
	const file = agentsMdPath(project);
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > MAX_INSTRUCTIONS_BYTES) return "";
		return readFileSync(fd, "utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Create a new project. Generates a fresh id, makes its folder under
 * `<piCwd>/.projects/<id>/`, writes the AGENTS.md, and appends it to
 * the sidebar order. Returns the new record.
 */
export function createProject(input: {
	name: string;
	icon?: string;
	instructions?: string;
	defaultModelId?: string | null;
	defaultProvider?: string | null;
	defaultThinkingLevel?: ThinkingLevel | null;
}): ProjectRecord {
	const store = readStore();
	const id = generateId(store);
	const cwd = resolve(projectsRoot(), id);
	mkdirSync(cwd, { recursive: true, mode: 0o700 });
	chmodSync(cwd, 0o700);
	const record: ProjectRecord = {
		id,
		name: input.name.trim() || "New project",
		icon: input.icon?.trim() || "📁",
		cwd,
		...(input.defaultModelId ? { defaultModelId: input.defaultModelId } : {}),
		...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
		...(input.defaultThinkingLevel ? { defaultThinkingLevel: input.defaultThinkingLevel } : {}),
	};
	store.projects.push(record);
	store.sidebarOrder.push(id);
	writeStore(store);
	const instr = input.instructions ?? "";
	if (instr.trim().length > 0) writeProjectInstructions(id, instr);
	return record;
}

/**
 * Update a project's metadata and/or instructions. `instructions`, when
 * provided (even as ""), overwrites the AGENTS.md. Returns the updated
 * record or undefined if the project doesn't exist. Builtin projects
 * can be renamed/re-iconed but their cwd is fixed.
 */
export function updateProject(
	id: string,
	patch: {
		name?: string;
		icon?: string;
		instructions?: string;
		defaultModelId?: string | null;
		defaultProvider?: string | null;
		defaultThinkingLevel?: ThinkingLevel | null;
	},
): ProjectRecord | undefined {
	// Builtin projects (Global) can be renamed/re-iconed/updated but their
	// cwd is fixed — enforced structurally, since `patch` carries no cwd
	// field, so the spread below can't overwrite it.
	const store = readStore();
	const idx = store.projects.findIndex((p) => p.id === id);
	if (idx < 0) return undefined;
	const current = store.projects[idx];
	const updated: ProjectRecord = {
		...current,
		...(patch.name !== undefined ? { name: patch.name.trim() || current.name } : {}),
		...(patch.icon !== undefined ? { icon: patch.icon.trim() || current.icon } : {}),
		...(patch.defaultModelId !== undefined ? { defaultModelId: patch.defaultModelId } : {}),
		...(patch.defaultProvider !== undefined ? { defaultProvider: patch.defaultProvider } : {}),
		...(patch.defaultThinkingLevel !== undefined
			? { defaultThinkingLevel: patch.defaultThinkingLevel }
			: {}),
	};
	store.projects[idx] = updated;
	writeStore(store);
	if (patch.instructions !== undefined) writeProjectInstructions(id, patch.instructions);
	return updated;
}

/**
 * Write AGENTS.md atomically. Renaming a private sibling file over the target
 * replaces a hostile symlink rather than following it to an arbitrary file.
 */
export function writeProjectInstructions(id: string, text: string): void {
	const project = getProject(id);
	if (!project || Buffer.byteLength(text, "utf8") > MAX_INSTRUCTIONS_BYTES) return;
	if (isManagedProject(project)) {
		try {
			mkdirSync(project.cwd, { recursive: true, mode: 0o700 });
			chmodSync(project.cwd, 0o700);
		} catch {
			return;
		}
	}
	if (!isCurrentProjectDirectory(project)) return;
	const file = agentsMdPath(project);
	const tmp = resolve(project.cwd, `.AGENTS.md.${process.pid}.${randomUUID()}.tmp`);
	try {
		writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
		renameSync(tmp, file);
		chmodSync(file, 0o600);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/**
 * Delete an ACB-managed project. Refuses builtin Global and trusted external
 * repositories. Removes the metadata, the
 * sidebar entry, and the project folder (including its AGENTS.md).
 * Sessions' JSONLs are NOT touched — they live in pi's session dir keyed
 * by the old cwd and will re-appear under an "Other" bucket in the
 * sidebar until that cwd is re-used. Returns true if deleted.
 */
export function deleteProject(id: string): boolean {
	const store = readStore();
	const project = store.projects.find((p) => p.id === id);
	// Global and trusted external repositories are operator-owned. They cannot
	// be removed from metadata or recursively deleted through the ACB UI.
	if (!project || project.builtin || !isManagedProject(project)) return false;

	store.projects = store.projects.filter((p) => p.id !== id);
	store.sidebarOrder = store.sidebarOrder.filter((sid) => sid !== id);
	writeStore(store);
	try {
		rmSync(project.cwd, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	return true;
}

/** Reorder the sidebar by project id. Unknown ids are ignored. */
export function reorderProjects(order: string[]): void {
	const store = readStore();
	const known = new Set(store.projects.map((p) => p.id));
	const next = order.filter((id) => known.has(id));
	// Global always stays first.
	const withoutGlobal = next.filter((id) => id !== GLOBAL_PROJECT_ID);
	for (const id of store.projects.map((p) => p.id)) {
		if (id !== GLOBAL_PROJECT_ID && !next.includes(id)) withoutGlobal.push(id);
	}
	store.sidebarOrder = [GLOBAL_PROJECT_ID, ...withoutGlobal];
	writeStore(store);
}

function safeProjectMetadata(project: Partial<ProjectRecord>): boolean {
	if (typeof project.name !== "string" || project.name.length === 0 || project.name.length > 200) {
		return false;
	}
	if (typeof project.icon !== "string" || project.icon.length > 32) return false;
	if (project.builtin !== undefined && typeof project.builtin !== "boolean") return false;
	if (
		project.defaultModelId !== undefined &&
		project.defaultModelId !== null &&
		(typeof project.defaultModelId !== "string" || project.defaultModelId.length > 256)
	) {
		return false;
	}
	if (
		project.defaultProvider !== undefined &&
		project.defaultProvider !== null &&
		(typeof project.defaultProvider !== "string" || project.defaultProvider.length > 64)
	) {
		return false;
	}
	if (
		project.defaultThinkingLevel !== undefined &&
		project.defaultThinkingLevel !== null &&
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
			project.defaultThinkingLevel,
		)
	) {
		return false;
	}
	return true;
}

function isManagedProject(project: Pick<ProjectRecord, "id" | "cwd">): boolean {
	if (!PROJECT_ID_RE.test(project.id)) return false;
	const root = projectsRoot();
	const expected = resolve(root, project.id);
	const rel = relative(root, expected);
	return !rel.startsWith("..") && resolve(project.cwd) === expected;
}

function isTrustedExternalProject(project: Pick<ProjectRecord, "id" | "cwd">): boolean {
	const trustedCwd = config.trustedExternalProjects.get(project.id);
	return trustedCwd !== undefined && resolve(project.cwd) === trustedCwd;
}

function isCurrentProjectDirectory(project: Pick<ProjectRecord, "id" | "cwd">): boolean {
	if (!isManagedProject(project) && !isTrustedExternalProject(project) && project.id !== GLOBAL_PROJECT_ID) {
		return false;
	}
	try {
		return realpathSync(project.cwd) === resolve(project.cwd) && statSync(project.cwd).isDirectory();
	} catch {
		return false;
	}
}

function isSafeProjectRecord(value: unknown): value is ProjectRecord {
	if (!value || typeof value !== "object") return false;
	const project = value as Partial<ProjectRecord>;
	if (typeof project.id !== "string" || typeof project.cwd !== "string") return false;
	if (!safeProjectMetadata(project)) return false;
	if (project.id === GLOBAL_PROJECT_ID) return true;
	return isManagedProject(project as ProjectRecord) || isTrustedExternalProject(project as ProjectRecord);
}

/** Generate a short unique id not already in the store. */
function generateId(store: ProjectsFile): string {
	const used = new Set(store.projects.map((p) => p.id));
	for (let i = 0; i < 1000; i++) {
		const id = Math.random().toString(36).slice(2, 8);
		if (!used.has(id)) return id;
	}
	// Astronomically unlikely fallback.
	return `p${Date.now().toString(36)}`;
}
