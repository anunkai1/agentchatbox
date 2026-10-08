import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readModelThinking, saveModelThinking } from "../src/server/model-thinking.js";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "acb-model-thinking-"));
	file = join(dir, "settings.json");
	process.env.AGENTCHATBOX_PI_SETTINGS_FILE = file;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENTCHATBOX_PI_SETTINGS_FILE;
});

describe("model thinking levels", () => {
	it("reads nothing when the file, field, key or value is missing or invalid", () => {
		expect(readModelThinking("venice", "m")).toBeUndefined();
		writeFileSync(file, JSON.stringify({ modelThinkingLevels: { "venice/m": "bogus" } }));
		expect(readModelThinking("venice", "m")).toBeUndefined();
		expect(readModelThinking("venice", "other")).toBeUndefined();
		writeFileSync(file, "not json");
		expect(readModelThinking("venice", "m")).toBeUndefined();
	});

	it("saves into a new file, then updates it without touching other settings", () => {
		saveModelThinking("venice", "m", "max");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			modelThinkingLevels: { "venice/m": "max" },
		});
		writeFileSync(file, JSON.stringify({ theme: "dark", modelThinkingLevels: { "a/b": "low" } }));
		saveModelThinking("venice", "m", "high");
		expect(readModelThinking("venice", "m")).toBe("high");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			theme: "dark",
			modelThinkingLevels: { "a/b": "low", "venice/m": "high" },
		});
	});

	it("leaves an unreadable settings file alone", () => {
		writeFileSync(file, "{ broken");
		saveModelThinking("venice", "m", "max");
		expect(readFileSync(file, "utf8")).toBe("{ broken");
	});

	it("writes through a symlinked settings file", () => {
		const target = join(dir, "real.json");
		writeFileSync(target, "{}");
		symlinkSync(target, file);
		saveModelThinking("venice", "m", "max");
		expect(lstatSync(file).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
			modelThinkingLevels: { "venice/m": "max" },
		});
	});
});
