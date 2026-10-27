# Boss Man: before you hand work in

Run `scripts/check-all.sh` from the repo root and fix anything it reports before you move a ticket to review. It runs everything CI's `check` job does that works without Docker: the script tests and lints, `pnpm typecheck`, `pnpm test`, `pnpm build`, ShellCheck (`scripts/check-shell.sh`, where info-level findings fail too) and the shell scripts' tests (`scripts/test-shell.sh`).

Boss Man runs the same script before it merges approved work, so anything it reports would block the merge anyway.

- Changed `apps/server/src/db/schema.ts`? Generate the migration with drizzle-kit and commit it.
- Added a shell script? Add it to `scripts/check-shell.sh`. Added a `*.test.sh`? Add it to `scripts/test-shell.sh`.
