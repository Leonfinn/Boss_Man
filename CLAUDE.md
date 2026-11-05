# Boss Man: before you hand work in

Inside an agent session `scripts/check-all.sh` refuses to run (exit 2): the full check runs at the merge gate, and a hand run fills its one-slot queue. Run `scripts/check-quick.sh` from the repo root for your branch instead, and fix anything it reports before you move a ticket to review (reviewers run it too). It works out what your branch changed against `origin/main` and runs only what that touches, in 2 to 5 minutes: the merge check, the migration lint, typecheck of the touched packages, the vitest files related to your changes, ShellCheck when shell scripts changed, and the web build when web code changed. It prints one PASS or FAIL line per step. Typecheck and vitest wait for the merge gate's one-slot check lock ("waiting for a free check slot"), so a run may queue; do not start another or kill it. If your change touches app.ts, main.ts or mcp.ts, or more than 15 test files are related, it prints `SKIP related tests` (the gate runs them); `CHECK_QUICK_FORCE_RELATED=1` forces them, and the merge gate's own run (BOSSMAN_MERGE_CHECK set) never skips. Set `CHECK_ALL_FORCE=1` for a full run only if the CEO asked for one (for example a ticket the gate has bounced twice, or a change to `check-all.sh` or the test setup). Humans and the merge gate are unaffected.

The full check, `scripts/check-all.sh`, takes 30 to 50 minutes and runs everything CI's `check` job does that works without Docker: the script tests and lints, `pnpm typecheck`, `pnpm test`, `pnpm build`, ShellCheck (`scripts/check-shell.sh`, where info-level findings fail too) and the shell scripts' tests (`scripts/test-shell.sh`).

Boss Man runs the full check before it merges approved work, so anything it reports blocks the merge.

- Changed `apps/server/src/db/schema.ts`? Generate the migration with drizzle-kit and commit it.
- Added a shell script? Add it to `scripts/check-shell.sh`. Added a `*.test.sh`? Add it to `scripts/test-shell.sh`.

## Running a full check by hand

Inside an agent session `check-all.sh` refuses to run: use `scripts/check-quick.sh` (above). When the CEO asks for a full run, set `CHECK_ALL_FORCE=1` and start it detached, never as a harness background task (the harness kills those when your run ends):

```
CHECK_ALL_FORCE=1 setsid nohup scripts/check-all.sh > "$(git rev-parse --git-dir)/check.log" 2>&1 &
```

Read that log for the `check-all: everything passed` line or a non-zero exit. A check that was signalled writes `check-all: killed by signal <name>` to the log and frees its queue place. Never kill another agent's process (no `pkill -f check-all.sh`, no `killall`): that kills their queued checks.
