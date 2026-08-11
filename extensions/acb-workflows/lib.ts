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
		name: "design",
		description: "Design and build a small interactive web experience",
		buildPrompt: () =>
			"Design and build a small interactive web page for me. Pick the layout, colors, and copy.",
	},
	{
		name: "fullstack",
		description: "Plan and scaffold a complete small full-stack application",
		buildPrompt: () =>
			"Help me build a small full-stack web app: pick a stack, sketch the data model, and scaffold the project.",
	},
	{
		name: "writing",
		description: "Start a structured writing and editing workflow",
		buildPrompt: () =>
			"Help me write a clear, well-structured piece on a topic of my choosing. Ask me what the topic is first.",
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
