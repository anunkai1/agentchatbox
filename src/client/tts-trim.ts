/**
 * Silence trimming for streamed TTS chunks.
 *
 * Kokoro hands back one padded WAV per synthesized text chunk: measured on this
 * box (24 kHz, af_heart) every chunk carries ~0.25-0.3s of near-silence before
 * its first phoneme and ~0.2-0.35s after its last. pi-voice-server adds none of
 * it — that is the model's own output, and the server deliberately adds no more
 * (see its "drop the baked-in chunk gaps" change).
 *
 * On a sample-accurate timeline those paddings are not a join problem: chunk N+1
 * starts exactly where N's samples end, so the two *files* are gapless. The
 * audible gap is inside the audio — N's trailing pad followed by N+1's leading
 * pad, i.e. 0.5-0.8s of dead air at every chunk boundary, plus a ~0.3s delay
 * before the first word of the utterance.
 *
 * That is worst exactly where the user notices it: the short spoken variant is
 * 2-3 sentences, and the streaming chunker's ramped policy sizes the opening
 * chunk from the FIRST SENTENCE alone, so a short reply is split one sentence
 * per chunk — a handful of seconds of speech carrying two or three 0.7s holes.
 *
 * So each chunk is trimmed before it is scheduled: leading silence is removed
 * (playback starts on the first phoneme) and trailing silence is cut back to a
 * single breath-sized join pause. The pause is kept rather than removed because
 * chunk boundaries are mostly sentence boundaries, and butting two sentences
 * together with no gap at all sounds clipped.
 *
 * Trimming is deliberately conservative: the silence floor is well below speech
 * level, the leading edge keeps a few milliseconds of pad so a soft word-initial
 * fricative can't be clipped, an all-silent chunk is played untouched rather
 * than removed, and a chunk whose audio is intact is returned as a no-op (the
 * only cost then is a scan).
 */

/** Everything this module needs from an AudioBuffer — keeps it unit-testable. */
export interface AudioBufferLike {
	readonly numberOfChannels: number;
	readonly sampleRate: number;
	readonly length: number;
	readonly duration: number;
	getChannelData(channel: number): Float32Array;
}

/**
 * RMS below this counts as silence. -45 dBFS is ~0.0056 linear: quiet enough to
 * sit under a breath or a room-tone tail, loud enough that no real phoneme —
 * including a trailing fricative — is mistaken for it.
 */
export const SILENCE_FLOOR_DBFS = -45;
const SILENCE_FLOOR = 10 ** (SILENCE_FLOOR_DBFS / 20);

/** Window (seconds) used to judge whether a slice of the buffer is silent. */
const SILENCE_WINDOW_S = 0.01;

/** Lead kept ahead of the detected first phoneme (seconds), anti-clipping. */
export const LEAD_KEEP_S = 0.03;

/**
 * Breath-sized pause kept at a chunk join (seconds). Chunk boundaries are mostly
 * sentence ends, so this is the "between sentences" beat the listener expects —
 * far shorter than the ~0.5-0.8s of model padding it replaces.
 */
export const CHUNK_JOIN_PAUSE_S = 0.2;

/** Never start later than this into a chunk (seconds), whatever the scan says. */
const MAX_LEAD_TRIM_S = 1;

/**
 * Where to start playing a chunk and how much of it to play, in BUFFER seconds
 * (the caller divides by its playback rate for context time).
 *
 *   offset   — seconds into the buffer to begin (leading silence removed)
 *   duration — seconds of audio to play from `offset` (trailing silence cut
 *              back to CHUNK_JOIN_PAUSE_S)
 *
 * A chunk that is entirely silent, or whose silence can't be located, is
 * returned as `{ offset: 0, duration: buffer.duration }` — playing it unchanged
 * is always safe, whereas trimming everything away would drop audio.
 */
export function trimChunkSilence(buffer: AudioBufferLike): { offset: number; duration: number } {
	const whole = { offset: 0, duration: buffer.duration };
	const { lead, trail } = silenceBounds(buffer);
	if (lead < 0 || trail < 0) return whole;

	// Keep a sliver of the leading pad: detection can land a millisecond or two
	// after the true onset, and starting exactly on a soft consonant clips it.
	const offset = Math.min(Math.max(0, lead - LEAD_KEEP_S), MAX_LEAD_TRIM_S);
	// Cut back to the join pause — never past the start of speech, and always
	// leaving a playable remainder.
	const endTrim = Math.max(0, trail - CHUNK_JOIN_PAUSE_S);
	const duration = buffer.duration - offset - endTrim;
	if (duration <= 0) return whole;
	return { offset, duration };
}

/**
 * Detected leading/trailing silence in seconds, or `{ lead: -1, trail: -1 }` when
 * the buffer contains no speech-level audio at all (the caller then plays it
 * unchanged). Silence is judged per 10ms window across channels — peak channel,
 * so a quiet channel can't mask a loud one.
 *
 * The scan walks whole windows and stops at the first window at or above the
 * floor, so `lead` is quantised to 10ms and can only ever under-report the true
 * silence — the safe direction, since the caller keeps a lead pad and cuts back
 * to a join pause rather than to zero.
 */
function silenceBounds(buffer: AudioBufferLike): { lead: number; trail: number } {
	const window = Math.max(1, Math.round(buffer.sampleRate * SILENCE_WINDOW_S));
	const windows = Math.floor(buffer.length / window);
	if (windows === 0) return { lead: -1, trail: -1 };

	const channels: Float32Array[] = [];
	for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

	const windowLevel = (index: number): number => {
		const start = index * window;
		let peak = 0;
		for (const data of channels) {
			let sum = 0;
			const end = Math.min(start + window, data.length);
			for (let i = start; i < end; i++) {
				const sample = data[i] ?? 0;
				sum += sample * sample;
			}
			const rms = Math.sqrt(sum / Math.max(1, end - start));
			if (rms > peak) peak = rms;
		}
		return peak;
	};

	let first = 0;
	while (first < windows && windowLevel(first) < SILENCE_FLOOR) first++;
	if (first >= windows) return { lead: -1, trail: -1 }; // nothing above the floor

	let last = windows - 1;
	while (last > first && windowLevel(last) < SILENCE_FLOOR) last--;

	return {
		lead: (first * window) / buffer.sampleRate,
		trail: ((windows - 1 - last) * window) / buffer.sampleRate,
	};
}
