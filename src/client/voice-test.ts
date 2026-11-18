/** Voice-test UI only. The dedicated Pi session owns the model, prompt and history. */
import type { ClientMessage } from "../shared/protocol.js";
import { RELAY_MESSAGE, type RelayEvent } from "../shared/relay.js";
import { VOICE_TEST_MESSAGE, type VoiceTestEvent } from "../shared/voice-test.js";
import { transcribeAudio } from "./api.js";
import { el, mountModal, uuid } from "./dom.js";
import {
	createKokoroSpeaker,
	createZonosSpeaker,
	formatKokoroPlayedHistory,
} from "./kokoro-tts.js";
import { setRichText } from "./linkify.js";
import type { PcmPlayedReport, PcmTtsSpeakerCallbacks, PcmUtteranceMetrics } from "./pcm-tts.js";
import { mountRelayDrawer, type RelayDrawer } from "./relay-drawer.js";
import { encodeRelayVoice } from "./relay-voice.js";
import {
	RELAY_VOICE_ENGINE_KEY,
	type RelayVoiceEngine,
	readVoicePreference,
	resolveRelayVoiceEngine,
	resolveTrialVoiceEngine,
	TRIAL_VOICE_ENGINE_KEY,
	type TrialVoiceEngine,
} from "./relay-voice-engine.js";
import { createRelayWakeLock } from "./relay-wake-lock.js";
import { type RelayChatBinding, services } from "./services.js";
import { SpokenMarkdown } from "./spoken-markdown.js";
import { state } from "./state.js";
import {
	type ConversationCapture,
	ConversationSpeaker,
	cancelVoiceRecord,
	captureConversation,
	stopAllVoice,
} from "./voice.js";

let opened = false;
let voiceActive = false;

/** Playback ownership, not historical Relay membership or drawer visibility. */
export function isVoiceTestActive(): boolean {
	return voiceActive;
}
let relayUi: { reveal(): void; end(): void; prepareTyped(): boolean } | null = null;

export function endRelayVoice(): void {
	relayUi?.end();
}
export function prepareRelayTypedInput(): boolean {
	return relayUi?.prepareTyped() ?? true;
}

export function isVoiceTestOpen(): boolean {
	return opened;
}

function messageText(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((b) => b?.type === "text")
		.map((b) => b.text ?? "")
		.join("");
}

const RELAY_SESSION_KEY = "acb-relay-session";
const TRIAL_SESSION_KEY = "acb-relay-trial-stream-session";

export type { RelayVoiceEngine } from "./relay-voice-engine.js";

export function openRelay(explicitEngine?: RelayVoiceEngine, forceNew = false): void {
	const engine = readVoicePreference(
		RELAY_VOICE_ENGINE_KEY,
		resolveRelayVoiceEngine,
		explicitEngine,
	);
	if (forceNew) {
		try {
			localStorage.removeItem(RELAY_SESSION_KEY);
		} catch {
			/* private mode */
		}
	}
	if ((explicitEngine || forceNew) && relayUi) relayUi.end();
	openVoiceTest(true, false, engine, undefined, forceNew);
}

export function openRelayTrial(explicitEngine?: TrialVoiceEngine): void {
	const engine = readVoicePreference(
		TRIAL_VOICE_ENGINE_KEY,
		resolveTrialVoiceEngine,
		explicitEngine,
	);
	openVoiceTest(true, true, engine);
}

export function openVoiceTest(
	relay = false,
	streamTrial = false,
	engine: RelayVoiceEngine = "legacy",
	workerStart?: string,
	forceNew = false,
): void {
	// An explicit test/trial request replaces attached voice controls, not Pi work.
	if ((!relay || streamTrial) && relayUi) relayUi.end();
	if (opened) {
		relayUi?.reveal();
		return;
	}
	const attached = relay && !streamTrial;
	const foregroundRelay = attached;
	const setWakeLock = foregroundRelay ? createRelayWakeLock() : undefined;
	const useKokoroTts = attached && engine === "kokoro";
	const useZonosTts = relay && engine === "zonos3";
	const useSpeechTts = useKokoroTts || useZonosTts;
	const isStreamingPi = streamTrial || useSpeechTts;
	const sessionKey = streamTrial ? TRIAL_SESSION_KEY : RELAY_SESSION_KEY;
	const control = relay ? "/relay" : "/voicetest";
	const startCommand = workerStart
		? `/relay start ${workerStart}`
		: relay && state.currentProvider && state.currentModelId
			? `/relay start ${state.currentProvider}/${state.currentModelId} ${state.currentThinking}`
			: `${control} start`;
	let savedSession: string | null = null;
	try {
		if (relay && !forceNew) savedSession = localStorage.getItem(sessionKey);
	} catch {
		/* private mode */
	}
	// If the user is in an existing chat with messages (or already viewing a Relay chat),
	// pressing R attaches Relay directly to this session from this point onwards.
	if (
		attached &&
		!forceNew &&
		state.sessionId &&
		(state.messages.length > 0 || savedSession === state.sessionId)
	) {
		savedSession = state.sessionId;
		try {
			localStorage.setItem(sessionKey, state.sessionId);
		} catch {
			/* private mode */
		}
	}
	let sessionId = savedSession;
	let capturedWorker: string | undefined;
	opened = true;
	voiceActive = true;
	cancelVoiceRecord();
	stopAllVoice();
	const heading = el(
		"h2",
		{ class: "voice-test-heading" },
		streamTrial ? "Trial A — streaming Pi voice" : relay ? "Relay" : "Browser voice test",
	);
	const intro = el(
		"p",
		{},
		relay
			? useZonosTts
				? "Pi + Server2 ZONOS3-Mini (default, aligned, speech-only): local STT → Pi → synthesis-aligned ZONOS3-Mini (Savannah). Server4 is not needed. Interrupt stops speech only; tools/workers continue. Saved playback retains only submitted input tokens whose end sample passed the output clock; pronunciation and hearing are not verified. No raw audio archive. Switch to Kokoro in voice settings."
				: useKokoroTts
					? "Pi + Server2 Kokoro (aligned, speech-only): local STT → Pi → synthesis-aligned Kokoro. Server4 is not needed. Interrupt stops speech only; tools/workers continue. Saved playback retains only submitted input tokens whose end sample passed the output clock; pronunciation and hearing are not verified. No raw audio archive. Switch back with /relay zonos3."
					: streamTrial
						? "Isolated trial: local STT → Pi → sentence-streamed Kokoro. Interrupt stops speech only; work continues. Playback records completed speech segments; the interrupted segment’s word boundary is unknown."
						: "Legacy STT/Kokoro Relay with normal owner-level tools and delegation. Closing voice leaves work running; Interrupt can stop direct tools, not workers. Text/tool context go to Venice; raw audio is not saved."
			: "Local speech-to-text → Venice DeepSeek → local Kokoro. No phone calls or action tools. Text goes to Venice; audio is processed locally and is not saved. The transcript is saved as a separate ACB chat.",
	);
	const status = el("p", { role: "status", class: "voice-test-status" }, "Connecting…");
	const model = el("p", { class: "voice-test-model" });
	const workerModel = el("p", { class: "voice-test-model", hidden: !relay });
	const micState = el(
		"span",
		{ class: "voice-test-mic-state", "data-active": "false" },
		"Microphone off",
	);
	const metrics = el("p", { class: "voice-test-metrics", "aria-live": "polite" });
	const transcript = el("div", {
		class: "voice-test-transcript",
		role: "log",
		"aria-label": relay ? "Relay conversation" : "Voice test transcript",
	});
	const start = el(
		"button",
		{ type: "button", class: "voice-test-primary", disabled: true, "aria-pressed": "false" },
		"Start microphone",
	);
	const interrupt = el(
		"button",
		{ type: "button", disabled: true },
		relay && isStreamingPi ? "Stop speaking" : "Interrupt",
	);
	const pause = el(
		"button",
		{ type: "button", hidden: !attached, disabled: true, "aria-pressed": "false" },
		"Pause voice",
	);
	const stopPi = el(
		"button",
		{
			type: "button",
			hidden: !isStreamingPi,
			disabled: true,
			title:
				"Stops the current Pi turn only; queued requests and workers may continue. Completed effects remain.",
		},
		"Stop current Pi turn",
	);
	const finish = el(
		"button",
		{ type: "button", disabled: !relay },
		attached ? "End voice" : relay ? "Close voice" : "End test & summarise",
	);
	const job = el("div", { class: "relay-job", "aria-live": "polite" });
	const cancelJob = el(
		"button",
		{ type: "button", disabled: true, hidden: true },
		"Cancel work job",
	);
	const newRelay = el("button", { type: "button" }, "New Relay conversation");
	const voiceButtons: HTMLButtonElement[] = [];
	if (relay) {
		if (streamTrial) {
			const toggleTrial = el(
				"button",
				{ type: "button" },
				useZonosTts ? "Use Kokoro TTS" : "Use ZONOS3-Mini TTS",
			);
			toggleTrial.onclick = () => {
				modal.dismiss();
				openRelayTrial(useZonosTts ? "kokoro" : "zonos3");
			};
			voiceButtons.push(toggleTrial);
		} else {
			const choices: Array<[RelayVoiceEngine, string, boolean]> = [
				["zonos3", "Use Pi + ZONOS3-Mini (default, aligned)", !useZonosTts],
				["kokoro", "Use Pi + Server2 Kokoro (aligned)", !useKokoroTts],
				["legacy", "Use legacy STT/Kokoro", useSpeechTts],
			];
			for (const [targetEngine, label, show] of choices) {
				if (!show) continue;
				const btn = el("button", { type: "button" }, label);
				btn.onclick = () => {
					modal.dismiss();
					openRelay(targetEngine);
				};
				voiceButtons.push(btn);
			}
		}
	}
	const input = el("input", {
		type: "text",
		placeholder: relay ? "Or type a message to Relay" : "Or type a test message",
		"aria-label": relay ? "Relay message" : "Voice test message",
		maxLength: 4000,
	});
	const send = el("button", { type: "submit", disabled: true }, "Send text");
	const form = el("form", { class: "voice-test-form" }, input, send);
	const link = el(
		"a",
		{ hidden: true, target: "_blank", rel: "noopener" },
		"Open saved transcript",
	);
	const details = el(
		"div",
		{ id: `voice-details-${uuid()}`, class: "voice-test-details", hidden: true },
		intro,
		el(
			"p",
			{},
			"Headphones help prevent echo. Replies below are generated text, not proof that every word was heard.",
		),
		metrics,
		...(relay
			? [
					el(
						"p",
						{},
						"Changing the voice closes the microphone, not Pi work. Your saved conversation stays.",
					),
					el("div", { class: "voice-test-controls" }, ...voiceButtons),
					el(
						"p",
						{},
						"To change the delegated work model or thinking level, select it in the main chat before opening Relay. Existing workers keep their own settings.",
					),
				]
			: []),
	);
	const settings = el(
		"button",
		{ type: "button", "aria-expanded": "false", "aria-controls": details.id },
		"Voice settings & details",
	);
	settings.onclick = () => {
		details.hidden = !details.hidden;
		settings.setAttribute("aria-expanded", String(!details.hidden));
	};
	const inputHint = relay
		? "Pause briefly to send. Up to 2 minutes per turn."
		: "Pause briefly to send. Up to 30 seconds per test turn.";
	const stopHint = !relay
		? "Headphones help avoid echo."
		: isStreamingPi
			? "Stopping speech or closing voice leaves Pi work running."
			: "Interrupt may stop direct Pi tools; workers keep running. Closing voice leaves work running.";
	const box = el(
		"div",
		{ class: "modal-box voice-test" },
		heading,
		el(
			"p",
			{ class: "voice-test-overview" },
			useZonosTts
				? "Talk naturally. Pi handles your requests; ZONOS3-Mini reads the replies aloud."
				: relay
					? "Talk naturally. Pi handles your requests; Kokoro reads the replies aloud."
					: "Try a conversation with DeepSeek. This test cannot use tools or do work.",
		),
		model,
		workerModel,
		el(
			"div",
			{ class: "voice-test-live" },
			micState,
			status,
			el("div", { class: "voice-test-controls" }, start, pause, interrupt, stopPi, finish),
			el("p", { class: "voice-test-help" }, `${inputHint} ${stopHint}`),
		),
		...(!attached ? [form] : []),
		...(relay ? [job, cancelJob] : []),
		...(!attached ? [el("h3", {}, "Conversation"), transcript, link] : []),
		el("div", { class: "voice-test-controls" }, ...(relay ? [newRelay] : []), settings),
		details,
	);
	const overlay = el("div", { class: "modal-overlay" }, box);
	let dismissed = false;
	let ending = false;
	let failed = false;
	let ready = false;
	let transportReady = false;
	let extensionAvailable = false;
	let startSent = false;
	let relayStarted = false;
	let foregroundPending = foregroundRelay && document.visibilityState !== "visible";
	let currentTurn = "";
	let relaySpeech = new SpokenMarkdown(!useZonosTts);
	let relayMessage = "";
	let pcmStartedUtterance = "";
	let restoredReply: HTMLElement | null = null;
	let relayText = "";
	let relayMuted = false;
	let relayFirstText = 0;
	let endedAt = 0;
	let sttMs = 0;
	let firstTextMs = 0;
	let stopCapture: ConversationCapture | null = null;
	let sttController: AbortController | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	let captureAttempt: AbortController | null = null;
	let micWanted = false;
	let retriedMic = false;
	let voicePaused = false;
	let pausePending = false;
	let pausedSpeechMessage = "";
	let relayPauseSkipped = false;
	let pauseNotice = "Paused — microphone muted; Pi work continues.";
	let lastWireAt = Date.now();
	const rows = new Map<string, HTMLElement>();
	let drawer: RelayDrawer | null = null;
	let binding: RelayChatBinding | null = null;
	const socket = attached
		? null
		: new WebSocket(
				`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/chat`,
			);
	const connected = () =>
		attached ? Boolean(binding?.isOpen()) : socket?.readyState === WebSocket.OPEN;
	const foregroundBlocked = () =>
		foregroundRelay && (foregroundPending || document.visibilityState !== "visible");
	const sendWire = (message: ClientMessage): boolean => {
		if (
			attached &&
			(message.type === "prompt" || message.type === "abort" || message.type === "getCapabilities")
		)
			return binding?.send(message) ?? false;
		if (socket?.readyState !== WebSocket.OPEN) return false;
		socket.send(JSON.stringify(message));
		return true;
	};
	const syncDrawer = () =>
		drawer?.setStatus(status.textContent ?? "", micState.textContent ?? "Microphone off");
	const renderMic = () => {
		start.disabled =
			!ready ||
			ending ||
			Boolean(captureAttempt) ||
			voicePaused ||
			pausePending ||
			foregroundPending;
		pause.disabled =
			!ready || ending || Boolean(captureAttempt) || pausePending || foregroundPending;
		setWakeLock?.(
			Boolean(stopCapture) &&
				!voicePaused &&
				!foregroundPending &&
				!ending &&
				document.visibilityState === "visible",
		);
		pause.textContent = voicePaused ? "Resume voice" : "Pause voice";
		pause.setAttribute("aria-pressed", String(voicePaused));
		drawer?.setPause(voicePaused, pause.disabled);
		start.textContent =
			captureAttempt && !captureAttempt.signal.aborted
				? "Starting microphone…"
				: stopCapture
					? "Stop microphone"
					: "Start microphone";
		start.setAttribute("aria-pressed", String(Boolean(stopCapture)));
		micState.textContent =
			captureAttempt && !captureAttempt.signal.aborted
				? "Microphone starting…"
				: voicePaused && stopCapture
					? "Microphone muted"
					: stopCapture
						? "Microphone on"
						: "Microphone off";
		micState.dataset.active = String(Boolean(stopCapture) && !voicePaused);
		syncDrawer();
	};
	const sayStatus = (text: string) => {
		status.textContent = voicePaused && !text.startsWith("Error:") ? pauseNotice : text;
		syncDrawer();
	};
	const fail = (error: unknown) => {
		failed = true;
		sayStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
	};
	const renderPcmMetrics = (m: PcmUtteranceMetrics) => {
		if (!endedAt) return;
		const parts = [
			`Local STT ${sttMs.toFixed(0)} ms`,
			`Pi first text ${firstTextMs.toFixed(0)} ms`,
		];
		if (m.ttsFirstPcmClientMs !== null) {
			const nativeNote =
				m.ttsFirstPcmServerMs !== null ? ` (backend ${m.ttsFirstPcmServerMs.toFixed(0)} ms)` : "";
			parts.push(`TTS first PCM ${m.ttsFirstPcmClientMs.toFixed(0)} ms${nativeNote}`);
		}
		if (m.scheduledPlaybackMs !== null) {
			parts.push(`scheduled playback ${m.scheduledPlaybackMs.toFixed(0)} ms`);
		}
		if (m.coldLoadMs !== null) {
			parts.push(`cold load ${m.coldLoadMs.toFixed(0)} ms (separate)`);
		}
		metrics.textContent = parts.join(" · ");
	};
	const createSpeechSpeaker = useZonosTts
		? (callbacks: PcmTtsSpeakerCallbacks) => createZonosSpeaker(callbacks, () => state.ttsSpeed)
		: createKokoroSpeaker;
	const speaker = !useSpeechTts
		? new ConversationSpeaker(
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
			)
		: null;
	const pcmSpeaker = useSpeechTts
		? createSpeechSpeaker({
				onStatus: (text) => {
					if (!ending) sayStatus(text);
				},
				onPlaying: (m) => {
					renderPcmMetrics(m);
					if (!ending) sayStatus("Speaking — you can interrupt");
				},
				onMetrics: (m) => renderPcmMetrics(m),
				onIdle: () => {
					if (!ending && !failed)
						sayStatus(stopCapture ? "Listening…" : "Ready — start the microphone or send text");
				},
				onError: (error) => {
					relayMuted = true;
					if (!ending)
						sayStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
				},
			})
		: null;
	const command = (text: string) => {
		if (connected()) sendWire({ type: "prompt", text });
	};
	const cancelAudio = (acknowledge = false) => {
		pausedSpeechMessage = "";
		speaker?.stop();
		pcmSpeaker?.stop(acknowledge);
		pcmStartedUtterance = "";
		currentTurn = "";
		if (ready && !ending) {
			if (relay) {
				relayMuted = true;
				if (!isStreamingPi) sendWire({ type: "abort" });
			} else command("/voicetest interrupt");
		}
	};
	const addText = (label: string, text: string) => {
		if (attached) return el("p"); // The normal chat renderer owns the transcript.
		const row = el("p", {}, el("strong", {}, `${label}: `), text);
		const follow = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 48;
		transcript.append(row);
		if (follow) transcript.scrollTop = transcript.scrollHeight;
		return row;
	};
	const setMarkdownRow = (row: HTMLElement, label: string, markdown: string) => {
		if (attached) return;
		const follow = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 48;
		let body = row.querySelector<HTMLElement>(":scope > .markdown");
		if (!body) {
			body = el("div", { class: "markdown" });
			row.replaceChildren(el("strong", {}, `${label}: `), body);
		}
		setRichText(body, markdown);
		if (follow) transcript.scrollTop = transcript.scrollHeight;
	};
	const addMarkdown = (label: string, markdown: string) => {
		const row = el("div", { class: "voice-test-row" });
		transcript.append(row);
		setMarkdownRow(row, label, markdown);
		return row;
	};
	const discardInput = () => {
		sttController?.abort();
		sttController = null;
		stopCapture?.discard();
	};
	const releaseMic = () => {
		captureAttempt?.abort();
		discardInput();
		stopCapture?.close();
		stopCapture = null;
		renderMic();
	};
	const closeSocket = () => {
		clearTimeout(startupTimer);
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = null;
		binding?.close();
		binding = null;
		socket?.close();
	};
	const end = () => {
		if (ending) return;
		ending = true;
		voiceActive = false;
		micWanted = false;
		releaseMic();
		speaker?.stop();
		pcmSpeaker?.disconnect();
		pcmStartedUtterance = "";
		start.disabled = send.disabled = interrupt.disabled = stopPi.disabled = true;
		finish.disabled = !relay;
		sayStatus("Saving summary…");
		if (relay) {
			sayStatus(
				`Voice closed; work continues. Use ${streamTrial ? "/relaytrial" : "/relay"} to reconnect.`,
			);
			closeSocket();
		} else if (ready) {
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
		if (attached) relayUi = null;
		end();
		speaker?.close();
		pcmSpeaker?.close();
		clearInterval(watchdog);
		window.removeEventListener("pagehide", unload);
		document.removeEventListener("visibilitychange", visibility);
	};
	const unload = () => {
		dispose();
		closeSocket();
	};
	const retireLocalSpeech = (disconnect = false) => {
		// Retire the interrupted turn locally. Do not abort Pi or replay audio/capture.
		currentTurn = relayMessage = pcmStartedUtterance = pausedSpeechMessage = "";
		speaker?.stop();
		if (disconnect) pcmSpeaker?.disconnect();
		else pcmSpeaker?.stop();
	};
	const suspendForeground = () => {
		foregroundPending = true;
		releaseMic();
		retireLocalSpeech(true);
	};
	const visibility = () => {
		if (ending) return;
		if (foregroundRelay) {
			if (document.visibilityState !== "visible") {
				suspendForeground();
				sayStatus("Microphone off while tab is hidden; Pi work continues.");
			} else if (foregroundPending) {
				retriedMic = false;
				sayStatus("Restoring Relay connection…");
				// Wait for a round trip before capturing again. If the socket died while
				// frozen, the normal chat client's foreground watchdog reattaches it.
				if (transportReady && connected()) sendWire({ type: "getCapabilities" });
			}
			return;
		}
		// Test/trial keep their existing manual restart.
		if (document.visibilityState === "hidden") {
			micWanted = false;
			if (voicePaused || pausePending) {
				voicePaused = true;
				pauseNotice = "Paused — tab hidden; unsent speech and playback cleared.";
			}
			releaseMic();
			cancelAudio();
			pcmSpeaker?.disconnect();
			if (!ending) sayStatus("Microphone paused while tab is hidden");
		}
	};
	const startupTimer = setTimeout(() => {
		if (!ready) {
			fail(new Error("Voice extension did not become ready. Deploy it, then reopen the test."));
			closeSocket();
		}
	}, 20_000);
	// Attached Relay already has the chat client's liveness watchdog and reattach.
	const watchdog = foregroundRelay
		? undefined
		: setInterval(() => {
				if (Date.now() - lastWireAt > 45_000 && !ending) {
					fail(new Error("Connection lost; microphone stopped. Reopen the test to continue."));
					end();
				}
			}, 5_000);
	window.addEventListener("pagehide", unload);
	document.addEventListener("visibilitychange", visibility);
	if (attached) drawer = mountRelayDrawer(box, dispose, () => pause.click());
	const modal =
		drawer ??
		mountModal(overlay, box, {
			onDismiss: dispose,
			initialFocus: isStreamingPi ? box : input,
		});
	if (attached) {
		relayUi = {
			reveal: () => drawer?.reveal(),
			end: () => modal.dismiss(),
			prepareTyped: () => {
				if (!ready || ending || foregroundPending || !connected()) return false;
				discardInput();
				cancelAudio();
				endedAt = performance.now();
				sttMs = 0;
				return true;
			},
		};
		syncDrawer();
	}

	function say(text: string): void {
		if (!ready || ending || !text.trim()) return;
		const turnId = uuid();
		currentTurn = turnId;
		firstTextMs = 0;
		sayStatus("DeepSeek is preparing a reply…");
		// Remember identity before submission, even if the tab closes before acknowledgement.
		// An unsaved/missing session then fails closed; never auto-repeat the utterance.
		try {
			if (relay && sessionId) localStorage.setItem(sessionKey, sessionId);
		} catch {
			/* private mode */
		}
		if (useSpeechTts) pcmSpeaker?.connect();
		if (relay && isStreamingPi) {
			command(`/relay voice-context ${turnId} ${encodeRelayVoice({ text })}`);
			command(`/relay voice-request ${turnId} ${encodeRelayVoice({})}`);
		} else command(`${control} say ${turnId} ${text}`);
	}

	pause.onclick = async () => {
		if (!ready || ending || pausePending || captureAttempt || foregroundPending) return;
		const capture = stopCapture;
		pausePending = true;
		const resuming = voicePaused;
		voicePaused = !resuming;
		if (!resuming) {
			pauseNotice = "Paused — microphone muted; Pi work continues.";
			pausedSpeechMessage =
				relayMessage || (pcmSpeaker?.hasAudio || speaker?.hasAudio ? currentTurn : "");
			sttController?.abort();
			sttController = null; // Retain capture/VAD draft, not a stale recognition request.
		} else {
			pausedSpeechMessage = "";
		}
		renderMic();
		sayStatus(resuming ? "Resuming voice…" : pauseNotice);
		try {
			if (resuming) {
				await Promise.all([capture?.resume(), speaker?.resume(), pcmSpeaker?.resume()]);
			} else {
				await Promise.all([capture?.pause(), speaker?.pause(), pcmSpeaker?.pause()]);
			}
			if (!ending && !foregroundPending)
				sayStatus(stopCapture ? "Listening…" : "Ready — start the microphone or send text");
		} catch (error) {
			if (ending || foregroundPending || stopCapture !== capture) return;
			voicePaused = true;
			speaker?.stop();
			pcmSpeaker?.stop();
			await capture?.pause().catch(() => {});
			fail(error);
		} finally {
			pausePending = false;
			renderMic();
			void startMicrophone();
		}
	};
	start.onclick = () => {
		if (stopCapture) {
			micWanted = false;
			releaseMic();
			if (foregroundRelay) {
				relayMuted = true;
				retireLocalSpeech();
			} else cancelAudio();
			sayStatus("Microphone stopped");
			return;
		}
		micWanted = true;
		retriedMic = false;
		void startMicrophone();
	};
	async function startMicrophone(): Promise<void> {
		if (
			!micWanted ||
			stopCapture ||
			captureAttempt ||
			!ready ||
			!connected() ||
			ending ||
			voicePaused ||
			pausePending ||
			foregroundPending ||
			document.visibilityState !== "visible"
		)
			return;
		const attempt = new AbortController();
		captureAttempt = attempt;
		renderMic();
		sayStatus("Starting microphone — allow access if asked…");
		try {
			const stop = await captureConversation(
				() => {
					if (foregroundBlocked()) return;
					cancelAudio(true);
					sayStatus("Hearing speech — keep talking…");
				},
				(turn) => {
					if (foregroundBlocked()) return;
					const { audio } = turn;
					const controller = new AbortController();
					// This replacement snapshot includes ALL unsubmitted segments.
					sttController?.abort();
					sttController = controller;
					endedAt = turn.endedAt;
					const began = performance.now();
					sayStatus("Recognising your words…");
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
							if (
								controller.signal.aborted ||
								voicePaused ||
								foregroundPending ||
								document.visibilityState !== "visible" ||
								!ready ||
								!connected() ||
								ending ||
								dismissed ||
								!turn.isCurrent()
							)
								return;
							sttMs = performance.now() - began;
							if (text.trim()) {
								// Only this unchanged draft can be consumed, immediately before dispatch.
								if (turn.accept()) say(text);
							} else
								sayStatus("No speech recognised — continue speaking or restart the microphone");
						})
						.catch((error: unknown) => {
							if (!controller.signal.aborted && turn.isCurrent() && !ending && !dismissed)
								fail(error);
						});
				},
				(error) => {
					micWanted = false;
					releaseMic();
					fail(error);
				},
				relay ? 120 : 30,
				{
					signal: attempt.signal,
					onInterrupted: foregroundRelay
						? () => {
								releaseMic();
								retireLocalSpeech();
								if (!retriedMic && !voicePaused) {
									retriedMic = true;
									void startMicrophone();
								} else if (!voicePaused) {
									micWanted = false;
									sayStatus("Microphone interrupted. Tap Start microphone to retry.");
								}
							}
						: undefined,
				},
			);
			if (
				attempt.signal.aborted ||
				ending ||
				!connected() ||
				document.visibilityState !== "visible"
			)
				stop.close();
			else {
				stopCapture = stop;
				sayStatus("Listening…");
				if (useSpeechTts) pcmSpeaker?.connect();
				else if (foregroundRelay) void speaker?.resume().catch(() => {});
			}
		} catch (error) {
			if (!attempt.signal.aborted) {
				micWanted = false;
				fail(error);
			}
		} finally {
			captureAttempt = null;
			renderMic();
			// A foreground event may have arrived while the previous start was unwinding.
			if (attempt.signal.aborted) void startMicrophone();
		}
	}
	interrupt.onclick = () => {
		cancelAudio(true);
		sayStatus(stopCapture ? "Listening…" : "Interrupted");
	};
	stopPi.onclick = () => {
		if (!ready || !connected()) return;
		sendWire({ type: "abort" });
		sayStatus(
			"Explicit stop requested for the current Pi turn. Workers/queued requests may continue; completed effects remain.",
		);
	};
	finish.onclick = () => {
		if (relay) modal.dismiss();
		else end();
	};
	cancelJob.onclick = () => {
		command("/relay cancel");
		sayStatus("Cancelling work job…");
	};
	newRelay.onclick = () => {
		try {
			localStorage.removeItem(sessionKey);
		} catch {
			/* private mode */
		}
		modal.dismiss();
		openVoiceTest(true, streamTrial, engine, capturedWorker, true);
	};
	form.onsubmit = (event) => {
		event.preventDefault();
		const text = input.value.trim();
		if (!text || !ready || ending) return;
		discardInput();
		cancelAudio();
		endedAt = performance.now();
		sttMs = 0;
		say(text);
		input.value = "";
	};

	if (socket)
		socket.onopen = () =>
			socket.send(
				JSON.stringify({
					type: "init",
					provider: state.currentProvider,
					modelId: state.currentModelId,
					thinkingLevel: relay ? state.currentThinking : "off",
					...(savedSession ? { sessionId: savedSession } : {}),
				}),
			);
	// Pi RPC events are a superset of the typed protocol; unknown events are ignored.
	// biome-ignore lint/suspicious/noExplicitAny: same permissive RPC dispatch as the normal chat renderer.
	const handleWire = (wire: Record<string, any>) => {
		lastWireAt = Date.now();
		if (wire.type === "capabilities") {
			extensionAvailable = wire.commands.some(
				(entry: { name?: string }) => entry.name === (relay ? "relay" : "voicetest"),
			);
			if (!extensionAvailable) {
				fail(new Error("Voice-test Pi extension is not installed. No prompt has been sent."));
				closeSocket();
				return;
			}
			if (transportReady && !ending) {
				if (foregroundRelay && relayStarted) {
					ready = true;
					interrupt.disabled = stopPi.disabled = false;
					if (foregroundPending && document.visibilityState === "visible") {
						foregroundPending = false;
						// The retired message stays silent; fresh messages can speak again.
						if (micWanted) relayMuted = false;
						sayStatus("Ready — start the microphone or send text");
						renderMic();
						void startMicrophone();
					}
				} else if (!startSent) {
					startSent = true;
					command(startCommand);
				}
			}
			return;
		}
		if (wire.type === "ready") {
			if (ending) {
				closeSocket();
				return;
			}
			if (wire.sessionId) {
				sessionId = wire.sessionId;
				link.href = `/s/${encodeURIComponent(wire.sessionId)}`;
			}
			transportReady = true;
			sendWire({ type: "getCapabilities" });
			if (extensionAvailable && !startSent && !(foregroundRelay && relayStarted)) {
				startSent = true;
				command(startCommand);
			}
			return;
		}
		if (wire.type === "modelState") {
			setConversationModel(`${wire.provider}/${wire.modelId}`, wire.thinkingLevel);
			return;
		}
		if (wire.type === "error") {
			fail(new Error(wire.message));
			if (!foregroundRelay || !relayStarted) {
				micWanted = false;
				releaseMic();
			}
			return;
		}
		if (relay && wire.type === "transcript") {
			if (attached) return;
			transcript.replaceChildren();
			rows.clear();
			for (const message of wire.messages ?? []) {
				if (
					isStreamingPi &&
					message.customType === RELAY_MESSAGE &&
					message.details?.kind === "voice_context"
				)
					showVoiceContext(message.details);
				if (message.role === "user" || message.role === "assistant") {
					const text = messageText(message);
					if (text) {
						const row =
							message.role === "assistant"
								? addMarkdown("Relay", text)
								: addText(message.role === "user" ? "You" : "Relay", text);
						restoredReply = message.role === "assistant" ? row : null;
					}
				}
			}
			if ((wire.messages ?? []).length) link.hidden = false;
			return; // History is displayed, never spoken or resubmitted.
		}
		if (wire.type !== "event") return;
		if (
			relay &&
			wire.event.type === "message_end" &&
			wire.event.message?.customType === RELAY_MESSAGE
		) {
			const event = wire.event.message.details as RelayEvent;
			if (event.kind === "ready") {
				if (foregroundRelay && relayStarted) return;
				capturedWorker = `${event.workerModel.provider}/${event.workerModel.modelId} ${event.workerModel.thinkingLevel}`;
				workerModel.textContent = `Delegated work: ${event.workerModel.modelId} · thinking ${event.workerModel.thinkingLevel} (when requested)`;
				workerModel.title = `${event.workerModel.provider}/${event.workerModel.modelId}. Settings captured from the main chat; this is not a live worker status.`;
				handleVoiceEvent({ kind: "ready", model: event.model });
			} else if (event.kind === "voice_context") {
				if (isStreamingPi) showVoiceContext(event);
			} else if (event.kind === "voice_result") {
				if (isStreamingPi && event.error) sayStatus(event.text);
			} else if (event.kind === "voice_pending") {
				if (isStreamingPi)
					sayStatus("Pi Relay request accepted/queued; speech interruption does not cancel it.");
			} else if (event.kind === "error") {
				handleVoiceEvent(event);
			} else if (event.kind === "job") {
				job.replaceChildren();
				cancelJob.hidden = !event.job;
				cancelJob.disabled = !event.job || event.job.status === "stopped";
				if (event.uncertain)
					job.append(el("p", {}, "Submission uncertain. Inspect the worker; do not submit again."));
				if (event.job) {
					job.append(
						el(
							"a",
							{ href: `/s/${encodeURIComponent(event.job.id)}`, target: "_blank", rel: "noopener" },
							event.job.title,
						),
					);
					job.append(
						el(
							"p",
							{},
							`Recorded: ${event.job.status} · ${new Date(event.job.updatedAt).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })} AEST. Not live progress.`,
						),
					);
					if (event.job.summary) job.append(el("p", {}, event.job.summary));
				}
			}
			return;
		}
		if (relay && ready && !foregroundBlocked()) {
			const event = wire.event;
			if (event.type === "message_start" && event.message?.role === "assistant") {
				relayMessage = uuid();
				relayPauseSkipped = voicePaused && Boolean(pausedSpeechMessage);
				if (voicePaused && !pausedSpeechMessage) pausedSpeechMessage = relayMessage;
				relayText = "";
				relaySpeech = new SpokenMarkdown(!useZonosTts);
				relayFirstText = 0;
				if (!relayPauseSkipped) pcmStartedUtterance = "";
				if (!isStreamingPi) relayMuted = false;
				currentTurn = relayMessage;
			} else if (
				event.type === "message_update" &&
				event.assistantMessageEvent?.type === "text_delta" &&
				relayMessage
			) {
				const delta = event.assistantMessageEvent.delta;
				relayText += delta;
				if (!relayFirstText) {
					relayFirstText = endedAt ? performance.now() - endedAt : 0;
					firstTextMs = relayFirstText;
				}
				const row = rows.get(relayMessage) ?? addMarkdown("Relay", "");
				rows.set(relayMessage, row);
				setMarkdownRow(row, "Relay", relayText);
				streamSpeech(delta);
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				// Reattachment may miss an in-flight message_start. Complete its text
				// silently rather than speaking an old reply again.
				if (!relayMessage) {
					const text = messageText(event.message);
					if (restoredReply && text) setMarkdownRow(restoredReply, "Relay", text);
					else if (text) addMarkdown("Relay", text);
					return;
				}
				if (!relayText) {
					relayText = messageText(event.message);
					if (relayText) {
						const row = rows.get(relayMessage) ?? addMarkdown("Relay", "");
						rows.set(relayMessage, row);
						setMarkdownRow(row, "Relay", relayText);
					}
					streamSpeech(relayText);
				}
				streamSpeech("", true);
				if (useSpeechTts) {
					if (pcmStartedUtterance === relayMessage) {
						pcmSpeaker?.finishUtterance();
					} else if (
						(relayMuted || relayPauseSkipped) &&
						relayText.trim() &&
						!pcmReportedIds.has(relayMessage)
					) {
						recordPcmPlayback({
							utterance: relayMessage,
							playedMs: 0,
							text: "",
							complete: false,
							uncertain: false,
						});
					}
				}
				if (event.message.errorMessage)
					handleVoiceEvent({ kind: "error", text: event.message.errorMessage });
				relayMessage = "";
				relayPauseSkipped = false;
			} else if (event.type === "message_end" && event.message?.role === "user") {
				if (isStreamingPi) relayMuted = false;
				link.hidden = false;
				try {
					if (sessionId) localStorage.setItem(sessionKey, sessionId);
				} catch {
					/* private mode */
				}
				addText("You", messageText(event.message));
			}
		}
		if (
			!attached &&
			wire.event.type === "extension_ui_request" &&
			["select", "input", "confirm", "editor"].includes(wire.event.method)
		) {
			sendWire({ type: "extensionUiResponse", id: wire.event.id, cancelled: true });
			fail(new Error("Unexpected extension dialog; use a normal chat to configure the provider."));
			return;
		}
		if (wire.event.type === "response" && wire.event.success === false) {
			fail(new Error(wire.event.error || "Voice command failed"));
			return;
		}
		if (wire.event.type !== "message_end" || wire.event.message?.customType !== VOICE_TEST_MESSAGE)
			return;
		handleVoiceEvent(wire.event.message.details as VoiceTestEvent);
	};
	function showVoiceContext(event: { id: string; user?: string; heard?: string }): void {
		link.hidden = !link.hasAttribute("href");
		// Historical receipts label their own source; never relabel them after an engine change.
		for (const [field, label] of [
			["user", "You (voice/text)"],
			["heard", "Voice (playback evidence)"],
		] as const) {
			const text = event[field];
			if (text === undefined) continue;
			const key = `voice-${field}-${event.id}`;
			const row = rows.get(key) ?? addText(label, "");
			rows.set(key, row);
			row.replaceChildren(el("strong", {}, `${label}: `), text);
		}
	}
	function streamSpeech(delta: string, final = false): void {
		if (relayMuted || relayPauseSkipped || ending || dismissed) return;
		try {
			for (const text of relaySpeech.push(delta, final)) speakRelay(text);
		} catch (error) {
			relayMuted = true;
			speaker?.stop();
			pcmSpeaker?.stop();
			pcmStartedUtterance = "";
			addText("Speech stopped", error instanceof Error ? error.message : "Read the saved answer.");
		}
	}
	function speakRelay(text: string): void {
		if (relayMuted || ending || dismissed) return;
		firstTextMs = relayFirstText;
		const messageId = relayMessage;
		if (useSpeechTts) {
			if (!pcmSpeaker || !messageId) return;
			if (pcmStartedUtterance !== messageId) {
				pcmStartedUtterance = messageId;
				pcmSpeaker.beginUtterance(messageId, endedAt || performance.now(), (report) =>
					recordPcmPlayback(report),
				);
			}
			pcmSpeaker.enqueueSegment(text);
			return;
		}
		speaker?.enqueue(
			text,
			streamTrial ? (complete) => recordPlayback(messageId, text, complete) : undefined,
		);
	}
	const pcmReportedIds = new Set<string>();
	function recordPcmPlayback(report: PcmPlayedReport): void {
		if (!ready || !connected()) return;
		pcmReportedIds.add(report.utterance);
		while (pcmReportedIds.size > 40) pcmReportedIds.delete(pcmReportedIds.values().next().value!);
		const history = formatKokoroPlayedHistory(report);
		command(`/relay voice-heard ${report.utterance} ${encodeRelayVoice({ text: history })}`);
	}
	const playedSegments = new Map<string, string[]>();
	function recordPlayback(id: string, text: string, complete: boolean): void {
		if (!ready || !connected()) return;
		const played = playedSegments.get(id) ?? [];
		if (complete) played.push(text);
		playedSegments.set(id, played);
		while (playedSegments.size > 20) playedSegments.delete(playedSegments.keys().next().value!);
		let prefix = played.join(" ") || "none";
		const uncertainty = complete
			? ""
			: " Interrupted during the next segment: partial playback, exact words unknown. Do not assume the remaining answer was heard.";
		const format = (omitted = false) =>
			`Trial A estimated completed playback segments: ${omitted ? "[Earlier completed segments omitted] " : ""}${prefix}.${uncertainty}`;
		let history = format();
		// Bound the encoded bridge payload, not UTF-16 characters; retain the
		// uncertainty label even for long multilingual/control-character text.
		while (
			history.length > 16_000 ||
			new TextEncoder().encode(JSON.stringify({ text: history })).length > 17_000
		) {
			prefix = prefix.slice(1024);
			history = format(true);
		}
		command(`/relay voice-heard ${id} ${encodeRelayVoice({ text: history })}`);
	}
	function setConversationModel(id: string, thinking = "off"): void {
		const name = id === "venice/deepseek-v4-1-flash-1017" ? "DeepSeek Flash" : id;
		model.textContent = `${relay ? "Answers & tools" : "Replies"}: ${name} · thinking ${thinking}`;
		model.title = id;
	}
	function handleVoiceEvent(event: VoiceTestEvent): void {
		if (event.kind === "ready") {
			clearTimeout(startupTimer);
			relayStarted = relay;
			ready = true;
			if (foregroundRelay && document.visibilityState === "visible") foregroundPending = false;
			setConversationModel(event.model);
			send.disabled = interrupt.disabled = stopPi.disabled = finish.disabled = false;
			renderMic();
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
			speaker?.enqueue(event.text);
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
	}
	const disconnected = () => {
		clearTimeout(startupTimer);
		ready = false;
		startSent = transportReady = extensionAvailable = false;
		if (foregroundRelay && !ending) {
			suspendForeground();
			interrupt.disabled = stopPi.disabled = true;
			if (!failed) sayStatus("Relay disconnected; microphone off until chat reconnects.");
			return;
		}
		micWanted = false;
		releaseMic();
		speaker?.stop();
		pcmSpeaker?.disconnect();
		start.disabled = send.disabled = interrupt.disabled = stopPi.disabled = true;
		finish.disabled = !relay;
		if (!ending && !failed)
			sayStatus("Connection closed; microphone stopped. Reopen the test to continue.");
		clearInterval(watchdog);
	};
	if (socket) {
		socket.onmessage = (message) => handleWire(JSON.parse(String(message.data)));
		socket.onerror = () => fail(new Error("Voice connection failed"));
		socket.onclose = disconnected;
	} else {
		binding =
			services.openRelayChat?.({
				sessionId: savedSession,
				onMessage: handleWire,
				onDisconnect: disconnected,
			}) ?? null;
		if (!binding) fail(new Error("Chat connection is not ready. End voice and try R again."));
	}
}
