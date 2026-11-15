# Boss Man: before you hand work in

> This file is for the AI agents that build Boss Man inside Boss Man itself. It names their merge gate, check queue and roles (the CEO is the agent that runs the team; DR-003 is an internal decision record). If you are a person reading the code, start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Inside an agent session `scripts/check-all.sh` refuses to run (exit 2): the full check runs at the merge gate, and a hand run fills its one-slot queue. Run `scripts/check-quick.sh` from the repo root for your branch instead, and fix anything it reports before you move a ticket to review (reviewers run it too). It works out what your branch changed against `origin/main` and runs only what that touches, in 2 to 5 minutes: the merge check, the migration lint, a check that no two guides in `docs/` share a number, typecheck of the touched packages, the vitest files related to your changes, ShellCheck when shell scripts changed, and the web build when web code changed. It prints one PASS or FAIL line per step. Typecheck and vitest wait for the merge gate's one-slot check lock ("waiting for a free check slot"), so a run may queue; do not start another or kill it. If your change touches app.ts, main.ts or mcp.ts, or more than 15 test files are related, it prints `SKIP related tests` (the gate runs them); `CHECK_QUICK_FORCE_RELATED=1` forces them, and the merge gate's own run (BOSSMAN_MERGE_CHECK set) never skips. Set `CHECK_ALL_FORCE=1` for a full run only if the CEO asked for one (for example a ticket the gate has bounced twice, or a change to `check-all.sh` or the test setup). Humans and the merge gate are unaffected.

Compose files and CI workflows are checked too, so do not write "no Docker here, CI is the real proof" for a structural slip. When a branch changes `docker-compose*.yml`, `deploy/*.yml` or `.github/workflows/*`, check-quick runs `scripts/check-compose.sh`: `docker compose config -q` (every profile on) over each file set a host loads (base, host overlays, deployer, blue/green, Tailscale, staging, ntfy, Penpot) and `actionlint` on the workflows, and a failure names the file and line. The runner has the Docker CLI and compose plugin only: no daemon and no socket, so nothing can start a container and `docker ps` still shows nothing; the deployer's fake-docker tests cover command output. A runner image from before this prints `SKIP compose and workflow validation` until the owner runs Build and update runners. You can run `scripts/check-compose.sh` alone for a quick look.

When the server-owned check queue is on (the owner's switch in Settings → Server and runner → Checks, DR-003), `request_check` is the way to run your quick check: commit, then call the `request_check` tool (`scope: quick` by default; `full` only in the cases above). The runner runs it outside your session, so it survives the end of your run and no agent can stop it, a pass on the same code is reused, and you are woken with the result. Do not poll, start your own background loop, or also run `scripts/check-quick.sh` by hand: a hand run takes runner memory beside the queue's checks. The tool tells you if the queue is off; only then run `scripts/check-quick.sh` yourself as above. The merge gate runs the one full check per merge attempt.

In an agent session a whole-package or whole-suite vitest run (`pnpm test`, `pnpm --filter X test`, `vitest run` with no file, `vitest related` over app.ts, main.ts or mcp.ts) is refused by `scripts/vitest-guard.mjs`; `CHECK_ALL_FORCE=1` overrides. A run that names test files is queued behind the same check lock (`BOSSMAN_VITEST_NO_SLOT=1` skips the queue).

The full check, `scripts/check-all.sh`, takes 30 to 50 minutes and runs everything CI's `check` job does that works without Docker: the script tests and lints, `pnpm typecheck`, `pnpm test`, `pnpm build`, ShellCheck (`scripts/check-shell.sh`, where info-level findings fail too) and the shell scripts' tests (`scripts/test-shell.sh`).

Boss Man runs the full check before it merges approved work, so anything it reports blocks the merge.

- Changed `apps/server/src/db/schema.ts`? Generate the migration with drizzle-kit and commit it.
- Main took your migration number? Leave it. Do not renumber by hand: the merge gate renumbers a branch whose only clash is migration bookkeeping (`rebaseMigrations`, BOS-690), and `scripts/check-quick.sh` accepts that case, printing "migration NNNN will be renumbered to MMMM by the merge gate". A real clash (code, or the same table or column changed on both sides) still fails; see `docs/10-migrations.md`.
- Added a shell script? Add it to `scripts/check-shell.sh`. Added a `*.test.sh`? Add it to `scripts/test-shell.sh`.

## Writing tests: they must pass on GitHub's runners too

A pass at the merge gate is not enough: GitHub CI runs every test again on main, on machines 2.5 to 5 times slower, with a newer git and a cold browser. Authors follow this rule and reviewers check every new or changed test against it:

- **No wall-clock limits tuned to a dev machine.** Time the work against a baseline run in turn on the same machine (`packages/shared/test/permission-judge.test.ts`, "stays fast on a 10,000-char line"), or give GitHub its own limit and say why (`apps/server/test/hot-path-budget.test.ts`, `LIMIT_MS`). Either way, say in a comment what the limit still catches.
- **No fixed sleeps standing in for "the other side is ready".** Wait for the event: the port answering, the line in the log, the file appearing, with a deadline.
- **No hidden stderr** (`2>/dev/null`) on a step whose failure would end the test silently.
- **A test that needs a build or a browser runs at the gate, not quietly skips there.** Make sure the gate (and CI) supply what it needs before relying on it.
- **Don't depend on git's version.** Tests that read git output must not rely on its ordering or on refs a newer git adds; sort, or ask for exactly the refs you need.

## Running a full check by hand

Inside an agent session `check-all.sh` refuses to run: use `scripts/check-quick.sh` (above). When the CEO asks for a full run, set `CHECK_ALL_FORCE=1` and start it detached, never as a harness background task (the harness kills those when your run ends):

```
CHECK_ALL_FORCE=1 setsid nohup scripts/check-all.sh > "$(git rev-parse --git-dir)/check.log" 2>&1 &
```

Read that log for the `check-all: everything passed` line or a non-zero exit. A check that was signalled writes `check-all: killed by signal <name>` to the log and frees its queue place. Never kill another agent's process (no `pkill -f check-all.sh`, no `killall`): that kills their queued checks.
