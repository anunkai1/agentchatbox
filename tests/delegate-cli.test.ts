import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "../extensions/delegate/cli.ts");
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
let server: Server;
let base = "";
const records = mkdtempSync(join(tmpdir(), "acb-delegate-cli-"));

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			requests.push({ url: req.url ?? "", body: JSON.parse(raw) });
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify(req.url === "/api/internal/sessions" ? { sessionId: "w-1" } : { ok: true }),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (addr && typeof addr === "object") base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function run(
	args: string[],
	input: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const child = execFile(
			process.execPath,
			[CLI, ...args],
			{
				env: {
					...process.env,
					ACB_INTERNAL_URL: base,
					ACB_INTERNAL_TOKEN: "t",
					ACB_DELEGATIONS_DIR: records,
					ACB_CHAT_ID: "parent-1",
					ACB_CHAT_MODEL: "openai/gpt-6.1-sol",
					ACB_CHAT_THINKING: "high",
					ACB_CLAUDE_MODE: "opus",
				},
			},
			(error, stdout, stderr) =>
				resolve({ stdout, stderr, code: error ? Number(error.code ?? 1) : 0 }),
		);
		child.stdin?.end(input);
	});
}

describe("delegate cli.ts (Claude Code's way to delegate)", () => {
	it("starts a Claude Code worker for this chat", async () => {
		const out = await run(["start", "--title", "Fix page", "--cwd", tmpdir()], "The brief");
		expect(out.stdout).toContain("[Fix page](/s/w-1)");
		expect(out.stdout).toContain("Claude Code opus");
		expect(requests[0].body).toMatchObject({
			cwd: tmpdir(),
			provider: "openai",
			modelId: "gpt-6.1-sol",
		});
		expect(requests[1]).toMatchObject({
			url: "/api/internal/sessions/w-1/prompt",
			body: { message: "/delegate start w-1" },
		});
		const record = JSON.parse(readFileSync(join(records, "w-1.json"), "utf8"));
		expect(record).toMatchObject({
			parentSessionId: "parent-1",
			claude: "opus",
			task: "The brief",
		});
	});

	it("messages a worker and lists workers", async () => {
		requests.length = 0;
		expect((await run(["message", "w-1"], "Also check mobile")).stdout).toContain("Sent to");
		expect(requests[0]).toMatchObject({
			url: "/api/internal/sessions/w-1/prompt",
			body: { message: "Also check mobile" },
		});
		const status = await run(["status"], "");
		expect(status.stdout).toContain("[Fix page](/s/w-1)");
		expect(status.stdout).toContain("w-1  Fix page");
	});

	it("explains itself and fails clearly outside a chat", async () => {
		expect((await run(["help"], "")).stdout).toContain("cli.ts start --title");
		const out = await run(["message", "nope"], "x");
		expect(out.code).not.toBe(0);
		expect(out.stderr).toContain("no worker with id nope");
	});
});
