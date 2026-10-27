# Boss Man: before you hand work in

CI (`.github/workflows/ci.yml`) runs these on every merge to main. Run the ones your change touches, and fix anything they report, before you move a ticket to review:

- `pnpm -r typecheck`
- `pnpm test` (or `pnpm --filter <package> test` for the package you changed)
- `node --test scripts/*.test.mjs && node scripts/lint-migrations.mjs && node scripts/check-in-memory-state.mjs`
- Changed `apps/server/src/db/schema.ts`? Generate the migration with drizzle-kit and commit it.
- Changed or added a shell script? `scripts/check-shell.sh` (ShellCheck; info-level findings fail too) and that script's own `*.test.sh`. A new script goes on the list in `scripts/check-shell.sh`.
