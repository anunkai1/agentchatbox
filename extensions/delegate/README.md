# ACB delegation

Pi owns the delegation workflow; ACB only transports ordinary worker chats and
reports. `/delegate [model] <task>` and `/d` request delegation. `/d status` lists
the last ten delegations across chats, newest-created first, with their recorded
status, full folder path, last update and parent/worker links.

## Dispatching and retaining context

- Delegate only with the owner's approval, not for ordinary requests by default.
- First use `delegate_status` to look for the same topic. Compare the title,
  original task and parent chat; sharing a repository does not make two tasks
  related. Continue a relevant worker with `delegate_message` instead of losing
  its context in a new chat. Follow-ups still report to its **original parent**.
- For an explicitly delegated request containing independent tasks, dispatch them
  independently/concurrently where appropriate. Keep tightly dependent work
  together. Give the owner all session links and end the turn **after all
  dispatches**, without waiting or polling for completion.
- Workers inherit the current model and thinking level unless the owner specifies
  a model. No additional worker limit, repository lock or one-worker-per-repo rule
  is introduced; ACB's existing live-session capacity still applies.

## Brief template

Workers cannot see the parent conversation. The `delegate` tool and `/d` request
prompt guide the orchestrator to supply a self-contained `task`, for example:

```text
Goal and why:
Restore the journal page so the owner can read historical entries.

Known facts:
- Relevant repository and paths, exact observed errors, owner's words.
- Only facts already supplied or verified; label unknowns rather than inventing.

Done when:
- Required behaviour and scope.
- Checks to run and evidence to return (changed paths, test results, limitations).
```

Investigate missing details where possible; ask the owner only when genuinely
blocked. The extension adds this instruction to **every initial worker brief**:

> You are not alone. Other workers may be editing this repository; preserve their
> changes and do not undo them.

This is collaboration guidance, not an editing lock or a new permission rule.
Existing server instructions for commits, pushes and deployment still apply.

## Reports

Call `delegation_report` and end the turn. Reports should normally be under 300
words, in this order:

1. **Result** — what was achieved, or the blocker/decision needed.
2. **Evidence** — changes and checks actually run; distinguish unperformed checks.
3. **Open questions** — remaining issues or none. For `needs_input`, give the exact
   question and useful findings/options/recommendation. For `failed`, include
   partial work and a useful next step.

Pi workers are reminded to report on every turn, including resumed turns.
Both Pi and Claude Code accept an explicit closing `Status: done`,
`Status: needs_input` or `Status: failed` line. This also works after switching
an existing worker from Claude Code to Pi. A structured `delegation_report`
takes precedence; cancellation and provider errors keep their existing handling.
Without either explicit report format, the conservative fallback remains
`needs_input`; completion is never inferred from ordinary prose.

The existing statuses (`done`, `needs_input`, `failed`), parent delivery,
sequence-based deduplication and Telegram notification behaviour are unchanged.
The parent should assess the evidence against the brief, not invent missing
results.

## Factual status and topic search

`delegate_status` reads the same JSON records in `~/.config/acb/delegations/` as
`/d status` (or `ACB_DELEGATIONS_DIR` when set). It does not query or control running
processes, wake workers, send notifications or change records.

Optional filters are applied **before** paging:

- `worker`: exact worker session id, including older/completed workers.
- `query`: case-insensitive words, all matched against the title/original task.
- `cwd`: exact folder path.
- `parentSessionId`: exact delegating session id.
- `limit`: page size, default 10, up to 50; not a limit on workers.
- `offset`: default 0. Use `nextOffset` to retrieve another page.

Results include the original task/title, full folder path, parent id and links,
worker link, recorded status, creation/update timestamps and the last summary.
Task/report excerpts are limited to 1,000 characters each, with a truncation
marker and `recordPath` to read for complete context. Searches still match the
full original task. `total` is the number of matching records; no matches return
an empty list, not a conclusion that work succeeded or failed.

**These are recorded statuses, not live progress.** `working` is saved at worker
creation or turn start. It does not prove the process is still running;
interruptions can leave stale records. A summary is the last recorded
report and may predate the current turn. Do not infer detailed activity or results
from a timestamp, status or absence of a new report.

## Claude Code mode

A main chat in Claude Code mode (`/cc on`) gets Claude Code workers on the same Claude model, unless the owner names another. The worker chat switches itself on with `/delegate start <id>`, so the owner's messages in it also go to Claude Code.

- Claude Code cannot call pi tools, so the worker ends its last reply with `Status: done`, `Status: needs_input` or `Status: failed`. Without that line the worker counts as needing the owner.
- claude-delegate announces each run on `pi.events` (`claude-delegate:run-start`, `claude-delegate:run-end`), and the worker reports through the same path as a pi worker: status icon, Telegram, and waking the main chat.
- A report for a main chat in Claude Code mode goes to Claude Code (`claude-delegate:run`), not to pi.
- Claude Code in the main chat delegates, messages workers and lists them with `node extensions/delegate/cli.ts` (`help` explains). claude-delegate gives it the chat's ids in `ACB_CHAT_ID`, `ACB_CHAT_MODEL`, `ACB_CHAT_THINKING` and `ACB_CLAUDE_MODE`.
- Claude Code starts in the browser-harness workspace, so the brief tells it to work in the task's folder and read that folder's `AGENTS.md` first.
