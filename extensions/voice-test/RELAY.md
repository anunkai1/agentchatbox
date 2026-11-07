# Relay — full-access browser voice agent

The **R** header button beside **V** (or `/relay`) opens a separate, resumable Pi
conversation with speech input/output and normal owner-level ACB tools. Relay can
inspect and act directly across repositories and hosts, or delegate work through
existing ACB tools. The voice panel tracks one associated `relay_job` worker; this
is not a limit on direct work or additional workers through normal delegation.
`/voicetest` remains the unchanged, tool-free prototype. No dedicated telephone
integration or standing proactive mandate is installed.

## Use

1. Select the desired **work model and thinking level in the ordinary ACB chat**,
   then enter `/relay`. The original chat is not changed. Relay captures that
   deliberate selection for its tracked worker, rather than Global's default for
   newly opened chats. Relay's own direct work runs on the conversation model;
   additional workers use the normal delegation tools' model-selection behaviour.
2. Verify the displayed conversation and worker models. Conversation remains
   `venice/deepseek-v4-1-flash-1017`; work uses the captured ACB selection. Workers
   use native Pi, not the originating chat's `/cc` mode. Antigravity automation
   is deliberately unavailable under the current provider mandate: choose a
   different work model before starting a new Relay conversation.
3. The default is **Server4 LFM voice**. Start conversation in the embedded voice
   panel, allow the microphone and wait for Listening; headphones help. Server4
   must be awake with its GPU free. **Use legacy STT/Kokoro** explicitly selects
   the older speech path without that GPU dependency; this device remembers the
   choice. There is no silent fallback. **Send text** reaches Pi without a mic;
   local speech speaks its reply only if voice is connected. A clear work
   request authorises dispatch; discussion is not approval. Relay can inspect
   files and live state directly to choose the owning repository and resolve
   missing facts, and must ask only when scope or destination is genuinely unclear.
4. Talk while the worker runs. Ask for status or send further instructions.
   Worker reports wake Relay; needs-input questions come back to this chat.
5. In **Server4 mode**, speaking over a reply or **Interrupt** stops speech only:
   **Pi direct tools and workers continue**. Approximately played words are kept;
   correction audio waits for verified native repair, never a silent whole-answer
   reset. Use **Stop current Pi turn** to explicitly abort the active Pi
   coordinator turn; queued voice requests and delegated workers may continue, and
   completed external effects remain. End/hide/close releases microphone and
   Server4, not Pi work. Microphone capture never restarts automatically. Wait a
   few seconds for the old children to exit before immediately restarting voice;
   GPU contention fails explicitly.
   **Legacy mode differs:** its Interrupt, new speech or hidden tab can abort the
   current Pi direct turn, though delegated workers survive. Closing either
   panel leaves work running.
6. Reopen `/relay` to resume the saved conversation and associated job. The
   browser remembers the session ID on this device; it never replays utterances,
   work submissions or old speech. The saved transcript and worker chat are also
   ordinary ACB sessions. On another device, use those session links for text
   continuity; cross-device voice-session discovery is not implemented.
7. **Cancel work job**, or explicitly ask Relay to cancel it, to terminate the
   worker. This stops its process group and queued work, and blocks automatic
   restart recovery for that execution. It cannot undo completed external effects.
8. **New Relay conversation** creates a fresh coordinator and captures the current
   normal-chat work model. It does not cancel the previous worker. Use this for
   a clean conversation or a new tracked worker. It is not required for unrelated
   direct work or additional normal delegations; keep follow-ups with their worker.

## Isolated streaming trial

`/relaytrial` opens **Trial A — streaming Pi voice**: local STT → the same
full-access Pi/DeepSeek Relay → sentence-streamed Kokoro. It starts speech while
Pi is still generating, without LFM interpreting the completed answer. It has
its own saved session (`acb-relay-trial-stream-session`) and does not change the
normal Relay session or remembered voice engine.

Interrupt, barge-in and hiding the tab stop speech, not Pi work. **Stop current
Pi turn** is the explicit coordinator abort; **Cancel work job** remains separate.
After an interruption, further output from that ongoing turn stays muted until
a new owner turn. Restored history is never replayed as speech.

Playback evidence records segments whose scheduled audio finished. A cut segment
is explicitly uncertain; there is no word alignment or exact-hearing claim.
The full generated answer remains in the ordinary Pi chat. This trial does not
add semantic turn detection, eliminate STT mistakes or guarantee that Pi delegates
instead of blocking on a direct tool. Test those behaviours rather than assuming
streaming solves them. Like legacy voice, this uses the existing STT/Kokoro
services rather than reserving Server4's LFM GPU.

## Ownership and persistence

- `relay.ts` and `lfm.ts` own model selection, voice policy, tools and lifecycle in Pi. It uses the
  **native Pi agent loop**, normal user/assistant/tool messages and compaction,
  not a second conversation/task framework.
- `acb-relay-state` custom entries in that same Pi session hold the captured work
  model, associated worker ID and uncertain-submission flags. Turn/action entries
  prevent repeated accepted commands. Before network side effects, checkpoints
  flush the existing session journal and its directory; there is no new database.
- LFM recognised/typed input and approximate played speech are custom entries in
  the same Pi session. The first actual utterance materialises it through the
  guarded session-manager API without launching Pi work. Each no-argument
  `relay_request` forwards only its separately recognised owner text, journalled
  and fsynced before dispatch. A queue holds up to eight requests while Pi is busy;
  completed duplicates return the stored result, pending duplicates do not repeat
  work, and unfinished journals restored after restart remain uncertain.
- Actual user messages trigger Pi's ordinary session persistence. An untouched
  empty dialog is not claimed as a saved transcript. The browser remembers an ID
  before first submission to avoid losing identity if closed before acknowledgement;
  a missing/unsaved session then fails closed rather than repeating the request.
- Existing `extensions/delegate` creates workers, stores their records under
  `~/.config/acb/delegations/`, delivers reports/owner notifications, and supplies
  existing bounded worker restart recovery. Normal-chat recovery applies to
  eligible interrupted coordinator turns. Neither is an unlimited retry/watchdog.
- Native session restoration re-establishes Relay's model and full tool access before
  owner input or a worker report. Each run receives the current associated
  record/report, so compaction need not remember a stale status. Rewinding/forking
  a Relay conversation is disabled to avoid duplicating ownership/submission.
- Existing authenticated `/api/internal` transport supplies current process
  activity, at-most-once prompt receipts and process-group cancellation. It does
  not decide task policy. The browser only transports/renders existing events.
- A recorded `working` status is not live progress. Status combines the last
  timestamped report with a current transport snapshot; neither proves a claimed
  deployment or external effect. Workers must supply evidence and check live state.

## Boundaries and failure behaviour

Relay activates all registered Pi tools, including normal file read/write/edit,
shell, browser/web/app integrations and delegation tools, plus `relay_job`
(start/status/message/cancel). There is no Relay tool allowlist, path whitelist or
extra 1,200-token output cap. Late-loaded tools are included on subsequent turns;
Pi's normal tool exposure and loader behaviour still apply. Restoring an older
Relay session grants the same access; no new conversation is required.

Relay and its workers have normal **owner-level ACB access**, not a sandbox or an
OS-permission bypass. That includes the owner's existing SSH/sudo and application
workflows where configured. Untrusted page/file/report content can reach a
full-access agent, just as in an ordinary ACB chat. Existing instruction,
credential, personal-detail confirmation and change/deployment rules still apply.
The voice panel's Cancel work job control only cancels its tracked worker; other
workers remain ordinary ACB chats and use existing stop controls.

Worker reports are evidence, not owner authority. Report-triggered runs may read
status/docs, but cannot authorise new mutating job actions. A queued report also
removes that authority until another owner message arrives.

Uncertain create/start/follow-up outcomes remain flagged across restart. Relay
must not repeat them, even under a new model tool-call ID. Inspect the worker
transcript, delegation record and external state, and continue manually in the
existing worker if appropriate. Do not create another worker to bypass uncertainty.
The server's durable transport receipts deliberately distinguish submitted from
uncertain; an ambiguous receipt is not a success acknowledgement.

There is no autonomous job polling, standing proactive mandate, dedicated telephone
integration, new monitoring timer, credential store, vector memory or duplicated knowledge base.
Existing docs are the map; live checks establish present facts.

## Audio and retention

**Default:** LFM3-Audio-2B speech understanding/generation and CPU Whisper small.en
run on Server4. Whisper separately recognises owner input for Pi and aligns actual
output audio for approximate played-prefix history. Every owner utterance routes
through `relay_request` to Pi (`local_chat` is disabled so LFM never guesses
capabilities or facts on its own). `relay_request` takes no arguments; unknown
calls or model-written instructions are rejected. The Server4 transport has no
work credentials or tools.

Pi supplies policy/configuration over existing `/api/chat`. A same-origin,
source-window-checked iframe carries audio through the existing authenticated
`/experiments/lfm-voice/` transport; no new ACB listener/model endpoint. Pi results
and worker reports return as native tool output, with further tools disabled for
narration. Reports queue behind owner speech; they cannot authorise work. Long Pi
answers are referred to the full saved chat rather than silently clipped for speech.

Every Start refreshes bounded recent recognised/acknowledged played context and
Pi work evidence. Reopening does not replay audio or work, reconstruct every
native audio turn, or guarantee the last unacknowledged words were saved. The
voice connection has 30-second input/30-turn/10-minute limits; ending it does not
end Pi work. It reserves Server4's GPU: Qwen/local image work cannot coexist.
Choose cloud work or end voice/use legacy before work needing that GPU.

**Legacy** shares `/voicetest`'s STT, Silero VAD and sentence-streamed Kokoro.
`/voicetest` itself is unchanged. Text context/direct tools go to Venice and
delegated context to the selected worker provider; even local voice history may
be included in a later work turn. Existing credential/PII confirmation rules
still apply. Raw audio is not archived. Recognised text, approximate played text,
normal Pi transcripts, checkpoints and worker reports persist in ordinary private
sessions, with no automatic expiry; backups may retain deleted sessions. Generated
text is not proof of playback or acoustic hearing. Closing is not a summary request.
The standalone LFM page remains tool-free and does not save conversations.

## Checks

- `tests/lfm-relay.test.ts`: voice-only saving without work, current configuration,
  no-argument policy, request journalling/deduplication/queues, uncertain restart,
  report/abort handling and explicit long-answer deferral.
- `tests/relay.test.ts`: native-file persistence/restoration, work model selection,
  one-job identity, uncertain starts/follow-ups, duplicate turns, report authority,
  full tool access/restoration, late-loaded tools, provider output limits and explicit cancellation.
- `tests/internal-sessions.test.ts`: authenticated stop transport, durable stop
  markers and no revival of a closed worker; existing registry/recovery tests
  cover process groups and conservative restart handling.
- `tests/ui-smoke.test.ts`: real browser bundle with fixture wire events, separate
  socket, native streamed replies, saved history without speech/work replay,
  resume/new conversation, explicit cancellation, local/legacy selection,
  fresh voice configuration, source-window checks and no Pi abort/Kokoro request
  from local Interrupt (while explicit Stop current Pi turn sends a single abort). Shared voice tests initialise
  actual local Silero assets with synthetic audio, never the real microphone.
- Live functional checks should use an isolated loopback server/session/record
  store and harmless temporary fixtures; suppress test Telegram delivery. Verify
  a real worker report, a needs-input answer, restart/reconnect identity, an actual
  fixture edit/test, cancellation and no duplicate submission. These consume model
  credit; they are not health probes or scheduled checks. Real microphone acceptance
  is an owner test, not established by synthetic browser/fixture checks.
