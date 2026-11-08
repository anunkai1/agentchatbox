/** Voice-test UI only. The dedicated Pi session owns the model, prompt and history. */
import { RELAY_MESSAGE, type RelayEvent } from "../shared/relay.js";
import { VOICE_TEST_MESSAGE, type VoiceTestEvent } from "../shared/voice-test.js";
import { transcribeAudio } from "./api.js";
import { el, mountModal, uuid } from "./dom.js";
import {
	formatLfmPlayedHistory,
	type LfmPlayedReport,
	LfmTtsSpeaker,
	type LfmUtteranceMetrics,
} from "./lfm-tts.js";
import { setRichText } from "./linkify.js";
import { encodeRelayVoice, RelayVoiceFrame } from "./relay-voice.js";
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
const TRIAL_ENGINE_KEY = "acb-relay-trial-engine";

export type RelayVoiceEngine = "server4" | "lfm-tts" | "legacy";

export function openRelay(explicitEngine?: RelayVoiceEngine): void {
	let engine: RelayVoiceEngine = "server4";
	try {
		if (explicitEngine) {
			localStorage.setItem("acb-relay-voice-engine", explicitEngine);
			engine = explicitEngine;
		} else {
			const saved = localStorage.getItem("acb-relay-voice-engine");
			if (saved === "legacy" || saved === "lfm-tts" || saved === "server4") engine = saved;
		}
	} catch {
		if (explicitEngine) engine = explicitEngine;
	}
	openVoiceTest(true, engine === "server4", false, engine === "lfm-tts");
}

export function openRelayTrial(preferLfmTts?: boolean): void {
	let lfmTts = false;
	try {
		if (preferLfmTts !== undefined) {
			localStorage.setItem(TRIAL_ENGINE_KEY, preferLfmTts ? "lfm-tts" : "kokoro");
			lfmTts = preferLfmTts;
		} else {
			lfmTts = localStorage.getItem(TRIAL_ENGINE_KEY) === "lfm-tts";
		}
	} catch {
		lfmTts = Boolean(preferLfmTts);
	}
	openVoiceTest(true, false, true, lfmTts);
}

export function openVoiceTest(
	relay = false,
	localVoice = relay,
	streamTrial = false,
	useLfmTts = false,
): void {
	if (opened) return;
	useLfmTts = relay && !localVoice && useLfmTts;
	streamTrial = relay && !localVoice && streamTrial;
	const isStreamingPi = streamTrial || useLfmTts;
	const sessionKey = streamTrial ? TRIAL_SESSION_KEY : RELAY_SESSION_KEY;
	const control = relay ? "/relay" : "/voicetest";
	const startCommand =
		relay && state.currentProvider && state.currentModelId
			? `/relay start ${state.currentProvider}/${state.currentModelId} ${state.currentThinking}`
			: `${control} start`;
	let savedSession: string | null = null;
	try {
		if (relay) savedSession = localStorage.getItem(sessionKey);
	} catch {
		/* private mode */
	}
	let sessionId = savedSession;
	opened = true;
	cancelVoiceRecord();
	stopAllVoice();
	const heading = el(
		"h2",
		{},
		streamTrial ? "Trial A — streaming Pi voice" : relay ? "Relay" : "Browser voice test",
	);
	const intro = el(
		"p",
		{},
		relay
			? useLfmTts
				? "Pi + Server4 LFM TTS (speech-only): local STT → full-access Pi/DeepSeek → rendered sentence-streamed LFM TTS, without LFM interpreting requests or rewriting answers. Interrupt stops speech only; Pi work continues. Recognised text and approximate unhinted-ASR played speech are saved; no raw audio archive. Active speech reserves Server4's GPU."
				: streamTrial
					? "Isolated trial: local STT → full-access Pi/DeepSeek → sentence-streamed Kokoro, without LFM rewriting the answer. Interrupt stops speech only; work continues. Text goes to Venice/the worker provider; no audio archive. Playback records completed speech segments; the interrupted segment's word boundary is unknown."
					: localVoice
						? "Server4 speech + full-access Pi Relay. Interrupt stops voice, not work. Recognised text and approximate played speech are saved; text context goes to Venice/the selected worker provider. No raw audio archive. Voice reserves Server4's GPU."
						: "Legacy STT/Kokoro Relay with normal owner-level tools and delegation. Closing voice leaves work running; Interrupt can stop direct tools, not workers. Text/tool context go to Venice; raw audio is not saved."
			: "Local speech-to-text → Venice DeepSeek → local Kokoro. No phone calls or action tools. Text goes to Venice; audio is processed locally and is not saved. The transcript is saved as a separate ACB chat.",
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
	const stopPi = el(
		"button",
		{
			type: "button",
			hidden: !localVoice && !isStreamingPi,
			disabled: true,
			title:
				"Stops the current Pi turn only; queued requests and workers may continue. Completed effects remain.",
		},
		"Stop current Pi turn",
	);
	const finish = el(
		"button",
		{ type: "button", disabled: true },
		relay ? "Close voice — keep work running" : "End test & summarise",
	);
	const job = el("div", { class: "relay-job", "aria-live": "polite" });
	const cancelJob = el("button", { type: "button", disabled: true }, "Cancel work job");
	const newRelay = el("button", { type: "button" }, "New Relay conversation");
	const voiceButtons: HTMLButtonElement[] = [];
	if (relay) {
		if (streamTrial) {
			const toggleTrial = el(
				"button",
				{ type: "button" },
				useLfmTts ? "Use Kokoro TTS" : "Use LFM TTS (speech-only)",
			);
			toggleTrial.onclick = () => {
				modal.dismiss();
				openRelayTrial(!useLfmTts);
			};
			voiceButtons.push(toggleTrial);
		} else {
			const choices: Array<[RelayVoiceEngine, string, boolean]> = [
				["lfm-tts", "Use Pi + LFM TTS (speech-only)", !useLfmTts],
				["server4", "Use Server4 LFM voice", !localVoice],
				["legacy", "Use legacy STT/Kokoro", localVoice || useLfmTts],
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
	let localFrame: RelayVoiceFrame | null = null;
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
		el("div", { class: "voice-test-controls" }, start, interrupt, stopPi, finish),
		form,
		...(relay
			? [job, el("div", { class: "voice-test-controls" }, cancelJob, newRelay, ...voiceButtons)]
			: []),
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
	let relaySpeech = new SpokenMarkdown();
	let relayMessage = "";
	let lfmStartedUtterance = "";
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
	const renderLfmMetrics = (m: LfmUtteranceMetrics) => {
		if (!endedAt) return;
		const parts = [
			`Local STT ${sttMs.toFixed(0)} ms`,
			`Pi first text ${firstTextMs.toFixed(0)} ms`,
		];
		if (m.ttsFirstPcmClientMs !== null) {
			const nativeNote =
				m.ttsFirstPcmServerMs !== null
					? ` (Server4 native ${m.ttsFirstPcmServerMs.toFixed(0)} ms)`
					: "";
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
	const speaker =
		!localVoice && !useLfmTts
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
	const lfmSpeaker = useLfmTts
		? new LfmTtsSpeaker({
				onStatus: (text) => {
					if (!ending) sayStatus(text);
				},
				onPlaying: (m) => {
					renderLfmMetrics(m);
					if (!ending) sayStatus("Speaking — you can interrupt");
				},
				onMetrics: (m) => renderLfmMetrics(m),
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
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "prompt", text }));
	};
	const cancelAudio = () => {
		if (relay && localVoice) {
			localFrame?.interrupt();
			return;
		}
		speaker?.stop();
		lfmSpeaker?.stop();
		lfmStartedUtterance = "";
		currentTurn = "";
		if (ready && !ending) {
			if (relay) {
				relayMuted = true;
				if (!isStreamingPi) socket.send(JSON.stringify({ type: "abort" }));
			} else command("/voicetest interrupt");
		}
	};
	const addText = (label: string, text: string) => {
		const row = el("p", {}, el("strong", {}, `${label}: `), text);
		transcript.append(row);
		row.scrollIntoView({ block: "nearest" });
		return row;
	};
	const setMarkdownRow = (row: HTMLElement, label: string, markdown: string) => {
		let body = row.querySelector<HTMLElement>(":scope > .markdown");
		if (!body) {
			body = el("div", { class: "markdown" });
			row.replaceChildren(el("strong", {}, `${label}: `), body);
		}
		setRichText(body, markdown);
		row.scrollIntoView({ block: "nearest" });
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
		discardInput();
		stopCapture?.close();
		stopCapture = null;
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
		speaker?.stop();
		lfmSpeaker?.disconnect();
		lfmStartedUtterance = "";
		start.disabled = send.disabled = interrupt.disabled = stopPi.disabled = finish.disabled = true;
		sayStatus("Saving summary…");
		if (relay) {
			localFrame?.stop();
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
		end();
		speaker?.close();
		lfmSpeaker?.close();
		localFrame?.dispose();
		clearInterval(watchdog);
		window.removeEventListener("pagehide", unload);
		document.removeEventListener("visibilitychange", visibility);
	};
	const unload = () => {
		dispose();
		closeSocket();
	};
	const visibility = () => {
		// Never leave a hidden tab listening or holding Server4's GPU; resuming needs another click.
		if (document.visibilityState === "hidden") {
			releaseMic();
			if (localVoice) localFrame?.stop();
			else {
				cancelAudio();
				lfmSpeaker?.disconnect();
			}
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
	const modal = mountModal(overlay, box, {
		onDismiss: dispose,
		initialFocus: localVoice || isStreamingPi ? box : input,
	});
	if (relay && localVoice) {
		localFrame = new RelayVoiceFrame((action, id, payload) => {
			if (!ready || ending || dismissed) return;
			try {
				if (sessionId) localStorage.setItem(sessionKey, sessionId);
			} catch {
				/* private mode */
			}
			command(`/relay ${action} ${id} ${encodeRelayVoice(payload)}`);
		}, sayStatus);
		box.insertBefore(localFrame.element, metrics);
		start.hidden = true;
	}

	function say(text: string): void {
		if (!ready || ending || !text.trim()) return;
		const turnId = uuid();
		currentTurn = turnId;
		firstTextMs = 0;
		sayStatus("Waiting for DeepSeek…");
		// Remember identity before submission, even if the tab closes before acknowledgement.
		// An unsaved/missing session then fails closed; never auto-repeat the utterance.
		try {
			if (relay && sessionId) localStorage.setItem(sessionKey, sessionId);
		} catch {
			/* private mode */
		}
		if (useLfmTts) lfmSpeaker?.connect();
		if (relay && (localVoice || isStreamingPi)) {
			command(`/relay voice-context ${turnId} ${encodeRelayVoice({ text })}`);
			if (useLfmTts && lfmSpeaker?.hasPendingReports()) {
				void lfmSpeaker.flushPendingReports(1_500).then(() => {
					if (!ending && !dismissed && currentTurn === turnId) {
						command(`/relay voice-request ${turnId} ${encodeRelayVoice({})}`);
					}
				});
			} else {
				command(`/relay voice-request ${turnId} ${encodeRelayVoice({})}`);
			}
		} else command(`${control} say ${turnId} ${text}`);
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
				(turn) => {
					const { audio } = turn;
					const controller = new AbortController();
					// This replacement snapshot includes ALL unsubmitted segments.
					sttController?.abort();
					sttController = controller;
					endedAt = turn.endedAt;
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
							if (
								controller.signal.aborted ||
								!ready ||
								socket.readyState !== WebSocket.OPEN ||
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
					releaseMic();
					start.textContent = "Start microphone";
					fail(error);
				},
			);
			if (ending || dismissed || document.visibilityState === "hidden") stop.close();
			else {
				stopCapture = stop;
				start.textContent = "Stop microphone";
				sayStatus("Listening…");
				if (useLfmTts) lfmSpeaker?.connect();
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
	stopPi.onclick = () => {
		if (!ready || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify({ type: "abort" }));
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
		openVoiceTest(true, localVoice, streamTrial, useLfmTts);
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
	socket.onmessage = (message) => {
		lastWireAt = Date.now();
		const wire = JSON.parse(String(message.data));
		if (wire.type === "capabilities") {
			extensionAvailable = wire.commands.some(
				(entry: { name?: string }) => entry.name === (relay ? "relay" : "voicetest"),
			);
			if (!extensionAvailable) {
				fail(new Error("Voice-test Pi extension is not installed. No prompt has been sent."));
				closeSocket();
				return;
			}
			if (transportReady && !startSent && !ending) {
				startSent = true;
				command(startCommand);
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
			socket.send(JSON.stringify({ type: "getCapabilities" }));
			if (extensionAvailable && !startSent) {
				startSent = true;
				command(startCommand);
			}
			return;
		}
		if (wire.type === "error") {
			fail(new Error(wire.message));
			releaseMic();
			return;
		}
		if (relay && wire.type === "transcript") {
			transcript.replaceChildren();
			rows.clear();
			for (const message of wire.messages ?? []) {
				if (
					(localVoice || isStreamingPi) &&
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
				if (localVoice && event.voice) {
					localFrame?.configure(event.voice);
					command(`/relay voice-open ${uuid()} ${encodeRelayVoice({})}`);
				} else if (localVoice) {
					fail(
						new Error(
							"Pi Relay lacks the local voice bridge. Deploy it or explicitly choose legacy voice.",
						),
					);
					return;
				}
				const voicePrefix = localVoice
					? "Voice: Server4 LFM · tools: "
					: useLfmTts
						? "Voice: Pi + Server4 LFM TTS (speech-only) · model: "
						: "";
				handleVoiceEvent({
					kind: "ready",
					model: `${voicePrefix}${event.model} · worker: ${event.workerModel.provider}/${event.workerModel.modelId} (${event.workerModel.thinkingLevel})`,
				});
			} else if (event.kind === "voice_config") {
				if (localVoice) localFrame?.configure(event.config);
			} else if (event.kind === "voice_context") {
				if (localVoice || isStreamingPi) showVoiceContext(event);
			} else if (event.kind === "voice_result") {
				if (isStreamingPi && event.error) sayStatus(event.text);
				if (localVoice) {
					localFrame?.result(event);
					sayStatus(
						event.error
							? event.text
							: "Relay replied. Local voice will speak when idle; the full text is in the saved chat.",
					);
				}
			} else if (event.kind === "voice_pending") {
				if (localVoice || isStreamingPi)
					sayStatus("Pi Relay request accepted/queued; speech interruption does not cancel it.");
			} else if (event.kind === "error") {
				handleVoiceEvent(event);
			} else if (event.kind === "job") {
				job.replaceChildren();
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
		if (relay && ready) {
			const event = wire.event;
			if (event.type === "message_start" && event.message?.role === "assistant") {
				relayMessage = uuid();
				relayText = "";
				relaySpeech = new SpokenMarkdown();
				relayFirstText = 0;
				lfmStartedUtterance = "";
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
				if (useLfmTts) {
					if (lfmStartedUtterance === relayMessage) {
						lfmSpeaker?.finishUtterance();
					} else if (relayMuted && relayText.trim() && !lfmReportedIds.has(relayMessage)) {
						recordLfmPlayback({
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
		handleVoiceEvent(wire.event.message.details as VoiceTestEvent);
	};
	function showVoiceContext(event: { id: string; user?: string; heard?: string }): void {
		link.hidden = !link.hasAttribute("href");
		const heardLabel = useLfmTts
			? "LFM TTS (approximately played)"
			: streamTrial
				? "Voice (playback evidence)"
				: "LFM (approximately played)";
		for (const [field, label] of [
			["user", "You (voice/text)"],
			["heard", heardLabel],
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
		if (localVoice || relayMuted || ending || dismissed) return;
		try {
			for (const text of relaySpeech.push(delta, final)) speakRelay(text);
		} catch (error) {
			relayMuted = true;
			speaker?.stop();
			lfmSpeaker?.stop();
			lfmStartedUtterance = "";
			addText("Speech stopped", error instanceof Error ? error.message : "Read the saved answer.");
		}
	}
	function speakRelay(text: string): void {
		if (localVoice || relayMuted || ending || dismissed) return;
		firstTextMs = relayFirstText;
		const messageId = relayMessage;
		if (useLfmTts) {
			if (!lfmSpeaker || !messageId) return;
			if (lfmStartedUtterance !== messageId) {
				lfmStartedUtterance = messageId;
				lfmSpeaker.beginUtterance(messageId, endedAt || performance.now(), (report) =>
					recordLfmPlayback(report),
				);
			}
			lfmSpeaker.enqueueSegment(text);
			return;
		}
		speaker?.enqueue(
			text,
			streamTrial ? (complete) => recordPlayback(messageId, text, complete) : undefined,
		);
	}
	const lfmReportedIds = new Set<string>();
	function recordLfmPlayback(report: LfmPlayedReport): void {
		if (!ready || socket.readyState !== WebSocket.OPEN) return;
		lfmReportedIds.add(report.utterance);
		while (lfmReportedIds.size > 40) lfmReportedIds.delete(lfmReportedIds.values().next().value!);
		const history = formatLfmPlayedHistory(report);
		command(`/relay voice-heard ${report.utterance} ${encodeRelayVoice({ text: history })}`);
	}
	const playedSegments = new Map<string, string[]>();
	function recordPlayback(id: string, text: string, complete: boolean): void {
		if (!ready || socket.readyState !== WebSocket.OPEN) return;
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
	function handleVoiceEvent(event: VoiceTestEvent): void {
		if (event.kind === "ready") {
			clearTimeout(startupTimer);
			ready = true;
			model.textContent = event.model;
			start.disabled =
				send.disabled =
				interrupt.disabled =
				stopPi.disabled =
				finish.disabled =
					false;
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
	socket.onerror = () => fail(new Error("Voice connection failed"));
	socket.onclose = () => {
		clearTimeout(startupTimer);
		ready = false;
		releaseMic();
		speaker?.stop();
		lfmSpeaker?.disconnect();
		localFrame?.stop();
		start.disabled = send.disabled = interrupt.disabled = stopPi.disabled = finish.disabled = true;
		if (!ending && !failed)
			sayStatus("Connection closed; microphone stopped. Reopen the test to continue.");
		clearInterval(watchdog);
	};
}
