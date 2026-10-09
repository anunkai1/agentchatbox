/**
 * Position maths for the seekable voice bar.
 *
 * Streamed TTS is a list of decoded chunks laid back to back, so an utterance
 * has its own clock ("utterance seconds", at the playback rate in force) that
 * is independent of the AudioContext clock. The AudioContext clock is only
 * contiguous while synthesis keeps ahead of playback — an underflow leaves a
 * gap — so the current position is found from the scheduled slots, not from
 * `currentTime - origin`.
 */

/** A decoded chunk's place on the utterance clock. */
export interface ChunkSpan {
	/** Utterance seconds at the chunk's first audible sample. */
	start: number;
	/** Audible seconds the chunk lasts at the playback rate. */
	play: number;
}

/** A chunk (or the tail of one, after a seek) scheduled on the AudioContext clock. */
export interface Slot {
	/** Utterance seconds at the slot's first sample. */
	start: number;
	/** AudioContext time the slot begins. */
	at: number;
	/** Audible seconds the slot lasts. */
	play: number;
}

/** Seconds of speech synthesized so far. */
export function bufferedSeconds(chunks: readonly ChunkSpan[]): number {
	const last = chunks.at(-1);
	return last ? last.start + last.play : 0;
}

/**
 * Where playback is on the utterance clock at AudioContext time `now`. Before the
 * first slot starts (just after a seek, or while paused) that is the slot's own
 * start; past the last slot's end (an underflow) it holds at that end.
 */
export function positionAt(slots: readonly Slot[], now: number): number {
	const first = slots[0];
	if (!first) return 0;
	let current = first;
	for (const slot of slots) {
		if (slot.at > now) break;
		current = slot;
	}
	if (now < current.at) return current.start;
	return current.start + Math.min(now - current.at, current.play);
}

/** Index of the chunk containing utterance time `t`, or -1 when `t` is past the end. */
export function chunkIndexAt(chunks: readonly ChunkSpan[], t: number): number {
	return chunks.findIndex((c) => t < c.start + c.play);
}

/** `m:ss` for a number of seconds (never negative). */
export function formatClock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
