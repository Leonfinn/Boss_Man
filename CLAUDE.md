# Boss Man: before you hand work in

Run `scripts/check-quick.sh` from the repo root and fix anything it reports before you move a ticket to review (reviewers run it too). It works out what your branch changed against `origin/main` and runs only what that touches, in 2 to 5 minutes: the merge check, the migration lint, typecheck of the touched packages, the vitest files related to your changes, ShellCheck when shell scripts changed, and the web build when web code changed. It prints one PASS or FAIL line per step.

Only the merge gate runs the full `scripts/check-all.sh` (30 to 50 minutes: the script tests and lints, `pnpm typecheck`, `pnpm test`, `pnpm build`, ShellCheck where info-level findings fail too, and `scripts/test-shell.sh`), and anything it reports blocks the merge. Run the full check yourself, detached, only when the gate has bounced the ticket twice, or when you changed `check-all.sh` or the test setup.

- Changed `apps/server/src/db/schema.ts`? Generate the migration with drizzle-kit and commit it.
- Added a shell script? Add it to `scripts/check-shell.sh`. Added a `*.test.sh`? Add it to `scripts/test-shell.sh`.
