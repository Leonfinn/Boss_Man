# Scrum Master watchdog (BOS-58)

Every few minutes Boss Man runs rule checks over each company's board, with no model and no tokens. It wakes the company's Scrum Master only when a rule trips: once per sweep, with the whole list of problems (about 30,000 characters of it; anything beyond waits for the next sweep), so a busy board costs one run, not several. A wake the scheduler drops leaves the flags due and is tried again after 15 minutes. If more than three tickets wait on the owner, they get one summary notification. It is **off by default**. The owner picks the Scrum Master and switches it on in Settings → Watchdog.

The plan, with the agreed data shapes, is on the wiki: `product/analysis/scrum-master-watchdog-plan-bos-58`.

## Where things are

- `apps/server/src/services/watchdog-rules.ts`: the rules, as one pure `evaluate(snapshot, settings, now)`. The live sweep and the backtest both call it.
- `apps/server/src/services/watchdog.ts`:
  - the sweep, which loads a snapshot, opens and closes flags and wakes the Scrum Master
  - the Scrum Master's actions
  - the hourly cap and trip
  - undo
  - settings and the read API
- `apps/server/src/services/watchdog-backtest.ts`: replays the rules over history.
- `apps/server/src/main.ts`: the `watchdog` loop. It runs on the leader only, every `BOSSMAN_WATCHDOG_MS` (default 5 minutes).
- `apps/server/src/mcp.ts`: the Scrum Master's restricted tool server (`SCRUM_MASTER_TOOLS`) and its `watchdog` tool.
- `packages/shared/src/watchdog.ts`: the settings schema and defaults, plus the rule and action names.

## Data

- `tickets.state_changed_at`: set by the `tickets_state_clock` trigger whenever `system_state` changes, so every write path counts. A write that sets the column itself keeps its value.
- `tickets.blocked_until` and `blocked_until_reason`: the optional "blocked until" pair (BOS-59 builds the UI and tool). The same trigger clears both whenever the ticket isn't blocked.
- `companies.watchdog` (jsonb settings), plus `watchdog_tripped_at`, `watchdog_tripped_reason` and `watchdog_last_sweep_at`.
- `watchdog_flags`: one row per (ticket, rule) episode, with at most one open at a time. `due_at` is when it may next be handed on.
- `watchdog_actions`: every action, with actor (agent and run), kind, one-line reason, before/after for undo, and who undid it. Each one also writes an `activity` row of kind `watchdog`.

## Rules and their exceptions

All limits are in settings. A rule never trips while a run works on the ticket; the clock pauses rather than resets. A ticket already in the owner's queue through another sweep (missed work, merge stuck, review stall) is not handed on as well.

| Rule | Trips when |
|---|---|
| `unassigned` | ready or in progress with no assignee, for `unassignedMinutes` |
| `run_crashed` | the assignee's last run ended abnormally (an outcome other than `end_turn`, `cancelled`, `max_tokens` or `max_turn_requests`), at least 45 minutes ago, with nothing scheduled |
| `run_ended_unmoved` | the assignee's last run ended at least 45 minutes ago without the ticket's state changing, with nothing scheduled |
| `stale_in_progress` | in progress with no movement for `inProgressHours`, not counting the assignee's run time |
| `stale_review` | in review with no movement for `reviewHours`, not counting run time on the ticket |
| `stale_blocked` | blocked for `blockedHours` with no open holder and no "blocked until" date |
| `blocked_until_passed` | past `blocked_until` + `blockedUntilGraceHours` |
| `review_loop` | sent back more than `reviewBounces` times; due again on each further send-back |
| `owner_decision_waiting` | an open owner decision has held it for `ownerDecisionHours`; Boss Man reminds the owner once and the Scrum Master is never woken |

- **Why 45 minutes:** Boss Man's own free fixes get the first go: recovery of an interrupted run, the 15-minute "carry on" check, and the missed-work nudge after 30 minutes. The Scrum Master is told only when those didn't move the ticket.
- **Scheduled work:** a scheduled check, or a queued wake that will happen, on an in-progress ticket is a plan, not a stall. A wake parked behind a paused agent is not a plan: the ticket is still checked.
- **Held by another ticket or an engagement:** the held ticket is never flagged. The holder is judged on its own, and its flag says how many tickets it holds.
- **Scheduled work, in detail:** a check set by the assignee for a time still ahead keeps every in-progress rule quiet, including the crashed and ended-run ones. The backtest reads checks back from the "scheduled a check" and "carry on" activity rows; a check that left no row there is the one thing it can miss.
- **Back-off on repeat flags:** once a flag has been handed to the Scrum Master, the next hand-off for the same ticket and rule waits the rule's limit, then twice that, then four times, and so on, capped at 24 hours (`watchdog_flags.backoff_steps` counts the hand-offs in a row). The wait starts over when the ticket changes state, gets a comment or starts a run since the last hand-off, when the flag clears (a new flag starts at the first step), or on another send-back for `review_loop`. The owner reminder and the automatic escalation to the CEO are not delayed by it. The live sweep and the backtest share `backoffGapMs` in `watchdog-rules.ts`. The hourly cap is unchanged: the back-off is how a quiet week stays under it.
- **Coming back soon after clearing:** a problem that clears and comes straight back waits out the rest of its limit since the last hand-off, snooze or escalation.

## Scrum Master actions

The agent with duty `scrum_master` gets the read tools, `ticket_reply` and `watchdog`, and nothing else. `set_ticket_state`, `update_ticket`, `set_ticket_risk`, `assign_ticket`, `create_ticket`, `nudge`, `raise_decision` and `schedule_check` aren't registered for it. Its chat with the owner keeps the chat tools.

The `watchdog` tool's actions are:
- `list`
- `nudge`
- `assign`: unassigned tickets only, to an active agent with no standing job, or `ceo`
- `rewake`: crashed or ended-run flags only
- `chase_review`
- `snooze`: at most 48 hours, and never a third time in a row
- `escalate`
- `raise_decision`

**Limits on every action:**
- Each needs a one-line reason.
- It acts only on an open flag the watchdog handed over.
- One action per flag per hand-off, of any kind (snooze, nudge, escalate and the rest). An undone or refused attempt still counts. Escalating takes only the flag it was given.
- A flag snoozed twice that comes due again goes to the CEO, through Boss Man. The count is per episode (per open flag), not strictly consecutive: a snooze undone by the owner takes one off, nothing else resets it while the flag stays open.
- An escalated flag (by the Scrum Master, or automatically after two snoozes) belongs to the CEO for one rule limit. If it is still open after that, it starts over: the escalation mark and the snooze count are cleared and the Scrum Master gets it again.
- **Wake limit:** the Scrum Master's sweep wake (reason `watchdog`) is exempt from the scheduler's 6-per-hour limit on wakes with no ticket, and doesn't count toward it. The watchdog has its own hourly cap on runs and nudges, so a busy hour can't silently drop a sweep and push every listed flag back by its limit.

**Undo** is the owner's: `POST /api/watchdog-actions/:id/undo`.
- A wake can be undone only before it is delivered.
- An assignment can be undone only if the assignee hasn't changed since.
- A decision can be withdrawn while it is open, and the ticket goes back to its earlier state (through a normal ticket update, so it is versioned and shows in the ticket's history) if nothing else holds it.
- A snooze is cleared.

## Safety cap

Counted from `watchdog_actions` over a rolling hour:
- sweep wakes, against `maxSmRunsPerHour`;
- actions that reach someone, against `maxNudgesPerHour`. These are nudge, assign, rewake, chase review, escalate, auto-escalate and raise decision.

The next one over the cap switches the watchdog off. It sets `watchdog_tripped_at`, logs `tripped`, and sends one "Got it" decision to the owner. Only the owner switching it back on clears the trip. The sweep wake is exempt from the ticketless-wakes limit (6 an hour per agent); the other scheduler limits still apply. When the run cap trips, the owner's notice says how many problems were due and from which rules. The backtest uses the same one-wake-per-sweep count and reports when the cap would first trip.

## Read API (owner)

- `GET` and `PATCH /api/companies/:id/watchdog`: settings, plus `scrumMasterAgentId`; also the health fields (`lastSweepAt`, `trippedAt`, `trippedReason`, `openFlags`).
- `GET /api/companies/:id/watchdog/issues`: every open warning the health chip counts (watchdog flags and Boss Man alerts that name a ticket), with who has it, what was done and what happens next.
- `GET /api/companies/:id/watchdog/flags?status=&ticketId=`
- `GET /api/companies/:id/watchdog/actions?ticketId=&since=`
- `GET /api/companies/:id/watchdog/backtest?days=14`

## Rollback

- **Fastest:** switch it off in Settings. It stops at the next pass.
- **Full:** revert the code. Migration `0061` is expand-only, so older code runs on the new schema. The `tickets_state_clock` trigger only writes the new columns.

## What the owner sees (BOS-60)

- **Scrum Master view** (sidebar → Scrum Master): an **Open now** section above the timeline lists every warning the health chip counts, with the ticket, the warning, who has it, what was done and what happens next. If nothing is open it says so. A finished or moved-on ticket settles its warning automatically with a plain note. The timeline groups a warning's entries, shows each as open or settled, and tells a repeat warning on one ticket apart ("2nd warning on BOS-149 today"). Every logged action keeps its one-line reason and an Undo while one is possible. The same list, filtered to one ticket, shows on the ticket page. Sweep wakes are hidden from the company view.
- **Health chip** on the board: "Watchdog: last check 3 min ago · 2 issues being handled", or "off", or "stopped itself (safety cap hit)". Amber when no check has run for 15 minutes.
- **Daily summary** (`dailySummary`, run after each sweep): a "note" in the owner's feed, from 8:00 owner-local time, at most once a day, and only if something was caught, cleared or done since the last one. It carries counts, what is still open and who it waits on, owner decisions with their age, and a headline (stuck tickets and the oldest). Owner-decision waits are not counted as stuck.
- **Urgent** (`urgentCheck`): one owner decision holding three or more unfinished tickets sends a Page (once per decision). The "holds" count follows the chain: the ticket the decision blocks plus every unfinished ticket waiting on it, directly or further down. The other Page-level case is the watchdog switching itself off at its safety cap: `trip()` pages the owner once per trip (the "Got it" decision it also raises is only a quiet flag). Those two are the only interrupts; the 8-hour decision reminder stays a quiet flag. Both are logged as `urgent_alert` and `daily_summary` actions.
