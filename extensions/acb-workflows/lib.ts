export interface WorkflowCommand {
	name: string;
	description: string;
	usage?: string;
	buildPrompt(args: string): string;
}

/**
 * Agent-facing workflows shared by every pi client. ACB may render shortcuts
 * for a subset, but the prompts themselves belong here rather than in browser
 * code so terminal/RPC clients execute the same behavior.
 */
export const WORKFLOW_COMMANDS: readonly WorkflowCommand[] = [
	{
		name: "where",
		description: "Show where this session is working: machine, directory and repo",
		buildPrompt: () =>
			"Where am I working? Tell me the machine, the working directory and the repository (with its remote), and which project instruction files apply here.",
	},
	{
		name: "abilities",
		description: "Summarise the tools, skills and models available in this session",
		buildPrompt: () =>
			"What are your abilities in this session? Summarise your tools, skills, extensions, models and slash commands.",
	},
	{
		name: "infra",
		description: "Describe the infrastructure: servers, hosted apps, backups and docs",
		buildPrompt: () =>
			"Tell me about my infrastructure: the servers, hosted apps and backups, and where the operational documentation lives (/home/lepton/infra/docs/).",
	},
	{
		name: "research",
		description: "Search the web and return a concise sourced summary: /research <query>",
		usage: "/research <query> (ACB alias: /websearch <query>)",
		buildPrompt: (args) =>
			args
				? `Use web_search to look up: ${args}\nGive me a 3-sentence summary plus the top 3 source URLs.`
				: "",
	},
	{
		name: "fetch",
		description: "Fetch and summarize a URL: /fetch <url>",
		usage: "/fetch <url>",
		buildPrompt: (args) =>
			args
				? `Use fetch_content to grab ${args} and summarise the key points in 5 bullet points.`
				: "",
	},
	{
		name: "codesearch",
		description: "Find sourced code examples: /codesearch <query>",
		usage: "/codesearch <query>",
		buildPrompt: (args) =>
			args
				? `Use web_search to find authoritative code examples for: ${args}\nPrioritize official documentation and GitHub sources. Give me 2 short code snippets with source URLs.`
				: "",
	},
];

export function workflowByName(name: string): WorkflowCommand | undefined {
	return WORKFLOW_COMMANDS.find((command) => command.name === name);
}
