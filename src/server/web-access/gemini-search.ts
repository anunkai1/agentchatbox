import { activityMonitor } from "./activity.js";
import { getApiKey, API_BASE, DEFAULT_MODEL } from "./gemini-api.js";
import { hasExaApiKey, isExaAvailable, searchWithExa } from "./exa.js";

// Vendored from pi-web-access (MIT, Nico Bailon). Edits:
//   - Removed Perplexity provider (paid-only, out of project scope).
//   - Removed Gemini Web provider (needs browser cookies, out of scope).
//   - Default fallback chain: exa → gemini (if API key set) → exa (no key path).
//   - Reads config from process.env / agentchatbox .env instead of ~/.pi/web-search.json.

export type SearchProvider = "auto" | "exa" | "gemini";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface AttributedSearchResponse {
	answer: string;
	results: SearchResult[];
	provider: ResolvedSearchProvider;
	inlineContent?: Array<{ title: string; url: string; content: string }>;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
}

export interface SearchOptions {
	query?: string;
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

export interface SearchResponse {
	/** Inline page content from a search provider, when `includeContent: true` is requested. */
	inlineContent?: Array<{ title: string; url: string; content: string }>;
	answer: string;
	results: SearchResult[];
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function resolveProvider(): SearchProvider {
	const fromEnv = (process.env.WEB_SEARCH_PROVIDER ?? "auto").trim().toLowerCase();
	if (fromEnv === "exa" || fromEnv === "gemini" || fromEnv === "auto") return fromEnv;
	return "auto";
}

function resolveSearchModel(): string {
	return (process.env.WEB_SEARCH_MODEL ?? "").trim() || DEFAULT_MODEL;
}

async function searchWithGemini(query: string, options: SearchOptions): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		const model = resolveSearchModel();
		const body = {
			contents: [{ parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.any([
				AbortSignal.timeout(60000),
				...(options.signal ? [options.signal] : []),
			]),
		});

		if (!res.ok) {
			const errorText = await res.text();
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = (await res.json()) as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer = data.candidates?.[0]?.content?.parts
			?.map(p => p.text)
			.filter(Boolean)
			.join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);

		if (!answer && results.length === 0) return null;
		return { answer, results };
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw err;
	}
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const provider = options.provider ?? resolveProvider();
	const errors: string[] = [];

	// Explicit provider chosen
	if (provider === "gemini") {
		try {
			const result = await searchWithGemini(query, options);
			if (result) return { ...result, provider: "gemini" };
			throw new Error(
				"Gemini search unavailable. Set GEMINI_API_KEY in env or .env."
			);
		} catch (err) {
			if (isAbortError(err)) throw err;
			throw new Error(`Gemini: ${errorMessage(err)}`);
		}
	}

	if (provider === "exa") {
		if (!isExaAvailable()) {
			throw new Error(
				"Exa search unavailable. Set EXA_API_KEY in env or .env. " +
					"(Exa MCP zero-config path requires a Node 22+ runtime that supports SSE; " +
					"if that fails, provide the API key.)"
			);
		}
		const exaApiKeyConfigured = hasExaApiKey();
		try {
			const result = await searchWithExa(query, options);
			if (result && "exhausted" in result) {
				throw new Error(
					"Exa monthly free tier exhausted (1,000 requests). Resets next month. " +
						"Use provider: 'gemini', or upgrade at exa.ai/pricing"
				);
			}
			if (result && "answer" in result) return { ...result, provider: "exa" };
			if (exaApiKeyConfigured) throw new Error("Exa search returned no results.");
		} catch (err) {
			if (isAbortError(err)) throw err;
			if (exaApiKeyConfigured) throw err;
			errors.push(`Exa (no key): ${errorMessage(err)}`);
		}
	}

	// Auto mode: try Exa first (zero-config via MCP), then Gemini if keyed.
	if (isExaAvailable()) {
		try {
			const result = await searchWithExa(query, options);
			if (result && "answer" in result) return { ...result, provider: "exa" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			errors.push(`Exa: ${errorMessage(err)}`);
		}
	}

	try {
		const geminiResult = await searchWithGemini(query, options);
		if (geminiResult) return { ...geminiResult, provider: "gemini" };
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini: ${errorMessage(err)}`);
	}

	if (errors.length > 0) {
		throw new Error(
			`No web search provider succeeded:\n  - ${errors.join("\n  - ")}\n\n` +
				`Set EXA_API_KEY or GEMINI_API_KEY in your env (or agentchatbox .env file) to enable search.`
		);
	}

	throw new Error(
		"No web search provider available. Set EXA_API_KEY or GEMINI_API_KEY in your env " +
			"(or agentchatbox .env file) to enable search."
	);
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
			const resolved = await resolveRedirect(url, signal);
			if (resolved) url = resolved;
		}

		if (url) results.push({ title, url });
	}
	return results;
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
