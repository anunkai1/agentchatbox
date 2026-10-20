/**
 * Delegation for Claude Code, which cannot call pi tools. claude-delegate runs
 * Claude Code with this chat's ids in its environment (ACB_CHAT_ID,
 * ACB_CHAT_MODEL, ACB_CHAT_THINKING, ACB_CLAUDE_MODE) next to ACB's internal
 * token, so these commands act for the chat exactly like the pi tools do.
 *
 * Run with `node cli.ts …`: Node strips the types itself.
 */
import { readFileSync } from "node:fs";
import {
	AcbSessions,
	BRIEF_GUIDANCE,
	chatLink,
	DISPATCH_GUIDANCE,
	formatStatusList,
	listDelegations,
	type ModelChoice,
	messageWorker,
	startWorker,
	workerLabel,
} from "./lib.ts";

const CLI = "node /home/lepton/agentchatbox/extensions/delegate/cli.ts";
const CLAUDE_MODES = ["opus", "sonnet", "haiku"];

const HELP = `Delegate work to worker chats (ordinary ACB chats that report back here).

  ${CLI} start --title "<short title>" --cwd <folder> [--model opus|sonnet|haiku|<provider/model>] < brief
  ${CLI} message <worker id> < message
  ${CLI} status [words]

start: workers run in Claude Code with this chat's model unless --model names another.
--cwd is the folder of the repository the task belongs to (see /home/lepton/infra/apps/REGISTRY.md;
host/server config is /home/lepton/infra); ask the owner if it is unclear.
After starting, give the owner the link and end your turn: the worker's report arrives in this chat.

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
			const parentModel = chatModel();
			const claude = model
				? CLAUDE_MODES.includes(model.toLowerCase())
					? model.toLowerCase()
					: undefined
				: env("ACB_CLAUDE_MODE");
			const [provider, ...rest] = (model && !claude ? model : "").split("/");
			const record = await startWorker(acb, {
				title,
				task,
				cwd,
				parentSessionId: env("ACB_CHAT_ID"),
				parentModel,
				workerModel: provider
					? { provider, modelId: rest.join("/"), thinkingLevel: parentModel.thinkingLevel }
					: parentModel,
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
