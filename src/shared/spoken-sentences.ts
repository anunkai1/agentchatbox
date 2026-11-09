/** Small bounded speech chunks, without splitting decimals or normal abbreviations. */
export class SpokenSentences {
	private pending = "";
	constructor(private first = true) {}
	push(delta: string, final = false): string[] {
		this.pending += delta;
		const sentences: string[] = [];
		while (this.pending.length) {
			let boundary = 0;
			const re = /[.!?](?:["”'])?\s+/g;
			for (const match of this.pending.matchAll(re)) {
				const prefix = this.pending.slice(0, match.index + 1);
				if (/\b(?:Mr|Mrs|Ms|Dr|St|e\.g|i\.e)\.$/i.test(prefix)) continue;
				boundary = match.index + match[0].length;
				break;
			}
			if (!boundary && this.first && this.pending.length >= 36) {
				for (const match of this.pending.matchAll(/[,;:—–]\s+/g)) {
					if (match.index + 1 >= 36) {
						boundary = match.index + match[0].length;
						break;
					}
				}
			}
			if (!boundary && this.pending.length > 220) {
				boundary = this.pending.lastIndexOf(" ", 220);
				if (boundary < 1) boundary = 220;
			}
			if (!boundary && final) boundary = this.pending.length;
			if (!boundary) break;
			const text = this.pending.slice(0, boundary).trim();
			this.pending = this.pending.slice(boundary);
			if (text) {
				this.first = false;
				sentences.push(text);
			}
		}
		return sentences;
	}
}
