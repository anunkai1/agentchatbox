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
3. Use **Send text** first, or headphones and **Start microphone**. A clear work
   request authorises dispatch; discussion is not approval. Relay can inspect
   files and live state directly to choose the owning repository and resolve
   missing facts, and must ask only when scope or destination is genuinely unclear.
4. Talk while the worker runs. Ask for status or send further instructions.
   Worker reports wake Relay; needs-input questions come back to this chat.
5. **Interrupt** stops the coordinator's current turn/audio, including in-flight
   direct tools, but not delegated workers. Stopping the microphone, starting a
   new utterance or hiding the tab also interrupts that current direct turn.
   Closing the dialog/tab also leaves work running. Hidden tabs stop microphone
   capture. Microphone capture never restarts automatically.
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

## Ownership and persistence

- `relay.ts` owns model selection, prompt, tools and lifecycle in Pi. It uses the
  **native Pi agent loop**, normal user/assistant/tool messages and compaction,
  not a second conversation/task framework.
- `acb-relay-state` custom entries in that same Pi session hold the captured work
  model, associated worker ID and uncertain-submission flags. Turn/action entries
  prevent repeated accepted commands. Before network side effects, checkpoints
  flush the existing session journal and its directory; there is no new database.
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

Shares `/voicetest`'s local STT, Silero VAD, sentence-streamed Kokoro, microphone
release and latency display. Conversation and direct tool context go to Venice;
delegated work context also goes to the selected worker provider. Full access
widens which files and tool results may enter model context; credentials must
still be loaded without printing them or putting them into transcripts. No raw audio archive is saved.
Normal Pi transcripts, compaction checkpoints and worker reports retain text.
Generated text does not prove every word was played/heard. Pausing/closing Relay
is not a final conversation-summary request.

## Checks

- `tests/relay.test.ts`: native-file persistence/restoration, work model selection,
  one-job identity, uncertain starts/follow-ups, duplicate turns, report authority,
  full tool access/restoration, late-loaded tools, provider output limits and explicit cancellation.
- `tests/internal-sessions.test.ts`: authenticated stop transport, durable stop
  markers and no revival of a closed worker; existing registry/recovery tests
  cover process groups and conservative restart handling.
- `tests/ui-smoke.test.ts`: real browser bundle with fixture wire events, separate
  socket, native streamed replies, saved history without speech/work replay,
  resume/new conversation and explicit cancellation. Shared voice tests initialise
  actual local Silero assets with synthetic audio, never the real microphone.
- Live functional checks should use an isolated loopback server/session/record
  store and harmless temporary fixtures; suppress test Telegram delivery. Verify
  a real worker report, a needs-input answer, restart/reconnect identity, an actual
  fixture edit/test, cancellation and no duplicate submission. These consume model
  credit; they are not health probes or scheduled checks. Real microphone acceptance
  is an owner test, not established by synthetic browser/fixture checks.
