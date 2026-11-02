#!/usr/bin/env node
/**
 * One-command first-time setup for AgentChatBox (`npm run setup`).
 *
 * 1. Copies `.env.example` → `.env` (mode 0600) if `.env` does not exist yet.
 * 2. Registers ACB's portable bundled Pi extensions in `~/.pi/agent/settings.json`
 *    (preserving any existing settings and third-party packages).
 * 3. Checks whether at least one LLM provider is logged in via `pi auth login`.
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Portable bundled extensions enabled for general users.
 * (`extensions/openai-models` is intentionally excluded here because it filters
 * the OpenAI picker down to GPT-6+ only; operators who want that filter can add
 * it explicitly to `~/.pi/agent/settings.json`.)
 */
export const DEFAULT_BUNDLED_EXTENSIONS = [
	"auto-title",
	"auto-continue",
	"acb-workflows",
	"codex-fast",
	"venice-no-system-prompt",
	"claude-delegate",
	"delegate",
];

export function runSetup(options = {}) {
	const rootDir = resolve(
		options.rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
	);
	const settingsFile = resolve(
		options.settingsFile ??
			process.env.AGENTCHATBOX_PI_SETTINGS_FILE ??
			join(homedir(), ".pi", "agent", "settings.json"),
	);
	const authFile = resolve(
		options.authFile ??
			process.env.AGENTCHATBOX_PI_AUTH_FILE ??
			join(homedir(), ".pi", "agent", "auth.json"),
	);
	const log = options.quiet ? () => {} : (msg) => console.log(msg);

	// 1. Seed .env from .env.example if missing.
	const envPath = join(rootDir, ".env");
	const envExamplePath = join(rootDir, ".env.example");
	let createdEnv = false;
	if (!existsSync(envPath) && existsSync(envExamplePath)) {
		copyFileSync(envExamplePath, envPath);
		chmodSync(envPath, 0o600);
		createdEnv = true;
		log("✓ Created .env from .env.example");
	} else {
		log("• Kept existing .env");
	}

	// 2. Register bundled extensions in Pi's settings.json.
	const settingsDir = dirname(settingsFile);
	mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
	let settings = {};
	if (existsSync(settingsFile)) {
		settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	}
	const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
	const resolvedExisting = new Set(
		packages
			.filter((entry) => typeof entry === "string" && !entry.startsWith("npm:"))
			.map((entry) => resolve(settingsDir, entry)),
	);

	const added = [];
	for (const name of DEFAULT_BUNDLED_EXTENSIONS) {
		const extDir = join(rootDir, "extensions", name);
		if (!existsSync(join(extDir, "package.json"))) continue;
		if (resolvedExisting.has(extDir)) continue;
		const relPath = relative(settingsDir, extDir).split("\\").join("/");
		const entry = relPath.startsWith(".") ? relPath : `./${relPath}`;
		packages.push(entry);
		resolvedExisting.add(extDir);
		added.push(name);
	}

	if (!existsSync(settingsFile) || !Array.isArray(settings.packages) || added.length > 0) {
		settings.packages = packages;
		const temp = join(settingsDir, `.${process.pid}.${Date.now()}.settings.tmp`);
		writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, settingsFile);
		chmodSync(settingsFile, 0o600);
		log(
			added.length > 0
				? `✓ Enabled bundled Pi extensions in ${settingsFile}: ${added.join(", ")}`
				: `✓ Initialised ${settingsFile}`,
		);
	} else {
		log(`• Bundled Pi extensions already enabled in ${settingsFile}`);
	}

	// 3. Check provider authentication presence (without reading secret values).
	let authedProviders = [];
	try {
		const raw = JSON.parse(readFileSync(authFile, "utf8"));
		if (raw && typeof raw === "object") {
			authedProviders = Object.entries(raw)
				.filter(([, v]) => {
					if (!v || typeof v !== "object") return false;
					if (v.type === "oauth" && typeof v.access === "string" && v.access.trim()) return true;
					return typeof v.key === "string" && v.key.trim().length > 0;
				})
				.map(([k]) => k);
		}
	} catch {
		// Missing or unreadable auth.json — user has not logged in yet.
	}

	if (authedProviders.length === 0) {
		log("\nNext steps:");
		log("  1. Authenticate at least one provider:  pi auth login <provider>");
		log("  2. Start AgentChatBox:                  npm run dev");
	} else {
		log(`• Authenticated providers ready: ${authedProviders.join(", ")}`);
		log("\nReady — start AgentChatBox with `npm run dev` (or `npm run build && npm start`).");
	}

	return { createdEnv, addedExtensions: added, authedProviders };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runSetup();
}
