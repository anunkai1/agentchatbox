import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTrustedExternalProjects } from "../src/server/config.js";

let root: string;
let piCwd: string;
let externalCwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "acb-external-config-"));
	piCwd = join(root, "acb");
	externalCwd = join(root, "external");
	mkdirSync(piCwd);
	mkdirSync(externalCwd);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseTrustedExternalProjects", () => {
	it("accepts an exact canonical external directory", () => {
		const projects = parseTrustedExternalProjects(`mavalieth:${externalCwd}`, piCwd);
		expect([...projects]).toEqual([["mavalieth", resolve(externalCwd)]]);
	});

	it("rejects malformed, duplicate, missing, managed, global, and symlink paths", () => {
		const managed = join(piCwd, ".projects", "abcdef");
		mkdirSync(managed, { recursive: true });
		const alias = join(root, "alias");
		symlinkSync(externalCwd, alias);
		expect(() => parseTrustedExternalProjects("bad", piCwd)).toThrow(/invalid.*entry/);
		expect(() => parseTrustedExternalProjects("global:/tmp", piCwd)).toThrow(/invalid.*id/);
		expect(() => parseTrustedExternalProjects("Upper:/tmp", piCwd)).toThrow(/invalid.*id/);
		expect(() => parseTrustedExternalProjects("external:relative", piCwd)).toThrow(/absolute/);
		expect(() => parseTrustedExternalProjects(`external:${join(root, "missing")}`, piCwd)).toThrow(
			/does not exist/,
		);
		expect(() => parseTrustedExternalProjects(`external:${managed}`, piCwd)).toThrow(/outside/);
		expect(() => parseTrustedExternalProjects(`external:${piCwd}`, piCwd)).toThrow(/outside/);
		expect(() => parseTrustedExternalProjects(`external:${alias}`, piCwd)).toThrow(/canonical/);
		expect(() =>
			parseTrustedExternalProjects(`external:${externalCwd},external:${externalCwd}`, piCwd),
		).toThrow(/duplicate.*id/);
		const second = join(root, "second");
		mkdirSync(second);
		expect(() =>
			parseTrustedExternalProjects(`external:${externalCwd},second:${externalCwd}`, piCwd),
		).toThrow(/duplicate.*path/);
	});
});
