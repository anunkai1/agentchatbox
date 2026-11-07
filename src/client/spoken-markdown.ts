import { marked } from "marked";
import { SpokenSentences } from "../shared/spoken-sentences.js";
import { markdownToSpeechText } from "./markdown.js";

/** Render before sentence splitting: a sentence can end inside bold, a link or a fence. */
export class SpokenMarkdown {
	private source = "";
	private emitted = "";

	push(delta: string, final = false): string[] {
		this.source += delta;
		if (!final && this.incomplete()) return [];
		const text = markdownToSpeechText(this.source).replace(/\s+/g, " ").trim();
		// Never replay or silently revise speech if later Markdown changes its meaning.
		if (!text.startsWith(this.emitted)) {
			throw new Error(
				"Speech formatting changed earlier text. Read the saved answer; remaining speech was stopped.",
			);
		}
		const tail = text.slice(this.emitted.length);
		const chunks = new SpokenSentences().push(tail + (/\s$/.test(this.source) ? " " : ""), final);
		let consumed = 0;
		for (const chunk of chunks) consumed = tail.indexOf(chunk, consumed) + chunk.length;
		this.emitted = text.slice(0, this.emitted.length + consumed);
		return chunks;
	}

	private incomplete(): boolean {
		// An ordered-list prefix is not a spoken sentence ("1. ").
		if (/(?:^|\n) {0,3}(?:[-+*]|\d+[.)])\s*$/.test(this.source)) return true;
		let pending = false;
		marked.walkTokens(marked.lexer(this.source), (token) => {
			if (token.type === "text" && !token.tokens?.length) {
				// Parsed emphasis/links have child tokens. Literal markers in a leaf
				// can still become markup when the next delta arrives; wait for it.
				if (/[*`[<|~]|(?:^|\W)_{1,3}(?=\S)|_{1,3}$/.test(token.raw)) pending = true;
			}
			if (token.type === "code") {
				const opener = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw);
				if (!opener) return;
				const lines = token.raw.trimEnd().split("\n");
				const closing = new RegExp(`^${opener[1][0]}{${opener[1].length},}$`);
				if (lines.length < 2 || !closing.test(lines.at(-1)!.trim())) pending = true;
			}
		});
		return pending;
	}
}
