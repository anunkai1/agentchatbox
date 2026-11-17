/**
 * Delegation for Claude Code, which cannot call pi tools. claude-delegate runs
 * Claude Code with this chat's ids in its environment (ACB_CHAT_ID,
 * ACB_CHAT_MODEL, ACB_CHAT_THINKING, ACB_CLAUDE_MODE) next to ACB's internal
 * token, so these commands act for the chat exactly like the pi tools do.
 *
 * Run with `node cli.mjs …`: the launcher loads TypeScript through local tsx.
 */
import { readFileSync } from "node:fs";
import { readModelThinking } from "../../src/server/model-thinking.ts";
import {
	AcbSessions,
	BRIEF_GUIDANCE,
	chatLink,
	cwdGuidance,
	DELEGATE_CLI_PATH,
	DISPATCH_GUIDANCE,
	formatStatusList,
	listDelegations,
	type ModelChoice,
	messageWorker,
	startWorker,
	workerLabel,
} from "./lib.ts";

const CLI = `node ${DELEGATE_CLI_PATH}`;
const CLAUDE_MODES = ["opus", "sonnet", "haiku"];

const HELP = `Delegate work to worker chats (ordinary ACB chats that report back here).

  ${CLI} start --title "<short title>" --cwd <folder> [--model opus|sonnet|haiku|<provider/model>] < brief
  ${CLI} message <worker id> < message
  ${CLI} status [words]

start: workers run in Claude Code in /cc chats, or use ACB's default model unless --model names another.
--${cwdGuidance()}
After starting, give the owner the link and end your turn: a one-line summary with a link back to the worker arrives here when it finishes.

${DISPATCH_GUIDANCE.join("\n").replaceAll("delegate_status", "status").replaceAll("delegate_message", "message")}

Brief: ${BRIEF_GUIDANCE}`;

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set: this only works inside an ACB chat`);
	return value;
}

function chatModel(): ModelChoice {
	const [provider, ...rest] = env("ACB_CHAT_MODEL").split("/");
	return {
		provider,
		modelId: rest.join("/"),
		thinkingLevel: process.env.ACB_CHAT_THINKING ?? "medium",
	};
}

function option(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<string> {
	const acb = new AcbSessions();
	switch (args[0]) {
		case "start": {
			const title = option(args, "--title");
			const cwd = option(args, "--cwd");
			const task = readFileSync(0, "utf8").trim();
			if (!title || !cwd || !task) throw new Error(`usage: ${CLI} start --title … --cwd … < brief`);
			const model = option(args, "--model");
			if (
				args.includes("--model") &&
				(!model ||
					(!CLAUDE_MODES.includes(model.toLowerCase()) &&
						!/^[^/\s]+\/[^/\s](?:\S*[^/\s])?$/u.test(model)))
			) {
				throw new Error(
					"--model must be opus, sonnet, haiku or provider/model (no default fallback)",
				);
			}
			const parentModel = chatModel();
			const claude = model
				? CLAUDE_MODES.includes(model.toLowerCase())
					? model.toLowerCase()
					: undefined
				: process.env.ACB_CLAUDE_MODE || undefined;
			const [provider, ...rest] = (model && !claude ? model : "").split("/");
			const modelId = rest.join("/");
			const workerModel =
				provider && modelId
					? {
							provider,
							modelId,
							thinkingLevel: readModelThinking(provider, modelId) ?? parentModel.thinkingLevel,
						}
					: claude
						? parentModel
						: ((await acb.defaultModel()) ?? parentModel);
			const record = await startWorker(acb, {
				title,
				task,
				cwd,
				parentSessionId: env("ACB_CHAT_ID"),
				parentModel,
				workerModel,
				claude,
			});
			return `Worker started: ${chatLink(record.title, record.id)} in ${record.cwd} (${workerLabel(record)}). Worker id: ${record.id}`;
		}
		case "message": {
			const message = readFileSync(0, "utf8").trim();
			if (!args[1] || !message) throw new Error(`usage: ${CLI} message <worker id> < message`);
			const record = await messageWorker(acb, args[1], message);
			return `Sent to ${chatLink(record.title, record.id)}.`;
		}
		case "status": {
			const query = args.slice(1).join(" ");
			const records = listDelegations(10, undefined, query ? { query } : {});
			return `${formatStatusList(records)}\n\n${records.map((r) => `${r.id}  ${r.title}`).join("\n")}`;
		}
		default:
			return HELP;
	}
}

main(process.argv.slice(2)).then(
	(out) => console.log(out),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	},
);
