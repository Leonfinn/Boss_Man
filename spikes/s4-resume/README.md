# Spike S4: resuming a Claude session after a crash (R42)

**Question:** if the runner dies while an agent is mid-tool-call, can the run pick up where it left off with ACP `session/load`? Or does the saved conversation end with a `tool_use` that has no `tool_result`, so the real API refuses it? That failure is what cline/kanban issue #632 describes.

**Method:**
- **Test:** `apps/runner/test/resume-spike.test.ts`, run with `RUN_SPIKES=1`.
- **Adapter:** the real `claude-agent-acp` 0.91.0 with its bundled Claude Code. It runs against the scripted stub model, which now rejects a dangling `tool_use` with HTTP 400, the way the Anthropic API does.
- **Crash:** the adapter's whole process group is killed with SIGKILL while a Bash call waits for permission.
- **Reopen:** a new adapter starts on the same `CLAUDE_CONFIG_DIR` and cwd, then tries `session/load` followed by a "continue" prompt.

**Results:** observed on 16 Oct 2026; three repeated runs gave the same results.

| Crash point | `session/load` | Next prompt |
|---|---|---|
| First tool call of the turn | **Fails: `Resource not found`**. Claude Code hadn't written the transcript yet; only `~/.claude/sessions/*.json` existed. | n/a |
| A later tool call (after two completed calls) | Works. | Works (`end_turn`). Claude Code drops the unsaved tail, including the pending `tool_use`, and inserts an assistant text, so the model never sees a dangling call. **But calls that completed after the last flush run again.** In the test, the MCP `create_ticket` ran a second time. |
| Adapter process only (Claude Code survives) | n/a | Claude Code carries on headless with every permission denied, and finishes the turn on its own. |

**What it means for Boss Man:**
1. **Kill the whole process group.** The runner now starts each adapter in its own process group and ends the group when the run finishes, when the adapter dies, or when the runner shuts down. A Claude Code process can no longer outlive its run. In the test, the group is gone about 1.1 seconds after SIGTERM.
2. **Resume, then fall back.** For an interrupted run:
   - **Try `session/load` first.** Prompt with what Boss Man saw before the crash: the tool calls reported in `run.update` events. Tell the agent to check the state of anything with side effects before redoing it.
   - **If the load fails** (not found, or not supported), start a new session with the same summary.
3. **Make side effects safe to repeat.** A resumed session can repeat calls it already made, so Boss Man's MCP writes should be idempotent per run. For example, `create_ticket` returns the existing ticket when the same run creates the same title again.
4. **Codex is untested.** `codex-acp`'s load support still needs checking, so treat Codex as fallback-only until then.

These results feed into R42, and the recovery work is the next step in the plan.
