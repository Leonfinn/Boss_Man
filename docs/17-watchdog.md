# Scrum Master watchdog (BOS-58)

Every few minutes Boss Man runs rule checks over each company's board, with no model and no tokens. It wakes the company's Scrum Master only when a rule trips: once per sweep, with the whole list of problems (about 30,000 characters of it; anything beyond waits for the next sweep), so a busy board costs one run, not several. A wake the scheduler drops leaves the flags due and is tried again after 15 minutes. If more than three tickets wait on the owner, they get one summary notification. It is **on by default** for a new or imported company (BOS-762, DR-041), but it wakes nobody until the owner picks a Scrum Master in Settings → Watchdog. An existing company keeps the setting it has; the owner switches it off there.

The plan, with the agreed data shapes, is on the wiki: `product/analysis/scrum-master-watchdog-plan-bos-58`.

## Where things are

- `apps/server/src/services/watchdog-rules.ts`: the rules, as one pure `evaluate(snapshot, settings, now)`. The live sweep and the backtest both call it.
- `apps/server/src/services/watchdog.ts`:
  - the sweep, which loads a snapshot, opens and closes flags and wakes the Scrum Master
  - the Scrum Master's actions
  - the hourly cap and trip
  - undo
  - settings and the read API
- `apps/server/src/services/alert-ladder.ts`: Boss Man's own alerts (a wake-chain loop, a runaway, a stalled run) and the climb from the Scrum Master to the CEO to the owner.
- `apps/server/src/services/watchdog-summary.ts`: the daily summary the owner reads.
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
| `idle_agent` | in progress with nothing scheduled, and for `idleAgentMinutes` (default 15) either no run has started on it since it entered in progress, or the run that picked it up ended normally and nothing has run since (BOS-659) |
| `unstarted` | ready and assigned, every ticket it waited on is done or cancelled, and no run has started on it for `idleAgentMinutes` after it was freed (BOS-659) |
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
- `alerts`: Boss Man's own alerts that are with the Scrum Master
- `resolve_alert`: close an alert once dealt with (`rewake: true` wakes the dropped agent again); a stalled-run alert takes the answer "Keep waiting" or "Cancel run"
- `pass_alert`: hand an alert on to the CEO

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

The next one over the cap pauses the watchdog for one hour; it stays switched on. `trip()` sets `watchdog_tripped_at`, logs `tripped`, raises one alert to the CEO and sends the owner one Page ("The watchdog paused itself for an hour"). After the hour the sweep clears the pause by itself (`resumeExpired`), so nobody needs to switch it back on. The sweep wake is exempt from the ticketless-wakes limit (6 an hour per agent); the other scheduler limits still apply. When the run cap trips, the owner's notice says how many problems were due and from which rules. The backtest uses the same one-wake-per-sweep count and reports when the cap would first trip.

## Record-only mode (BOS-166)

Settings → Watchdog has a **Record only (rehearse)** tick (`recordOnly`, off by default), meant for a first day of watching before the full switch-on.

While it is on, a sweep is a rehearsal:
- The rules still run, and flags still open, refresh and close on their normal schedule (including the back-off on repeat flags), so the board, the health chip and **Open now** are exactly what they would be.
- The watchdog itself does nothing to anyone. There is no Scrum Master wake, nudge, assignment, escalation or reminder, no Page to the owner, and no daily summary sent. The Scrum Master's own `watchdog` tool actions are refused with a message saying the watchdog is only recording.
- **Boss Man's own alerts are not silenced.** A wake-chain loop, a runaway or a stalled run still raises its alert, and the ladder still climbs: the Scrum Master rung is skipped (it could not act in this mode anyway) with a `record_alert_skip` row saying so, the CEO takes it, and past the limits it reaches the owner. Record-only is meant to be no riskier than simply switching the watchdog off, so a problem on rehearsal day still gets to someone. No alert is ever left sitting on a rung until the rehearsal ends.
- Nothing spends the hourly cap and a rehearsal can never trip it. The rows are written with a `recorded` mark and never count toward the once-per-hand-off rule.
- Each thing it would have done is written to `watchdog_actions` as `record_sweep_wake` (one per hand-off, naming the flags), `record_owner_reminder`, `record_auto_escalate` or `record_urgent_page` (plus `record_alert_skip` when one of Boss Man's own alerts passes the Scrum Master by). The Scrum Master view badges them **Not sent** and offers no Undo; the health chip reads "record only (not acting)".
- The daily summary is still built and written to the activity log, marked "Record only …" and "Would have done (not sent)", instead of going to the owner; a day with only rehearsals still reports.
- Untick it and the next sweep acts for real: anything still due is handed over then. Switching the watchdog off works as before.

It is the owner's choice alone, like switching the watchdog on: the settings route is owner-only, and an agent's workflow-retro proposal may not include it, so a proposal can't quietly silence the watchdog.

What it can't show: the owner and the Scrum Master react to nothing during the rehearsal, so a flag that would have been nudged away stays open and may climb (back-off, auto-escalation) exactly as if nobody had acted.

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

- **Scrum Master view** (sidebar → Scrum Master): an **Open now** section above the timeline lists every warning the health chip counts, with the ticket, the warning, who has it, what was done and what happens next. If nothing is open it says so. A finished or cancelled ticket settles its warning automatically with a plain note. The timeline groups a warning's entries, shows each as open or settled, and tells a repeat warning on one ticket apart ("2nd warning on BOS-149 today"). Every logged action keeps its one-line reason and an Undo while one is possible; a record-only entry (BOS-166) is badged "Not sent" and has no Undo. The same list, filtered to one ticket, shows on the ticket page. Sweep wakes are hidden from the company view.
- **Health chip** on the board: "Watchdog: last check 3 min ago · 2 issues being handled", or "off", or "paused after hitting its hourly limit, back in N min" (amber), or "record only (not acting)" while rehearsing. Amber when no check has run for 15 minutes.
- **Daily summary** (`dailySummary`, run after each sweep): a "note" in the owner's feed, from 8:00 owner-local time, at most once a day, and only if something was caught, cleared or done since the last one. It carries counts, what is still open and who it waits on, owner decisions with their age, and a headline (stuck tickets and the oldest). Owner-decision waits are not counted as stuck.
- **Urgent** (`urgentCheck`): one owner decision holding three or more unfinished tickets sends a Page (once per decision). The "holds" count follows the chain: the ticket the decision blocks plus every unfinished ticket waiting on it, directly or further down. The other Page-level case is the watchdog pausing itself at its safety cap: `trip()` pages the owner once per pause (the alert it also raises goes to the CEO). Those two are the only interrupts; the 8-hour decision reminder stays a quiet flag. Both are logged as `urgent_alert` and `daily_summary` actions.
