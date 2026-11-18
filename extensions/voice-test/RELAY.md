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
   then press **R** or enter `/relay` (or `/relay new` / Shift+click **R** for a
   fresh thread). If you are in an existing chat with messages, pressing **R**
   converts that chat into a Relay conversation from that point onwards while
   keeping its history and title; from an empty new chat, pressing **R** opens
   your saved Relay thread (or a fresh one). Relay captures your chat's model
   and thinking selection for its tracked worker, rather than Global's default for
   newly opened chats. Relay's own direct work runs on the conversation model;
   additional workers use the normal delegation tools' model-selection behaviour.
2. The panel shows **Answers & tools: DeepSeek Flash · thinking off** and a separate **Delegated
   work** model/thinking line. Conversation uses
   `venice/deepseek-v4-1-flash-1017`; work uses the captured ACB selection. Workers
   use native Pi, not the originating chat's `/cc` mode.
3. The default when unset is **Pi + Server2 ZONOS3-Mini (speech-only, aligned)**
   (`acb-relay-voice-engine = "zonos3"`, or `/relay zonos3`). Browser Silero VAD +
   Server2 Fluid Speech Pro STT → full-access Pi → rendered `SpokenMarkdown`
   sentences → Server2 `zonos-relay-tts` (loopback 8184, neutral `Savannah` voice,
   44.1 kHz PCM16) via `/api/tts/zonos-relay-stream` with Layer-7 word-alignment
   timings (`X-Zonos-Alignment: zonos3-probe-v1`). No Server4, GPU voice session
   or ASR listen-back is used. Saved `kokoro` and `legacy` selections are preserved.
   A saved retired `server4` or `lfm-tts` selection changes to `zonos3` on opening
   voice. This updates only the device preference, not the saved conversation.
   **Use Pi + Server2 Kokoro (aligned)** (`"kokoro"`, or `/relay kokoro`)
   explicitly selects Server2 Kokoro (loopback 8181, 24 kHz) via
   `/api/tts/relay-stream` with synthesis-token timings (`kokoro-pred-dur-v1`).
   **Use legacy STT/Kokoro** (`"legacy"`, or `/relay legacy`) explicitly selects
   the older speech path without Server4 GPU dependency. This device remembers
   the explicit choice without silently migrating saved sessions or falling back.
   **New Relay conversation** sits directly beside **Voice settings & details** on
   the primary drawer, and **Voice settings & details** expands the engine choices,
   technical/privacy information and timing metrics. Opening
   these details does not change settings or start work. Engine changes remain
   explicit and preserve the saved session. The mic button shows its startup
   state and whether the microphone is on; it is disabled during startup to avoid
   duplicate permission requests. **Pause voice** / **Resume voice** (in
   browser-STT Relay modes and on the collapsed strip) mutes the microphone and
   suspends voice playback without discarding unsent speech or stopping Pi work.
   Aligned ZONOS3-Mini/Kokoro modes label speech interruption
   **Stop speaking**, separate from **Stop current Pi turn** and the tracked job's
   **Cancel work job** (only shown when a tracked job exists). **End voice** /
   **Close Relay** stay usable even if connection setup fails. Controls sit in a
   non-modal side drawer on desktop or a bottom drawer above the composer on
   smaller screens. **Minimise** (or Escape within the drawer) leaves voice running
   with a persistent microphone/status strip, **Pause voice** / **Resume voice**,
   and **End voice**. Press **R** or the strip to reopen controls. There is no second transcript or text box: recognised
   speech, typed input, streamed full answers and tool activity share the normal
   chat timeline and connection. Played-speech evidence is separate and collapsible:
   synthesis-aligned in ZONOS3-Mini and Kokoro. Older labelled playback evidence
   stays as saved. None replaces the full answer. Reading earlier messages does
   not pull the page away. Legacy **Interrupt** retains its existing direct-turn
   abort behaviour.
   Browser STT modes allow about 0.5 seconds of quiet before recognition. If you
   resume during recognition, earlier unsubmitted audio is kept and joined with
   the next segment; stale partial transcripts cannot dispatch work. This is
   bounded to **two minutes of unsent audio** (including continuous speech),
   not an unlimited dictation buffer. Accepted turns reset this budget; the mic
   stays open across turns. Hitting the limit stops capture explicitly without
   submitting a partial instruction. The separate `/voicetest` prototype keeps
   its 30-second test limit.
   **Interrupt** stops output without discarding that input. Stopping/hiding/closing
   the mic clears unsent input; typed submission explicitly replaces it.
   In browser-STT Relay modes, an active microphone requests a screen wake lock
   while the tab is visible, if the browser and power settings allow it. Switching
   away releases the mic and stops speech. Returning to the same open tab restores
   a microphone that was on once the same chat is reachable. **Pause voice**,
   **Stop microphone** and **End voice** are respected; if audio access fails, tap
   **Start microphone** to retry. Reloading or reopening the page does not turn the
   mic on. Background and locked-screen listening are not supported.
   The normal chat composer reaches Pi without a mic. During a thread switch it
   is temporarily disabled; the source draft is retained in its original chat.
   A clear work request authorises
   dispatch; discussion is not approval. Relay can inspect files and live state
   directly to choose the owning repository and resolve missing facts, and must
   ask only when scope or destination is genuinely unclear.
4. Talk while the worker runs. Ask for status or send further instructions.
   Worker reports wake Relay; needs-input questions come back to this chat.
5. In **Pi + Server2 ZONOS3-Mini** and **Pi + Server2 Kokoro**, speaking over a
   reply or **Stop speaking** stops speech only: Pi direct tools and workers
   continue. **Stop current Pi turn** explicitly aborts the active Pi turn;
   queued voice requests and workers may continue. Completed effects remain.
   End/hide/close releases the microphone without cancelling Pi work.
   **Legacy mode differs:** its Interrupt or new speech can abort the current Pi
   direct turn, though delegated workers survive. Hiding, losing the connection,
   or stopping the microphone does not abort Pi. Closing voice or
   navigating away from a Relay thread leaves Pi tools and workers running:
   navigation detaches the old view without killing its Pi process.
6. Reopen `/relay` to resume the saved conversation and associated job. The
   browser remembers the session ID on this device; it never replays utterances,
   work submissions or old speech. The saved transcript and worker chat are also
   ordinary ACB sessions. On another device, use those session links for text
   continuity; cross-device voice-session discovery is not implemented.
7. **Cancel work job**, or explicitly ask Relay to cancel it, to terminate the
   worker. This stops its process group and queued work, and blocks automatic
   restart recovery for that execution. It cannot undo completed external effects.
8. **New Relay conversation** creates a fresh coordinator, keeping the work-model
   selection captured when these controls were opened. It does not cancel the previous worker. Use this for
   a clean conversation or a new tracked worker. It is not required for unrelated
   direct work or additional normal delegations; keep follow-ups with their worker.

## Formatted replies and speech

Normal Relay's aligned ZONOS3-Mini, aligned Kokoro, and legacy Kokoro routes render Markdown before
sentence splitting. Headings, emphasis, lists and links stay formatted in the
panel, while synthesis receives readable prose rather than literal Markdown
markers or link destinations. Split/incomplete formatting is buffered. A later
revision to already-emitted speech stops remaining audio rather than replaying
or guessing. Restored replies render silently; saved Pi answers are unchanged.
This formatting behaviour does not change the legacy cancellation differences
above or select a different voice/engine.

## Synthesis-aligned playback history (ZONOS3-Mini & Kokoro)

Default Relay uses `/api/tts/zonos-relay-stream`, which negotiates
`X-Zonos-Alignment: zonos3-probe-v1` with loopback 8184 (`zonos-relay-tts`, 44.1 kHz
PCM16, neutral `Savannah` voice, emitting an empty pre-word block for pre-speech
audio and flushing any tail word on EOF). Explicit `/relay kokoro` uses
`/api/tts/relay-stream`, which negotiates `X-Kokoro-Alignment: kokoro-pred-dur-v1`
with loopback 8181 (24 kHz WAV chunks). Normal chat TTS, legacy Relay, `/voicetest`,
KidStories and Lappy remain unchanged. Each 380-character-capped synthesis request
supplies exact `submittedText`, sample offsets and per-token end samples before
its audio chunks. Multiple requests accumulate on the same progressive player's
output clock; queued or half-played words are not retained. Zero-play records no
spoken text.

`voice_context.data.heard` says **ZONOS3-Mini synthesis alignment** or **Kokoro
synthesis alignment**, retains only completed input tokens, and explicitly says
pronunciation and hearing are not verified. This is model-duration alignment of
synthesis input, not ASR, acoustic verification or proof the owner heard it. Full
Markdown remains in the ordinary Pi transcript. Truncation, unknown mappings,
missing negotiation and stream failures are labelled incomplete/uncertain; no
proportional timing, whole-answer fallback, automatic resubmission or tool/worker
cancellation is introduced. The interruption tick remains gated on actual
output-clock playback.

Backend token text can omit punctuation even when `alignmentComplete` is true:
`[code block]` yields `[code block`, and `It costs $5.00.` yields `It costs 5.00.`.
Reconciliation tolerates whitespace plus decorative brackets/quotes around the
same word sequence, but never changes number spellings, currency, signs or words.
The record uses returned token text, never reconstructed chat/source text.
Unreconciled or explicitly incomplete chunks still play validated PCM; only their
actually played sample span is marked `[UNKNOWN_WORDS:audio_samples=…]`.
Known completed tokens before and after that gap remain available; queued unknown
chunks do not taint a prefix that has not reached them. Unknown markers are
annotations, not claimed speech or confirmations. Invalid protocol/sample ranges,
wrong submitted input or malformed audio still fail safely and preserve prior
playback evidence. Read full chat for any unknown value. `/relay kokoro` selects the local fallback;
`/relay zonos3` returns without changing the saved conversation.

Manual check: request `Hello world.`, interrupt between the end of `Hello` and
`world`, and inspect the collapsible played record. Only `Hello` should remain,
labelled synthesis alignment, while the full answer and any Pi work remain intact.
Repeat at zero playback and with an unsupported mapping: no invented words or
confirmation. The opt-in `KOKORO_LIVE=1` test uses the deployed backend with a
**simulated** browser output clock and verifies persisted Pi context; it does not
claim an acoustic/headphone check.

## Isolated streaming trial

`/relaytrial` opens **Trial A — streaming Pi voice**: local STT → the same
full-access Pi/DeepSeek Relay → sentence-streamed **ZONOS3-Mini** (default) or
**Kokoro** (`/relaytrial kokoro`). It begins speaking while Pi is still generating.
Its saved choice (`acb-relay-trial-engine`) and session (`acb-relay-trial-stream-session`)
are independent of normal Relay. A saved retired trial engine changes to ZONOS3-Mini
on opening without changing either chat ID.

The speech path renders Markdown before sentence splitting, so headings, list
markers, emphasis and link destinations are not read as formatting characters,
while the chat log renders the formatted Markdown. Incomplete formatting is
buffered; large code blocks use the existing spoken cue. If later Markdown
revises already-emitted text, speech stops explicitly rather than replaying it;
Pi work continues.

Interrupt, barge-in and hiding the tab stop speech, not Pi work. **Stop current
Pi turn** is the explicit coordinator abort; **Cancel work job** remains separate.
After an interruption, further output from that ongoing turn stays muted until
a new owner turn. Restored history is never replayed as speech.

Kokoro trial evidence records finished segments and marks cuts uncertain. ZONOS3-Mini
uses the synthesis-aligned playback evidence above. Neither proves acoustic hearing.

## Ownership and persistence

- `relay.ts` and `relay-voice.ts` own model selection, voice policy, tools and lifecycle in Pi. It uses the
  **native Pi agent loop**, normal user/assistant/tool messages and compaction,
  not a second conversation/task framework.
- `acb-relay-state` custom entries in that same Pi session hold the captured work
  model, associated worker ID and uncertain-submission flags. Turn/action entries
  prevent repeated accepted commands. Before network side effects, checkpoints
  flush the existing session journal and its directory; there is no new database.
- Recognised input and labelled playback evidence are custom entries in
  the same Pi session. The first actual utterance materialises it through the
  guarded session-manager API without launching Pi work. Each
  `voice-request` forwards only its separately captured owner text, journalled
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

**Default:** Server2 STT → Pi → ZONOS3-Mini synthesis-aligned speech, as detailed above;
no Server4 voice/GPU session and no audio ASR listen-back.

**Legacy** shares `/voicetest`'s STT, Silero VAD and sentence-streamed Kokoro.
`/voicetest` itself is unchanged. Text context/direct tools go to Venice and
delegated context to the selected worker provider; even local voice history may
be included in a later work turn. Existing credential/PII confirmation rules
still apply. Raw audio is not archived. Recognised text, labelled playback evidence,
normal Pi transcripts, checkpoints and worker reports persist in ordinary private
sessions, with no automatic expiry; backups may retain deleted sessions. Generated
text is not proof of playback or acoustic hearing. Closing is not a summary request.

## Checks

- `tests/relay-voice.test.ts`: voice-only saving without work, request
  journalling/deduplication/queues, uncertain restart,
  report/abort handling and explicit long-answer deferral.
- `tests/relay.test.ts`: native-file persistence/restoration, work model selection,
  one-job identity, uncertain starts/follow-ups, duplicate turns, report authority,
  full tool access/restoration, late-loaded tools, provider output limits and explicit cancellation.
- `tests/internal-sessions.test.ts`: authenticated stop transport, durable stop
  markers and no revival of a closed worker; existing registry/recovery tests
  cover process groups and conservative restart handling.
- `tests/ui-smoke.test.ts`: real browser bundle with fixture wire events, separate
  socket, native streamed replies, saved history without speech/work replay,
  resume/new conversation, migration without changing chats, engine selection,
  speech-only interruption and explicit Pi stop. Shared voice tests initialise
  actual local Silero assets with synthetic audio, never the real microphone.
- Live functional checks should use an isolated loopback server/session/record
  store and harmless temporary fixtures; suppress test Telegram delivery. Verify
  a real worker report, a needs-input answer, restart/reconnect identity, an actual
  fixture edit/test, cancellation and no duplicate submission. These consume model
  credit; they are not health probes or scheduled checks. Real microphone acceptance
  is an owner test, not established by synthetic browser/fixture checks.
