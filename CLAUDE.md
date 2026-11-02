# Boss Man: before you hand work in

Inside an agent session `scripts/check-all.sh` refuses to run (exit 2): the full check runs at the merge gate, and a hand run fills its one-slot queue. Run `scripts/check-quick.sh` for your branch instead; set `CHECK_ALL_FORCE=1` only if the CEO asked for a full run. Humans and the merge gate are unaffected.

The full check, `scripts/check-all.sh`, runs everything CI's `check` job does that works without Docker: the script tests and lints, `pnpm typecheck`, `pnpm test`, `pnpm build`, ShellCheck (`scripts/check-shell.sh`, where info-level findings fail too) and the shell scripts' tests (`scripts/test-shell.sh`).

Boss Man runs the same script before it merges approved work, so anything it reports would block the merge anyway.

- Changed `apps/server/src/db/schema.ts`? Generate the migration with drizzle-kit and commit it.
- Added a shell script? Add it to `scripts/check-shell.sh`. Added a `*.test.sh`? Add it to `scripts/test-shell.sh`.

## Running a full check by hand

Start a hand-run `check-all.sh` detached, never as a harness background task (the harness kills those when your run ends):

```
setsid nohup scripts/check-all.sh > "$(git rev-parse --git-dir)/check.log" 2>&1 &
```

Read that log for the `check-all: everything passed` line or a non-zero exit. A check that was signalled writes `check-all: killed by signal <name>` to the log and frees its queue place. Never kill another agent's process (no `pkill -f check-all.sh`, no `killall`): that kills their queued checks.
