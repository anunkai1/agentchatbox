/** Voice-test UI only. The dedicated Pi session owns the model, prompt and history. */
import { VOICE_TEST_MESSAGE, type VoiceTestEvent } from "../shared/voice-test.js";
import { transcribeAudio } from "./api.js";
import { el, mountModal, uuid } from "./dom.js";
import { state } from "./state.js";
import {
	ConversationSpeaker,
	cancelVoiceRecord,
	captureConversation,
	stopAllVoice,
} from "./voice.js";

let opened = false;

export function isVoiceTestOpen(): boolean {
	return opened;
}

export function openVoiceTest(): void {
	if (opened) return;
	opened = true;
	cancelVoiceRecord();
	stopAllVoice();
	const heading = el("h2", {}, "Browser voice test");
	const intro = el(
		"p",
		{},
		"Local speech-to-text → Venice DeepSeek → local Kokoro. No phone calls or action tools. Text goes to Venice; audio is processed locally and is not saved. The transcript is saved as a separate ACB chat.",
	);
	const status = el("p", { role: "status", class: "voice-test-status" }, "Connecting…");
	const model = el("p", { class: "voice-test-model" });
	const metrics = el("p", { class: "voice-test-metrics", "aria-live": "polite" });
	const transcript = el("div", {
		class: "voice-test-transcript",
		role: "log",
		"aria-label": "Voice test transcript",
	});
	const start = el("button", { type: "button", disabled: true }, "Start microphone");
	const interrupt = el("button", { type: "button", disabled: true }, "Interrupt");
	const finish = el("button", { type: "button", disabled: true }, "End test & summarise");
	const input = el("input", {
		type: "text",
		placeholder: "Or type a test message",
		"aria-label": "Voice test message",
		maxLength: 4000,
	});
	const send = el("button", { type: "submit", disabled: true }, "Send text");
	const form = el("form", { class: "voice-test-form" }, input, send);
	const link = el(
		"a",
		{ hidden: true, target: "_blank", rel: "noopener" },
		"Open saved transcript",
	);
	const box = el(
		"div",
		{ class: "modal voice-test" },
		heading,
		intro,
		el(
			"p",
			{},
			"Use headphones to prevent speaker echo triggering interruptions. Replies shown below are generated text, not proof that every word was heard.",
		),
		model,
		status,
		metrics,
		el("div", { class: "voice-test-controls" }, start, interrupt, finish),
		form,
		transcript,
		link,
	);
	const overlay = el("div", { class: "modal-overlay" }, box);
	let dismissed = false;
	let ending = false;
	let failed = false;
	let ready = false;
	let transportReady = false;
	let extensionAvailable = false;
	let startSent = false;
	let currentTurn = "";
	let speechEpoch = 0;
	let endedAt = 0;
	let sttMs = 0;
	let firstTextMs = 0;
	let stopCapture: (() => void) | null = null;
	let sttController: AbortController | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	let micPending = false;
	let lastWireAt = Date.now();
	const rows = new Map<string, HTMLElement>();
	const socket = new WebSocket(
		`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/chat`,
	);
	const sayStatus = (text: string) => {
		status.textContent = text;
	};
	const fail = (error: unknown) => {
		failed = true;
		sayStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
	};
	const speaker = new ConversationSpeaker(
		() => {
			if (endedAt)
				metrics.textContent = `Local STT ${sttMs.toFixed(0)} ms · model first text ${firstTextMs.toFixed(0)} ms · speech end to first audio ${(performance.now() - endedAt).toFixed(0)} ms`;
			sayStatus("Speaking — you can interrupt");
		},
		() => {
			if (!ending)
				sayStatus(stopCapture ? "Listening…" : "Ready — start the microphone or send text");
		},
		fail,
	);
	const command = (text: string) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "prompt", text }));
	};
	const cancelAudio = () => {
		speechEpoch++;
		sttController?.abort();
		sttController = null;
		speaker.stop();
		currentTurn = "";
		if (ready && !ending) command("/voicetest interrupt");
	};
	const addText = (label: string, text: string) => {
		const row = el("p", {}, el("strong", {}, `${label}: `), text);
		transcript.append(row);
		row.scrollIntoView({ block: "nearest" });
		return row;
	};
	const releaseMic = () => {
		stopCapture?.();
		stopCapture = null;
		sttController?.abort();
		sttController = null;
		speechEpoch++;
	};
	const closeSocket = () => {
		clearTimeout(startupTimer);
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = null;
		socket.close();
	};
	const end = () => {
		if (ending) return;
		ending = true;
		releaseMic();
		speaker.stop();
		start.disabled = send.disabled = interrupt.disabled = finish.disabled = true;
		sayStatus("Saving summary…");
		if (ready) {
			command("/voicetest stop");
			closeTimer = setTimeout(() => {
				sayStatus(
					link.hidden ? "Summary timed out." : "Summary timed out; transcript remains saved.",
				);
				closeSocket();
			}, 35_000);
		} else closeSocket();
	};
	const dispose = () => {
		if (dismissed) return;
		dismissed = true;
		opened = false;
		end();
		speaker.close();
		clearInterval(watchdog);
		window.removeEventListener("pagehide", unload);
		document.removeEventListener("visibilitychange", visibility);
	};
	const unload = () => {
		dispose();
		closeSocket();
	};
	const visibility = () => {
		// Never leave a hidden tab listening; resuming the mic needs another click.
		if (document.visibilityState === "hidden") {
			releaseMic();
			cancelAudio();
			start.textContent = "Start microphone";
			if (!ending) sayStatus("Microphone paused while tab is hidden");
		}
	};
	const startupTimer = setTimeout(() => {
		if (!ready) {
			fail(new Error("Voice extension did not become ready. Deploy it, then reopen the test."));
			closeSocket();
		}
	}, 20_000);
	const watchdog = setInterval(() => {
		if (Date.now() - lastWireAt > 45_000 && !ending) {
			fail(new Error("Connection lost; microphone stopped. Reopen the test to continue."));
			end();
		}
	}, 5_000);
	window.addEventListener("pagehide", unload);
	document.addEventListener("visibilitychange", visibility);
	mountModal(overlay, box, { onDismiss: dispose, initialFocus: input });

	function say(text: string): void {
		if (!ready || ending || !text.trim()) return;
		currentTurn = uuid();
		firstTextMs = 0;
		sayStatus("Waiting for DeepSeek…");
		command(`/voicetest say ${currentTurn} ${text}`);
	}

	start.onclick = async () => {
		if (stopCapture) {
			releaseMic();
			cancelAudio();
			start.textContent = "Start microphone";
			sayStatus("Microphone stopped");
			return;
		}
		if (micPending || ending) return;
		micPending = true;
		try {
			const stop = await captureConversation(
				() => {
					cancelAudio();
					sayStatus("Hearing speech…");
				},
				(audio, speechEndedAt) => {
					const epoch = speechEpoch;
					const controller = new AbortController();
					sttController?.abort();
					sttController = controller;
					endedAt = speechEndedAt;
					const began = performance.now();
					sayStatus("Transcribing locally…");
					void transcribeAudio(
						audio,
						audio.type.includes("wav")
							? "voice.wav"
							: audio.type.includes("mp4")
								? "voice.m4a"
								: "voice.webm",
						controller.signal,
					)
						.then((text) => {
							if (controller.signal.aborted || epoch !== speechEpoch || ending || dismissed) return;
							sttMs = performance.now() - began;
							if (text.trim()) say(text);
							else sayStatus("No speech recognised — try again");
						})
						.catch((error: unknown) => {
							if (!controller.signal.aborted) fail(error);
						});
				},
				(error) => {
					releaseMic();
					start.textContent = "Start microphone";
					fail(error);
				},
			);
			if (ending || dismissed || document.visibilityState === "hidden") stop();
			else {
				stopCapture = stop;
				start.textContent = "Stop microphone";
				sayStatus("Listening…");
			}
		} catch (error) {
			fail(error);
		} finally {
			micPending = false;
		}
	};
	interrupt.onclick = () => {
		cancelAudio();
		sayStatus(stopCapture ? "Listening…" : "Interrupted");
	};
	finish.onclick = end;
	form.onsubmit = (event) => {
		event.preventDefault();
		const text = input.value.trim();
		if (!text || !ready || ending) return;
		cancelAudio();
		endedAt = performance.now();
		sttMs = 0;
		say(text);
		input.value = "";
	};

	socket.onopen = () =>
		socket.send(
			JSON.stringify({
				type: "init",
				provider: state.currentProvider,
				modelId: state.currentModelId,
				thinkingLevel: "off",
			}),
		);
	socket.onmessage = (message) => {
		lastWireAt = Date.now();
		const wire = JSON.parse(String(message.data));
		if (wire.type === "capabilities") {
			extensionAvailable = wire.commands.some(
				(entry: { name?: string }) => entry.name === "voicetest",
			);
			if (!extensionAvailable) {
				fail(new Error("Voice-test Pi extension is not installed. No prompt has been sent."));
				closeSocket();
				return;
			}
			if (transportReady && !startSent && !ending) {
				startSent = true;
				command("/voicetest start");
			}
			return;
		}
		if (wire.type === "ready") {
			if (ending) {
				closeSocket();
				return;
			}
			if (wire.sessionId) {
				link.href = `/s/${encodeURIComponent(wire.sessionId)}`;
			}
			transportReady = true;
			socket.send(JSON.stringify({ type: "getCapabilities" }));
			if (extensionAvailable && !startSent) {
				startSent = true;
				command("/voicetest start");
			}
			return;
		}
		if (wire.type === "error") {
			fail(new Error(wire.message));
			releaseMic();
			return;
		}
		if (wire.type !== "event") return;
		if (
			wire.event.type === "extension_ui_request" &&
			["select", "input", "confirm", "editor"].includes(wire.event.method)
		) {
			socket.send(
				JSON.stringify({ type: "extension_ui_response", id: wire.event.id, cancelled: true }),
			);
			fail(new Error("Unexpected extension dialog; use a normal chat to configure the provider."));
			return;
		}
		if (wire.event.type === "response" && wire.event.success === false) {
			fail(new Error(wire.event.error || "Voice command failed"));
			return;
		}
		if (wire.event.type !== "message_end" || wire.event.message?.customType !== VOICE_TEST_MESSAGE)
			return;
		const event = wire.event.message.details as VoiceTestEvent;
		if (event.kind === "ready") {
			clearTimeout(startupTimer);
			ready = true;
			model.textContent = event.model;
			start.disabled = send.disabled = interrupt.disabled = finish.disabled = false;
			sayStatus("Ready — start the microphone or send text");
		} else if (event.kind === "user") {
			link.hidden = !link.hasAttribute("href");
			addText("You", event.text);
		} else if (event.kind === "sentence") {
			const row = rows.get(event.turn) ?? addText("Assistant", "");
			if (!rows.has(event.turn)) rows.set(event.turn, row);
			row.append(`${row.childNodes.length > 1 ? " " : ""}${event.text}`);
			if (event.turn !== currentTurn || ending || dismissed) return;
			firstTextMs = event.firstTextMs;
			speaker.enqueue(event.text);
		} else if (event.kind === "done") {
			if (event.interrupted) rows.get(event.turn)?.append(" [interrupted]");
		} else if (event.kind === "summary") {
			addText("Summary", event.text);
		} else if (event.kind === "error") {
			addText("Error", event.text);
			fail(new Error(event.text));
		} else if (event.kind === "stopped") {
			sayStatus(
				link.hidden ? "Test ended; no conversation to save" : "Test ended; transcript saved",
			);
			closeSocket();
		}
	};
	socket.onerror = () => fail(new Error("Voice-test connection failed"));
	socket.onclose = () => {
		clearTimeout(startupTimer);
		ready = false;
		releaseMic();
		speaker.stop();
		start.disabled = send.disabled = interrupt.disabled = finish.disabled = true;
		if (!ending && !failed)
			sayStatus("Connection closed; microphone stopped. Reopen the test to continue.");
		clearInterval(watchdog);
	};
}
