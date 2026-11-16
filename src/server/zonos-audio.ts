/** Transport adapter: Zonos progressive mono PCM16 frames → ordinary chat WAVs. */
import { ZONOS3_SAMPLE_RATE } from "../shared/kokoro.js";

const MAX_FRAME = 10 * 1024 * 1024;

export function pcmWav(pcm: Uint8Array): Buffer {
	if (pcm.length % 2) throw new Error("Zonos PCM16 has an incomplete sample");
	const wav = Buffer.alloc(44 + pcm.length);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(36 + pcm.length, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(ZONOS3_SAMPLE_RATE, 24);
	wav.writeUInt32LE(ZONOS3_SAMPLE_RATE * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(pcm.length, 40);
	wav.set(pcm, 44);
	return wav;
}

export function audioFrame(type: number, payload: Uint8Array = new Uint8Array()): Buffer {
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = type;
	frame.writeUInt32LE(payload.length, 1);
	frame.set(payload, 5);
	return frame;
}

/** Bounded parser; rejects truncation/errors and cancels upstream on early exit. */
export async function* zonosPcm(response: Response): AsyncGenerator<Uint8Array> {
	if (
		response.headers.get("X-Audio-Format") !== "pcm16" ||
		response.headers.get("X-Audio-Sample-Rate") !== String(ZONOS3_SAMPLE_RATE) ||
		response.headers.get("X-Audio-Channels") !== "1"
	)
		throw new Error("Zonos must return mono 44.1 kHz PCM16");
	if (!response.body) throw new Error("Zonos returned no audio stream");
	const reader = response.body.getReader();
	let pending: Uint8Array = new Uint8Array();
	let hasAudio = false;
	const ensure = async (size: number): Promise<void> => {
		while (pending.length < size) {
			const { value, done } = await reader.read();
			if (done) throw new Error("Zonos stream ended before its END frame");
			const combined = new Uint8Array(pending.length + value.length);
			combined.set(pending);
			combined.set(value, pending.length);
			pending = combined;
		}
	};
	try {
		while (true) {
			await ensure(5);
			const type = pending[0];
			const size = new DataView(pending.buffer, pending.byteOffset + 1, 4).getUint32(0, true);
			if (size > MAX_FRAME) throw new Error("Zonos audio frame too large");
			await ensure(5 + size);
			const payload = pending.slice(5, 5 + size);
			pending = pending.subarray(5 + size);
			if (type === 0x00) {
				if (!hasAudio) throw new Error("Zonos returned no audio samples");
				return;
			}
			if (type === 0x80)
				throw new Error(new TextDecoder().decode(payload) || "Zonos synthesis failed");
			if (type === 0x01 && payload.length) {
				if (payload.length % 2) throw new Error("Zonos PCM16 has an incomplete sample");
				hasAudio = true;
				yield payload;
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
