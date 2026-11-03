# Active-chat restart recovery

Pi-owned, default-on recovery for **normal ACB chats actively executing an owner request** when ACB restarts or the host reboots. It complements delegated-worker recovery rather than changing the worker policy.

## Owner controls

- `/recovery status`: show this chat's setting, request state and whether its automatic attempt has been used.
- `/recovery off`: durably disable recovery for this chat, including its current request.
- `/recovery on`: enable recovery for **subsequent explicit owner requests**. It does not resurrect old work.
- `ACB_SESSION_RECOVERY=0`: disable normal-chat recovery globally (set on both the Pi child environment and startup service).

A normal owner message starts a new allowance. The request may have **one automatic continuation** in its existing session. Another restart during that request requires owner input; restarting the service does not reset the allowance. Synthetic continuations, worker reports and automatic Claude runs do not count as new owner requests. An explicit owner follow-up does. If owner and synthetic inputs are mixed in Pi's reorderable queues, provenance is ambiguous: the extension conservatively retains the existing allowance rather than guessing. A fresh owner request after the run settles rearms normally.

Idle/saved chats, completed requests, explicit stops and pending approval/input dialogs are never automatically executed. A browser reconnect that merely restores an idle Pi process does not prevent safe recovery; an actual native/Claude/compaction execution does. An owner message arriving during recovery takes precedence. Requests must have a saved entry on the session's active branch. Overlapping native/Claude execution with an unsaved prompt is not eligible.

## Implementation and boundaries

- `index.ts` observes owner input, confirms the saved user entry at Pi's pre-model `context` boundary, and records lifecycle/approval state. Claude passthrough emits explicit execution/follow-up activity and distinguishes owner requests from synthetic continuations.
- Private metadata lives in `~/.config/acb/session-recovery/` (`ACB_SESSION_RECOVERY_DIR` override). It contains request identity, saved branch anchor, cwd, model/thinking/engine choice, origin, boot ID, opt-out and allowance state—not credentials or copies of prompts.
- Writes use the shared atomic-rename + file/directory-fsync transport state helper. Corrupt records fail closed. Existing idle/legacy sessions are not retroactively enrolled: the extension must observe a new owner request.
- The existing `agentchatbox-recovery.service` runs `extensions/delegate/recovery.mjs`, now scanning delegated workers and normal requests. It is a separate, bounded startup pass; failure cannot bring down ACB. There is no same-boot crash/stall watchdog.
- The internal transport accepts a stable ID per owner request, durably reserves an ambiguous receipt before submission, and rejects idle-only submissions if native execution, Claude or compaction is active. It checks durable Stop markers before submission. The Pi command independently checks the current request, boot, saved branch, approval state, pending owner input and allowance before consuming the attempt **before** triggering a turn.
- Continuation instructions require inspecting the transcript, working tree, running processes and external state before repeating actions. Uncertain command/deployment/message outcomes require owner input, not blind replay. Recovery restores no extra permissions and never bypasses approvals.
- Ambiguous submission or repeat interruption is recorded as `needs_input`, with a visible non-executing chat notice and owner notification. This is **at-most-once automatic submission**, not exactly-once execution of tools or external actions. Receipts are not deleted to retry work.

Delegated sessions are excluded even when they have old normal-session metadata. They retain their existing **one attempt per worker lifetime** policy; normal chats use **one attempt per explicit owner request**. Neither policy replays never-started queued requests.

Tests: `tests/session-recovery.test.ts`, idle-only transport coverage in `tests/internal-sessions.test.ts`, and existing receipt/delegation/Claude tests.
