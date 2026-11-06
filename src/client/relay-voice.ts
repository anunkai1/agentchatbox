/** Same-origin UI transport only; Pi owns prompts, authority, queues and work. */
import type { RelayVoiceConfig } from "../shared/relay.js";
import { el, uuid } from "./dom.js";

export class RelayVoiceFrame {
	readonly element = el("iframe", {
		title: "Server4 Relay voice",
		src: "/experiments/lfm-voice/?relay=1",
		allow: "microphone; autoplay",
		class: "relay-local-voice",
	});
	private config?: RelayVoiceConfig;
	private loaded = false;
	private closed = false;
	private requests = new Set<string>();
	private errors = new Set<string>();
	private timeout = setTimeout(
		() =>
			this.status(
				"Server4 voice page did not load. Check your login/Server4 connection, or explicitly choose legacy voice.",
			),
		15_000,
	);
	constructor(
		private command: (action: string, id: string, payload: object) => void,
		private status: (text: string) => void,
	) {
		window.addEventListener("message", this.receive);
	}
	private post(payload: object): void {
		if (!this.closed)
			this.element.contentWindow?.postMessage({ source: "acb-relay", ...payload }, location.origin);
	}
	private receive = (event: MessageEvent) => {
		if (
			this.closed ||
			event.origin !== location.origin ||
			event.source !== this.element.contentWindow ||
			event.data?.source !== "lfm-relay"
		)
			return;
		const message = event.data;
		if (message.type === "loaded") {
			this.loaded = true;
			clearTimeout(this.timeout);
			if (this.config) this.post({ type: "configure", config: this.config });
		} else if (message.type === "refresh") {
			this.command("voice-config", uuid(), {});
		} else if (["relay_context", "relay_heard", "relay_request"].includes(message.type)) {
			if (typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id)) return;
			if (message.type === "relay_request") {
				this.requests.add(message.id);
				this.command("voice-request", message.id, {});
				this.status("Request handed to Pi Relay. Voice interruption does not cancel work.");
			} else if (
				typeof message.text === "string" &&
				message.text.length <= (message.type === "relay_context" ? 4000 : 16000)
			) {
				this.command(
					message.type === "relay_context" ? "voice-context" : "voice-heard",
					message.id,
					{ text: message.text },
				);
			}
		} else if (message.type === "unspoken") {
			if (!this.errors.delete(String(message.id ?? "")))
				this.status("Relay update is in the saved chat; old speech will not be replayed.");
		} else if (message.type === "closed") this.status("Local voice closed; Pi work continues.");
	};
	configure(config: RelayVoiceConfig): void {
		this.config = config;
		if (this.loaded) this.post({ type: "configure", config });
	}
	result(value: { id: string; text: string; error?: boolean; report?: boolean }): void {
		if (value.error) this.errors.add(value.id);
		this.post({
			type: "result",
			result: {
				id: value.id,
				text: value.text,
				...(value.report || !this.requests.has(value.id) ? { report: true } : {}),
			},
		});
		this.requests.delete(value.id);
	}
	interrupt(): void {
		this.post({ type: "interrupt" });
	}
	stop(): void {
		this.post({ type: "close" });
	}
	dispose(): void {
		this.stop();
		this.closed = true;
		clearTimeout(this.timeout);
		window.removeEventListener("message", this.receive);
		this.requests.clear();
		this.errors.clear();
		this.element.src = "about:blank";
	}
}

export function encodeRelayVoice(payload: object): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
