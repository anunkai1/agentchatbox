/** Opt-in backend protocol; ordinary chat TTS never negotiates these frames. */
export const KOKORO_ALIGNMENT = "kokoro-pred-dur-v1";
export interface KokoroWord {
	text: string;
	whitespace: string;
	startSample: number;
	endSample: number;
}
export interface KokoroAlignment {
	alignment: typeof KOKORO_ALIGNMENT;
	sampleRate: 24000;
	submittedText: string;
	text: string;
	startSample: number;
	endSample: number;
	words: KokoroWord[];
	alignmentComplete: boolean;
	unalignedTokens: string[];
}
