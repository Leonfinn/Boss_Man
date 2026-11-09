# 10 — Migrations and server code rules

These keep a release and the one before it compatible, which is what makes a rollback (and later a blue/green swap, see the phase 3 design) free. CI enforces the mechanical parts.

## Expand/contract rules for SQL migrations

1. **Release N may only expand:** new tables, new columns that are nullable or have a `DEFAULT`, new indexes, new enum values.
2. **Release N-1 must run against release N's schema.** That is what makes rollback free.
3. **Contract in release N+2 or later:** drops, renames, type changes and `SET NOT NULL`, only once no running or rollback-candidate release reads the old shape.
4. **A rename is add new, dual-write, backfill, switch reads, then drop**, across at least three releases.
5. **Enum values:** adding one is fine, but old code must tolerate an unknown value, and the new value cannot be used in the same migration that adds it (one transaction).
6. **Backfills are separate jobs**, in small batches, not part of the startup migration.
7. **Locks:** anything taking an `ACCESS EXCLUSIVE` lock blocks the live server's queries. Keep such statements short.

### The lint

`scripts/lint-migrations.mjs` runs in CI. It looks only at migrations numbered above 0042 (history is not re-judged) and fails on `DROP TABLE/COLUMN/INDEX/TYPE/CONSTRAINT`, `RENAME`, `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `ADD COLUMN ... NOT NULL` without `DEFAULT`, `TRUNCATE` and `DELETE FROM` without `WHERE`. A deliberate contract step passes when the statement, or the line above it, carries a reason a reviewer can see:

```sql
-- contract-ok: nothing has read old_col since release 0.9
ALTER TABLE "x" DROP COLUMN "old_col";
```

A release that ships a `contract-ok` migration cannot be rolled back without a database restore; say so in its approval text. Generate migrations with `pnpm db:generate`.

### Number clashes between branches (BOS-219)

Drizzle names a migration by its number, so two branches that both add `0075_...` cannot both land: the second to merge collides with the first (that cost four tickets hours on 28–29 Oct). Two things now catch it before the merge:

- **The lint fails a real clash.** Two files with the same number in one folder, two journal entries on one number, a journal entry with no file, or a file the journal doesn't list all fail `scripts/lint-migrations.mjs`, and so `scripts/check-all.sh` (CI runs both run).
- **Branches are compared, not just one folder.** When a ticket moves to review and again just before it merges, the runner reads the branch, `origin/main` and the other open tickets' branches from its bare clone and says whether the ticket's new migration numbers are already taken. On a clash the ticket goes back with the next free number right now, rather than waiting for a merge to fail. `when` values still only increase: a branch whose new journal entry isn't later than the one already applied is also sent back.

**The merge gate renumbers for you (BOS-690, DR-037).** Every pair of branches that both add a migration also clash in `meta/_journal.json`, whatever their numbers. So when the merge is attempted (`tryMerge` in `apps/runner/src/workspace.ts`, which `merge`, `mergeChecked`, `mergePhase` and `clash()` all use), and the only clash is migration bookkeeping, `rebaseMigrations` (`apps/runner/src/migrations.ts`) rebuilds the branch's migration on top of main: it takes the next free number, appends a journal entry, chains the snapshot to main's newest (a key-by-key three-way merge of the branch's snapshot, its starting snapshot and main's) and lifts `when` above main's newest. The SQL file is the same git object, byte for byte. Nothing is checked out, the result is deterministic (no clock), and the full check runs on that exact merged tree. The ticket gets one line: "Migration 0113_x landed as 0114_x".

The gate **refuses, and the branch is sent back as before**, when: real code also conflicts; both sides change the same table column, index, constraint or other schema part; the branch edits a migration that already existed; or the journal or a snapshot has a layout it doesn't know. Run `node scripts/rebase-migrations.mjs [<branch>] [<main>]` in a clone to see what the gate would do (read-only). The review-time warning above still tells the agent about a clash early; the agent doesn't need to renumber by hand.

If the gate refuses, merge `origin/main`, delete your migration's `.sql`, its `meta/NNNN_snapshot.json` and its `_journal.json` entry, and run `pnpm db:generate` again: drizzle-kit then picks the number, the `when` and the snapshot's parent for you. If the gate gave you a higher free number, rename the new `.sql` and `meta/NNNN_snapshot.json` to it and set the journal entry's `tag` and `idx` to match. Run the checks, then move the ticket back to review.

### The snapshot chain (BOS-519)

`drizzle-kit generate` diffs `schema.ts` against the snapshot file that sorts last, refuses to run when two snapshots share a `prevId`, and names the new migration after the last journal entry's `idx + 1`. Renaming migrations by hand broke all three on main by 5 Nov: three entries had no snapshot, several pointed at the wrong parent or held another migration's columns, and the last `idx` was 91, so `generate` named new migrations `0092_...`. BOS-519 rebuilt each snapshot from `schema.ts` as it was on main when that migration merged, and set 0101's `idx` to 101. `idx` may skip numbers (the migrator ignores it), but it must increase. Two checks keep the chain whole:

- `scripts/lint-migrations.mjs` fails when an entry has no snapshot, a snapshot's `prevId` isn't the previous entry's id, two snapshots share a `prevId`, a snapshot has no entry, or the last `idx` is below the highest migration number.
- `apps/server/test/migrations.test.ts` fails when `schema.ts` differs from the newest snapshot, which means a clean checkout's `generate` would write a migration.


## Rules for server code (`apps/server/src`)

1. **In-memory state needs a note.** A module- or service-level `new Map()` / `new Set()`, or a top-level `let` (column 0, including `export let`), is state a restart loses and a second server would not share. Put `// shortcut: <the limit>, <when to upgrade>` (or "lost on restart, harmless because ...") on the line or within three lines above. `scripts/check-in-memory-state.mjs` fails CI on an unannotated one. It only looks at declarations indented two spaces or less and with an empty constructor for a Map/Set, and at `let` at column 0; maps filled inside a function, and a `let` inside a function or service factory, are not state.
2. **Background loops start only through `startBackground()`** (`src/background.ts`, wired in `main.ts`). No stray `setInterval` for recurring server work. `stopBackground()` waits for passes in flight.
3. **Anything that sends to the outside world, or launches or ends work, is leader-only.** Since phase 3, part 1 (`src/leader.ts`) a server can be a standby: a standby refuses owner writes and runner sockets and runs no background loops. New code that pushes notifications, calls out to a git host or provider, launches or cancels runs, or would send email or webhooks must be reachable only from the background loops (or runner/owner paths that follow the leader), so a standby stays inert. Put `// leader-only` on the line, as the self-deploy and drain code does.
4. **Migrations can run as their own step.** `node dist/migrate.js` migrates under an advisory lock; a server started with `BOSSMAN_MIGRATE_ON_START=0` refuses to run on a database older than its migrations and accepts a newer one. Do not rely on the server having migrated at start.
