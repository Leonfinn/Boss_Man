---
name: penpot
description: Read designs in the company's Penpot (list projects and files, find boards) and export one board as a PNG to attach to a ticket. Read-only. Use when a ticket mentions Penpot, a mockup, a design file or a board.
---

# Penpot (read-only)

Use `scripts/penpot.sh` (next to this file). It needs two granted secrets as env vars: `PENPOT_URL` and `PENPOT_TOKEN`.

## Rules

- **Never print, echo, log or save the token.** Don't run `env`, `printenv`, `echo $PENPOT_TOKEN`, or `set -x`. Don't put it in a file, a reply, a ticket, a wiki page or a commit. The script passes it to curl without showing it.
- **Read-only.** Don't create, change or delete anything in Penpot.
- If the script says Penpot isn't set up for you, stop and tell the ticket owner what it said. Don't hunt for the token elsewhere.

## Steps

In the steps below, `<skill dir>` is this skill's base directory (shown when the skill loads). The runner puts skills in a per-run folder, not the working folder, so do not use a relative `.claude/skills` path.

1. `bash <skill dir>/scripts/penpot.sh check` confirms the connection.
2. `bash <skill dir>/scripts/penpot.sh teams`, then `projects TEAM_ID`, then `files PROJECT_ID`. Each prints `id<TAB>name`.
3. `bash <skill dir>/scripts/penpot.sh boards FILE_ID` prints `page-id<TAB>board-id<TAB>name` for each top-level board.
4. `bash <skill dir>/scripts/penpot.sh export FILE_ID PAGE_ID BOARD_ID /tmp/board.png` saves a PNG outside the git workspace, so it is not committed (it checks it really is a PNG and at most 5 MB).
5. Attach it with `attach_image` (PNG only, max 5 MB; no SVG). Say in the ticket which file and board it shows.

## If export fails

Per-board PNG export through the API was not confirmed when this skill was written (it goes through Penpot's export service, which is lightly documented). If `export` reports that, say so on the ticket and ask the owner to export the board by hand in Penpot (right-click the board, Export, PNG) and attach it. Don't try other ways around it.

## Limits

Boards, names and ids only; the script does not read colours, text or layers in detail. Needs `curl` and `jq` on the runner; the script says so if they are missing.
