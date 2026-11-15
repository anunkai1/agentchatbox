/** Opt-in backend protocol; ordinary chat TTS never negotiates these frames. */
export const KOKORO_ALIGNMENT = "kokoro-pred-dur-v1";
export const ZONOS3_ALIGNMENT = "zonos3-probe-v1";
export const ZONOS3_SAMPLE_RATE = 44_100;
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
export interface Zonos3Alignment {
	alignment: typeof ZONOS3_ALIGNMENT;
	sampleRate: typeof ZONOS3_SAMPLE_RATE;
	submittedText: string;
	text: string;
	startSample: number;
	endSample: number;
	words: KokoroWord[];
	alignmentComplete: boolean;
	unalignedTokens: string[];
}
export type RelaySynthesisAlignment = KokoroAlignment | Zonos3Alignment;
