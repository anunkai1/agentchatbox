/**
 * Per-model thinking level, remembered in pi's own settings file
 * (`modelThinkingLevels`, keyed `provider/modelId`). pi consults the same key
 * on its own model switches, so ACB keeps no registry of its own.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/thinking.js";
import { log } from "./logger.js";

const FIELD = "modelThinkingLevels";

// Overridable so tests never touch the operator's real pi settings.
function settingsPath(): string {
	const override = process.env.AGENTCHATBOX_PI_SETTINGS_FILE;
	return override ? resolve(override) : join(homedir(), ".pi", "agent", "settings.json");
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function readSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("settings.json is not an object");
	}
	return parsed as Record<string, unknown>;
}

export function readModelThinking(provider: string, modelId: string): ThinkingLevel | undefined {
	try {
		const levels = readSettings(settingsPath())[FIELD];
		if (typeof levels !== "object" || levels === null) return undefined;
		const level = (levels as Record<string, unknown>)[`${provider}/${modelId}`];
		return isThinkingLevel(level) ? level : undefined;
	} catch {
		return undefined;
	}
}

/** Failures are logged, never thrown: a settings problem must not break the chat. */
export function saveModelThinking(provider: string, modelId: string, level: ThinkingLevel): void {
	try {
		const path = existsSync(settingsPath()) ? realpathSync(settingsPath()) : settingsPath();
		const settings = readSettings(path);
		const current = settings[FIELD];
		const levels =
			typeof current === "object" && current !== null && !Array.isArray(current)
				? (current as Record<string, unknown>)
				: {};
		const key = `${provider}/${modelId}`;
		if (levels[key] === level) return;
		settings[FIELD] = { ...levels, [key]: level };
		const tmp = `${path}.acb-${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		log.warn("could not save model thinking level", {
			provider,
			modelId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
