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

## Rules for server code (`apps/server/src`)

1. **In-memory state needs a note.** A module- or service-level `new Map()` / `new Set()` is state a restart loses and a second server would not share. Put `// shortcut: <the limit>, <when to upgrade>` (or "lost on restart, harmless because ...") on the line or within three lines above. `scripts/check-in-memory-state.mjs` fails CI on an unannotated one. It only looks at declarations indented two spaces or less and with an empty constructor; maps filled inside a function are not state.
2. **Background loops start only through `startBackground()`** (`src/background.ts`, wired in `main.ts`). No stray `setInterval` for recurring server work. `stopBackground()` waits for passes in flight.
3. **Anything that sends to the outside world, or launches or ends work, is leader-only.** Today there is one server, so every server is the leader. New code that pushes notifications, calls out to a git host or provider, launches or cancels runs, or would send email or webhooks must be reachable only from the background loops (or runner/owner paths that follow the leader), so a standby server can later be made inert.
