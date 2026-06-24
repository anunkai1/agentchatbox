/**
 * /api/capabilities — what tools/skills/extensions the pi Agent has loaded.
 *
 * Runs `pi list`, parses package metadata (package.json → pi section),
 * and extracts tool names and skill names so the web UI can show what
 * is available without looking at the terminal.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CapabilityPackage {
	name: string;
	path: string;
	version?: string;
	description?: string;
}

export interface CapabilityTool {
	name: string;
	package: string; // which package provides it
}

export interface CapabilitySkill {
	name: string;
	package: string; // which package provides it
}

export interface Capabilities {
	packages: CapabilityPackage[];
	tools: CapabilityTool[];
	skills: CapabilitySkill[];
}

/**
 * Run `pi list` and return the set of capabilities.
 * On any error returns empty data; never throws.
 */
export async function getCapabilities(): Promise<Capabilities> {
	const empty: Capabilities = { packages: [], tools: [], skills: [] };

	// 1. Run `pi list`
	let piListOut = "";
	try {
		piListOut = await execPiList();
	} catch {
		// pi list failed — return empty data gracefully
		return empty;
	}

	// 2. Parse package names + paths
	const pkgs = parsePiList(piListOut);
	if (pkgs.length === 0) return empty;

	// 3. For each package, read its package.json and extract tools / skills
	const packages: CapabilityPackage[] = [];
	const tools: CapabilityTool[] = [];
	const skills: CapabilitySkill[] = [];

	for (const pkg of pkgs) {
		const pkgDir = pkg.path;
		const pkgJsonPath = join(pkgDir, "package.json");
		if (!existsSync(pkgJsonPath)) {
			packages.push({ name: pkg.name, path: pkgDir });
			continue;
		}

		let pkgJson: Record<string, unknown>;
		try {
			pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		} catch {
			packages.push({ name: pkg.name, path: pkgDir });
			continue;
		}

		packages.push({
			name: pkg.name,
			path: pkgDir,
			version: typeof pkgJson.version === "string" ? pkgJson.version : undefined,
			description: typeof pkgJson.description === "string" ? pkgJson.description : undefined,
		});

		const pi = pkgJson.pi as Record<string, unknown> | undefined;
		if (!pi) continue;

		// Extract tools from extension files
		const extensions = pi.extensions;
		if (Array.isArray(extensions)) {
			for (const ext of extensions) {
				if (typeof ext !== "string") continue;
				const extPath = join(pkgDir, ext);
				const extTools = extractToolNames(extPath);
				for (const t of extTools) {
					tools.push({ name: t, package: pkg.name });
				}
			}
		}

		// Extract skills from skills directories
		const skillsDirs = pi.skills;
		if (Array.isArray(skillsDirs)) {
			for (const sd of skillsDirs) {
				if (typeof sd !== "string") continue;
				const sdPath = join(pkgDir, sd);
				const skillNames = extractSkillNames(sdPath);
				for (const s of skillNames) {
					skills.push({ name: s, package: pkg.name });
				}
			}
		}
	}

	return { packages, tools, skills };
}

function execPiList(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("pi", ["list"], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`pi list failed: ${err.message}. stderr: ${stderr}`));
				return;
			}
			resolve(stdout);
		});
	});
}

interface RawPkg {
	name: string;
	path: string;
}

/**
 * Parse `pi list` output.
 *
 * Format:
 *   User packages:
 *     <source>:<name>
 *       <path>
 *
 * Example:
 *   User packages:
 *     npm:pi-web-access
 *       /home/architect/.pi/agent/npm/node_modules/pi-web-access
 */
function parsePiList(output: string): RawPkg[] {
	const lines = output.split("\n");
	const pkgs: RawPkg[] = [];

	let currentName: string | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			currentName = null;
			continue;
		}

		// Lines that start with a source prefix like "npm:" or "user:" indicate a package name
		if (/^[\w-]+:/.test(trimmed) && !trimmed.startsWith("/")) {
			currentName = trimmed;
		}
		// Lines that start with "/" are paths (relative to the package above)
		else if (trimmed.startsWith("/") && currentName) {
			pkgs.push({ name: currentName, path: trimmed });
			currentName = null;
		}
	}

	return pkgs;
}

/**
 * Extract tool names from an extension file by looking for
 * `pi.registerTool({ ... name: "tool_name" ... })` patterns.
 */
function extractToolNames(filePath: string): string[] {
	try {
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, "utf-8");
		const tools: string[] = [];

		// Find registerTool blocks and extract the name
		const registerRegex = /registerTool\s*\(\s*\{[^}]*name\s*:\s*"([^"]+)"/gs;
		let match: RegExpExecArray | null;
		while ((match = registerRegex.exec(content)) !== null) {
			tools.push(match[1]);
		}

		return [...new Set(tools)]; // dedupe
	} catch {
		return [];
	}
}

/**
 * Extract skill names from a skills directory.
 * Each subdirectory is a skill (must contain SKILL.md).
 */
function extractSkillNames(skillsDir: string): string[] {
	try {
		if (!existsSync(skillsDir)) return [];
		const entries = readdirSync(skillsDir, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}
