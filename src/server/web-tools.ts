/**
 * Web access tools for the agent. Vendored from `pi-web-access`
 * (MIT, Nico Bailon) — see src/server/web-access/ATTRIBUTION.md.
 *
 * Three tools:
 *   - web_search:   query the web via Exa (zero-config MCP) or Gemini API.
 *   - fetch_content: extract readable markdown from a URL (HTML, PDF,
 *                    YouTube, GitHub repo, local video).
 *   - code_search:  code-focused search via Exa MCP code-context tool.
 *
 * Exa zero-config path needs no API key. Gemini path needs GEMINI_API_KEY
 * (and the underlying gemini-2.5-flash model supports google_search grounding,
 * which gives us real search results for free within the API quota).
 *
 * These run server-side. The model gets back the answer + a list of
 * source URLs and decides what to do with them.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { search } from "./web-access/gemini-search.js";
import { extractContent } from "./web-access/extract.js";
import { executeCodeSearch } from "./web-access/code-search.js";
import { errContent, ok, text, ToolError } from "./tool-utils.js";

function formatSearchOutput(query: string, response: {
	answer: string;
	results: Array<{ title: string; url: string }>;
	provider: string;
	inlineContent?: Array<{ title: string; url: string; content: string }>;
}): string {
	const lines: string[] = [];
	lines.push(`**Search** (${response.provider}): ${query}`);
	lines.push("");
	if (response.answer) {
		lines.push(response.answer);
		lines.push("");
	}
	if (response.results.length > 0) {
		lines.push("---");
		lines.push("");
		lines.push("**Sources:**");
		lines.push("");
		response.results.forEach((r, i) => {
			lines.push(`${i + 1}. [${r.title}](${r.url})`);
		});
		lines.push("");
	}
	if (response.inlineContent?.length) {
		lines.push("---");
		lines.push("");
		lines.push("**Fetched content:**");
		lines.push("");
		for (const item of response.inlineContent) {
			lines.push(`### ${item.title}`);
			lines.push(item.url);
			lines.push("");
			lines.push(item.content);
			lines.push("");
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query. Be specific — what would you type into a search engine?" }),
	numResults: Type.Optional(
		Type.Integer({
			description: "How many sources to return. Default 5, max 20.",
			minimum: 1,
			maximum: 20,
		}),
	),
	recencyFilter: Type.Optional(
		Type.String({
			description: "Time bound: 'day', 'week', 'month', or 'year'.",
			enum: ["day", "week", "month", "year"],
		}),
	),
	domainFilter: Type.Optional(
		Type.Array(Type.String(), {
			description: "Limit results to these domains. Prefix with '-' to exclude. E.g. ['github.com', '-stackoverflow.com'].",
		}),
	),
	provider: Type.Optional(
		Type.String({
			description: "Search provider override. 'exa' (zero-config via MCP, or direct API if EXA_API_KEY is set), 'gemini' (uses GEMINI_API_KEY with Google search grounding), or 'auto' (default — tries exa first then gemini).",
			enum: ["auto", "exa", "gemini"],
		}),
	),
	includeContent: Type.Optional(
		Type.Boolean({
			description: "If true, fetch the full content of each result page alongside the search. Default false.",
		}),
	),
});

interface WebSearchDetails {
	query: string;
	provider: string;
	numResults: number;
	resultsCount: number;
}

export const webSearchTool: AgentTool<typeof webSearchSchema, WebSearchDetails> = {
	name: "web_search",
	label: "Web search",
	description:
		"Search the web and return a synthesized answer with source citations. " +
		"Default provider is 'auto' — Exa (zero-config via MCP, no API key required) with a fallback to Gemini's " +
		"google-search grounding if GEMINI_API_KEY is set. " +
		"Use this for any question about current events, libraries, APIs, documentation, or anything that needs up-to-date information. " +
		"Returns the answer text plus a list of source URLs. For a single URL's content, use fetch_content instead.",
	parameters: webSearchSchema,
	execute: async (_toolCallId, params) => {
		const args = params as {
			query: string;
			numResults?: number;
			recencyFilter?: "day" | "week" | "month" | "year";
			domainFilter?: string[];
			provider?: "auto" | "exa" | "gemini";
			includeContent?: boolean;
		};

		if (!args.query || args.query.trim().length === 0) {
			throw new ToolError("query is required");
		}

		try {
			const result = await search(args.query, {
				numResults: args.numResults,
				recencyFilter: args.recencyFilter,
				domainFilter: args.domainFilter,
				provider: args.provider,
				includeContent: args.includeContent,
			});

			const output = formatSearchOutput(args.query, {
				answer: result.answer,
				results: result.results,
				provider: result.provider,
				inlineContent: result.inlineContent,
			});

			const details: WebSearchDetails = {
				query: args.query,
				provider: result.provider,
				numResults: args.numResults ?? 5,
				resultsCount: result.results.length,
			};

			return ok([text(output || "No results found.")], details);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			throw new ToolError(`web_search failed: ${message}`);
		}
	},
};

// ---------------------------------------------------------------------------
// fetch_content
// ---------------------------------------------------------------------------

const fetchContentSchema = Type.Object({
	url: Type.String({
		description: "The URL to fetch. Supports HTTP(S) pages, GitHub repos, YouTube videos, PDF links, and local video file paths (with /, ./, ../, or file:// prefix).",
	}),
	prompt: Type.Optional(
		Type.String({
			description: "For YouTube or local video URLs: a question to ask about the content (e.g. 'What libraries are shown?', 'Summarise the talk'). Ignored for HTML pages.",
		}),
	),
	timestamp: Type.Optional(
		Type.String({
			description: "For video URLs: extract frame(s) at this time. Single ('23:41'), range ('23:41-25:00'), or seconds ('85'). Requires ffmpeg (and yt-dlp for YouTube).",
		}),
	),
	frames: Type.Optional(
		Type.Integer({
			description: "For video URLs: how many frames to sample. Default 1 for a single timestamp, 6 for a range, up to 12.",
			minimum: 1,
			maximum: 12,
		}),
	),
});

interface FetchContentDetails {
	url: string;
	title: string;
	bytes: number;
	kind: "html" | "github" | "youtube" | "pdf" | "video" | "markdown" | "json" | "text" | "unknown";
}

export const fetchContentTool: AgentTool<typeof fetchContentSchema, FetchContentDetails> = {
	name: "fetch_content",
	label: "Fetch URL",
	description:
		"Fetch a URL and extract its readable content as markdown. " +
		"Routes automatically: HTML pages get extracted via Readability+Turndown, GitHub URLs are cloned locally, " +
		"YouTube URLs go through Gemini for visual understanding (transcript + frame descriptions), " +
		"PDFs are text-extracted and saved to ~/Downloads/, local video files are uploaded to Gemini Files API. " +
		"Blocked pages retry via Jina Reader and Gemini URL context. " +
		"Use this when you need to read a specific page, doc, or video — not for general search (use web_search for that).",
	parameters: fetchContentSchema,
	execute: async (_toolCallId, params) => {
		const args = params as {
			url: string;
			prompt?: string;
			timestamp?: string;
			frames?: number;
		};

		if (!args.url || args.url.trim().length === 0) {
			throw new ToolError("url is required");
		}

		try {
			const result = await extractContent(args.url, undefined, {
				prompt: args.prompt,
				timestamp: args.timestamp,
				frames: args.frames,
			});

			if (result.error && !result.content) {
				throw new ToolError(result.error);
			}

			let kind: FetchContentDetails["kind"] = "unknown";
			const lower = result.url.toLowerCase();
			if (lower.includes("github.com") || lower.includes("githubusercontent.com")) kind = "github";
			else if (lower.includes("youtube.com") || lower.includes("youtu.be")) kind = "youtube";
			else if (lower.includes(".pdf")) kind = "pdf";
			else if (/\.(mp4|mov|webm|avi|mkv)$/i.test(lower)) kind = "video";
			else if (lower.endsWith(".md") || lower.endsWith(".markdown")) kind = "markdown";
			else if (lower.endsWith(".json")) kind = "json";
			else if (/\.(txt|log|csv|tsv)$/i.test(lower)) kind = "text";
			else kind = "html";

			const output = [
				`# ${result.title || result.url}`,
				"",
				`URL: ${result.url}`,
				`Kind: ${kind}`,
				"",
				"---",
				"",
				result.content || "(empty)",
			].join("\n");

			const details: FetchContentDetails = {
				url: result.url,
				title: result.title,
				bytes: result.content.length,
				kind,
			};

			return ok([text(output)], details);
		} catch (e) {
			if (e instanceof ToolError) throw e;
			const message = e instanceof Error ? e.message : String(e);
			throw new ToolError(`fetch_content failed: ${message}`);
		}
	},
};

// ---------------------------------------------------------------------------
// code_search
// ---------------------------------------------------------------------------

const codeSearchSchema = Type.Object({
	query: Type.String({
		description: "Programming question, library, API, or debugging topic. Be specific — e.g. 'React useEffect cleanup pattern' or 'Express middleware error handling'.",
	}),
	maxTokens: Type.Optional(
		Type.Integer({
			description: "Approximate max tokens of context to return. Default 5000, max 50000.",
			minimum: 1000,
			maximum: 50000,
		}),
	),
});

interface CodeSearchDetails {
	query: string;
	maxTokens: number;
	bytes: number;
}

export const codeSearchTool: AgentTool<typeof codeSearchSchema, CodeSearchDetails> = {
	name: "code_search",
	label: "Code search",
	description:
		"Search the web for code examples, API references, and library documentation. " +
		"Uses Exa's code-context MCP tool when available (no API key required) and falls back to a code-focused web search otherwise. " +
		"Returns synthesized context with code snippets and source URLs. " +
		"Prefer this over web_search for programming questions — it's tuned for code/docs. " +
		"For full source files or repo contents, use fetch_content with a GitHub URL.",
	parameters: codeSearchSchema,
	execute: async (_toolCallId, params) => {
		const args = params as { query: string; maxTokens?: number };

		if (!args.query || args.query.trim().length === 0) {
			throw new ToolError("query is required");
		}

		const maxTokens = args.maxTokens ?? 5000;

		try {
			const result = await executeCodeSearch("tool-call", { query: args.query, maxTokens }, undefined);
			const resultText = result.content?.[0]?.text ?? "(no results)";
			const details: CodeSearchDetails = {
				query: args.query,
				maxTokens,
				bytes: resultText.length,
			};
			return ok([text(resultText)], details);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			throw new ToolError(`code_search failed: ${message}`);
		}
	},
};
