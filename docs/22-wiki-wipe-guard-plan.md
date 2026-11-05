# BOS-430: no agent write can wipe a wiki page — plan (v2)

This plan needs the owner's approval before any code, because it is high risk.

## What went wrong

1. **3 Nov ~17:15, Bagpuss.** The agent called `wiki write` with a `section` argument
   to add one entry to `engineering/boss-man-cock-ups` (~62,000 chars). The tool
   ignored `section` and replaced the whole page with the short body.
2. **3 Nov ~23:15, Brian.** The agent wrote `releases/release-log` with only the new
   entry in the body. Every older entry was wiped, and the owner could not find a
   full version in the History screen.
3. **4 Nov ~11:33, Brian.** The same happened again to `Index` (38,311 chars, 32
   sections, down to 2,676 chars). The owner opened Index → History. The old
   version was listed, but **the owner could not open it**.

## Step 0 — why history could not restore it (from the code, on main `7edd5cd9`)

**Every save did keep a full version, and nothing deletes versions.**

- `wiki.write` (`apps/server/src/services/wiki.ts`) inserts a full `wiki_revisions`
  row whenever the page changes, for the MCP tool, ticket-linked writes, owner
  saves, page creation and moves.
- `writeLesson` (project brief) and the retro lesson undo also insert revisions.
- No code prunes `wiki_revisions`; only deleting a page cascades.

So the release log's full text was in the database all along. Three separate
problems made it look gone, and the third is new from today's report:

1. **The History list caps at 100 rows** (`wiki.get`, `.limit(100)`), newest first.
   The release log is saved several times a night, so the last full version can be
   further back than 100 rows and never appears.
2. **The list shows no size**, so a short wiped version looks the same as the full
   one. Even when the good version is listed, nothing tells the owner which to pick.
3. **Clicking a listed version can fail silently (today's report).** In
   `apps/web/src/pages/Wiki.tsx`, `showOld` is
   `setOld(await api(...))` with **no error handling**. If that one request fails —
   a short server restart, a deploy switching versions (502/503/504), a dropped
   connection on a phone — `setOld` never runs: no banner, no error, the page does
   not change. The click looks dead. That matches "the old version is listed, but
   it won't let me open it". I reproduced the component working under a healthy
   request, and confirmed the revision route returns a 32,000-character version
   with status 200; the only way a listed row fails to open with no message is the
   unhandled request error.

**A fourth gap, found while checking:** pages created by **company import**
(`apps/server/src/services/company-import.ts`) are inserted straight into
`wiki_pages` with **no revision row**, so imported pages have no history at all
until their first edit. It does not explain the release log, but it breaks the
"every save is kept" promise for every import and must be fixed in the same pass.

## The fix

### 1. History always works (step 0)
- `wiki.get` stops at a cap of 100: return every version, or page them, and show
  each row's size in characters. The screen says "showing the newest N" only when
  it truly is a window, with a way to see older ones.
- `Wiki.tsx` `showOld` catches failure and shows a plain error ("Couldn't open that
  version; try again") instead of doing nothing.
- Company import writes an initial revision for each imported page.
- Tests: a page with more than 100 versions lists them all (or old ones are
  reachable); a failed revision request shows an error; an imported page has a
  first version.

### 2. `write` refuses arguments it doesn't use
`wiki write` returns a plain error when given `section` or `offset` (they belong to
`read`), naming `append` for adding an entry — instead of ignoring them.
Test: `write` with `section` is an error and the page is unchanged.

### 3. Shrink guard
A `write` to an existing page is refused unless `replace: true`, when the new body
- removes more than a quarter of the current text, **or**
- drops any heading the page has now.

The error states the current size, the new size, and the headings that would go.
Only the CEO (or the owner) may pass `replace: true` on a page another agent
created; an agent's own page it may replace. Every guard check happens before the
database write, so a refused write changes nothing.
Tests: a shrunk body is refused with a message naming sizes and headings; the same
write with `replace: true` by the CEO succeeds; a non-CEO `replace: true` on
another agent's page is refused; a small edit still succeeds.

### 4. `append`
`wiki append` inserts an entry under a named heading (newest first by default, or
at the top/bottom), or at the page top when no heading is given. It reads the page,
inserts, and writes through the same guarded path, so it can never truncate.
Tests: append under a heading adds only the entry and keeps the rest; append to a
page with no such heading is a clear error; append at top/bottom works; the
revision is recorded.

### 5. `history` and `restore`
- `wiki history` lists a page's versions with id, time, who and size.
- `wiki restore` (slug + version id) writes the old text as a **new** version, so
  the restore itself can be undone. Allowed for the CEO and the page's last writer.
- The owner's "Put this version back" button calls `restore` (not a plain `save`),
  so it is not blocked by the shrink guard and is recorded as a restore.
Tests: restore brings back the old text and adds a new version; a non-CEO who is not
the last writer is refused; restoring the wiped release log and Index works in one
staging check.

### 6. Instructions
- The `wiki` tool description: use `append` for log entries; never send a partial
  body to `write`; `section`/`offset` are for `read` only.
- Brian's and Bagpuss's agent instructions (in the agent templates) say the same.

## Files
- `apps/server/src/services/wiki.ts` — guard, `append`, `restore`, history with
  sizes and no silent cap, shared insertion helper.
- `apps/server/src/mcp.ts` — tool schema and actions (`append`, `history`,
  `restore`, `replace`), refuse unused args.
- `apps/server/src/app.ts` — owner routes for restore (and history if paged).
- `apps/server/src/services/company-import.ts` — initial revision per page.
- `apps/web/src/pages/Wiki.tsx` — sizes in History, error on failed open, restore
  button calls restore.
- `packages/shared/src/agent-templates.ts` — Brian's and Bagpuss's instructions.
- Tests: `apps/server/test/wiki.test.ts` (+ a new `wiki-guard.test.ts`),
  `apps/web/test/wiki-history.test.tsx`, `packages/shared/test/agent-templates.test.ts`.

## What could go wrong, and how I'd undo it
- **Guard too strict** blocks a legitimate big rewrite. The error names the sizes
  and headings and offers `replace: true`, and the CEO can always pass it. If it
  misfires in practice, the guard is one branch in `write`, reverted on its own.
- **Restore mis-targets a version.** Restore only reads a revision and writes its
  text as a new version; a wrong restore is itself restorable. It never deletes.
- **Append placing text wrongly.** Append inserts whole lines under a heading and
  never rewrites the rest; the test checks the untouched parts are byte-identical.
- **Bigger history payload** on pages with thousands of versions. I will page it
  rather than return everything if the count is large, keeping the first screen
  fast; the cap only ever hid versions, never deleted them, so nothing is lost if
  a deploy is rolled back.

## How I verify
- `scripts/check-quick.sh` on the branch: merge check, migration lint, typecheck,
  the affected vitest files, web build.
- The project's deeper check (`scripts/check-all.sh`, run by the gate) before merge.
- Staging, once merged and deployed: restore the 4 Nov Index (pre-11:33) and the
  3 Nov release log; confirm both come back and the restore is listed as a new
  version; confirm the History screen shows sizes and opens every row.

## Build status (5 Nov)

- **Step 1 (committed, 2f5eedc6):** `write` refuses `section`/`offset` and refuses a rewrite that drops more than a
  quarter of the text or any heading unless `replace: true` (CEO only on another agent's page).
- **Step 2 (committed, a8dff64b):** `append`, `history` (every version, with sizes; the page screen no
  longer caps at 100), `restore` (CEO or the page's last writer; itself a new version), owner route
  `POST /api/companies/:id/wiki-restore`, company import keeps a first version, History screen shows sizes and
  says so when a version won't open, and the wiki tool description plus the Wiki Maintainer's and Release
  Manager's instructions say to use `append` for log entries.
- **Tests:** 7 new in `apps/server/test/wiki.test.ts` and 3 in `apps/web/test/wiki-history.test.tsx`; all 10 fail
  on 2f5eedc6 and pass with a8dff64b (run by file with one worker). Server, web and shared typecheck pass.
- **Still to do:** the project's full check runs at the merge gate; after merge, staging should restore the
  4 Nov Index and 3 Nov release log from History.
- Caveat: the guard, append, history and restore were exercised by the wiki tests and typecheck only tonight;
  the broader related suite was stopped at the CEO's request so it would not starve the merge gate.
