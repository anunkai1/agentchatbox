# ACB browser voice test

Prototype only: local STT → **Venice `deepseek-v4-1-flash-1017`** → local Kokoro.
No telephone dialling, bookings, payments or other action tools are implemented.
The owner chose no blanket purchase/payment approval rule for future calling;
this prototype's lack of action tools is a capability limit, not that rule.

## Use

Reload ACB after deployment and enter **`/voicetest`**. The browser opens a modal
and a separate ordinary Pi session named **Voice test · DeepSeek V4.1 1017**.
The main chat's model, transcript and tools are unchanged. The modal checks Pi's
command capabilities before sending anything; a missing extension fails closed
rather than sending an unknown slash command to a full-access coding agent.

- **Start microphone** requests microphone permission and loads local Silero VAD.
  Use headphones. Browser echo cancellation helps but is not a guarantee against
  speaker audio retriggering speech detection.
- Speak normally; a 600 ms speech-end window submits the completed utterance to
  the existing local transcription service. New speech interrupts model output,
  queued synthesis and playback. **Interrupt** does the same manually.
- **Send text** tests the response/speech path without opening a microphone.
- **Stop microphone** releases capture and cancels the current turn.
- **End test & summarise** stops capture/playback, requests a short model summary,
  and leaves an **Open saved transcript** link after the first recognised/text
  utterance. Closing the modal also ends it. An unused test creates no saved chat.
- Hiding the tab pauses capture; restarting it requires a click. Disconnection,
  navigation or dismissal releases microphone tracks and cancels browser work.
  There is no automatic replay or reconnection of voice turns.

The transcript labels generated text: it is not proof that every word was played
or heard. Interrupted responses may include unplayed generated sentences.
Metrics show local STT request duration, model time to first text, and approximate
speech-end-to-first-audio-scheduling time (not an acknowledgement from a speaker).
The first utterance can be slower while local models load.

## Ownership and transport

- `extensions/voice-test/{index,lib}.ts`: Pi command, exact model/auth lookup,
  short spoken prompt, bounded history, streaming sentence chunks, cancellation,
  summary. Uses Pi's configured Venice identity; never sends keys to the browser.
- `src/shared/voice-test.ts`: custom message wire types.
- `src/client/voice-test.ts`: modal, isolated existing `/api/chat` connection,
  status/transcript rendering and audio orchestration.
- `src/client/voice.ts`: browser audio capture/playback. Existing
  `/api/transcribe` and `/api/tts/stream` remain the speech transports.
- No new ACB model endpoint, server-side agent loop, listener, daemon, timer,
  firewall rule, Nginx route or Asterisk change.

The dedicated session disables its model-facing tool loadout. Voice generation
uses a separate Pi registry call with no tool declarations and no coding-chat
context; ordinary input in that session is intercepted. It does not share
full-access coding tools with someone speaking to it.

Limits: 4,000 characters per utterance; 40 turns per test; 300 output tokens and
30 seconds per model response; 30 seconds of continuous detected speech; bounded
30-second summary. Reopen the test for a fresh session. Errors are shown, not
silently routed to a different model. Pi shutdown aborts extension-owned work.

## Open-source practices and dependencies

The full Pipecat/LiveKit stacks were evaluated, not adopted. The prototype uses
streamed, small TTS chunks; Silero speech detection with 320 ms pre-roll;
confirmed-speech interruption; generation IDs against stale audio; cancellation
propagation; and separate latency measurements.

The narrow browser dependency is `@ricky0123/vad-web` **0.0.31**, with Silero v5
and `onnxruntime-web` **1.31.1**. Build copies versioned ONNX/worklet/WASM/module
assets to `/voice-vad/`; no CDN fetches, blob workers or cross-origin isolation.
WASM uses one thread. CSP permits `wasm-unsafe-eval`, **not** JavaScript
`unsafe-eval`. Notices are in `assets/voice-vad-LICENSES.txt` and the built
`/voice-vad/LICENSES.txt`.

References:
- https://github.com/pipecat-ai/pipecat
- https://github.com/livekit/agents
- https://github.com/ricky0123/vad
- https://docs.vad.ricky0123.com/user-guide/browser/

## Data and deployment

Only transcribed text/history is sent to Venice. Raw input/output audio stays in
local services and tab memory; no test audio file is saved or uploaded to ACB's
uploads directory. Text, summary and timing events are ordinary private Pi
session records under `~/.pi/agent/sessions/`, retained until explicit session
removal. Pi does not flush custom-only sessions: the extension appends each real
user utterance through the session manager before requesting a model response;
assistant chunks and the summary use custom messages. Like the existing Claude
mirror, this relies on the actual manager behind Pi's read-only extension view.
If that append capability disappears, startup fails closed; real-file regression
tests cover saving, Pi reopening and ACB transcript replay. They fall within existing home-directory restic coverage; old snapshots
can retain deleted transcripts. No claim of a completed backup is implied.

`deploy-agentchatbox` installs the extension package into Pi settings and runs the
usual lint/typecheck/tests/audits/build/restart/health gates. Operational setup,
recovery and future telephone scope: `infra/docs/acb-voice-calling.md`.

Tests: `tests/voice-test.test.ts`, the voice cases in `tests/ui-smoke.test.ts`
(real local WASM/model/worklet initialisation using synthetic audio, never the
machine's physical microphone), plus existing transcription/TTS/security tests.
