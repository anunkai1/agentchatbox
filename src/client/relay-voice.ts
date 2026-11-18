/** Encode a browser voice input or playback receipt for the Pi journal. */
export function encodeRelayVoice(payload: object): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
