#!/usr/bin/env bash
# Signals that the website's IndexNow notice failed twice, so the publishing agent can raise a CEO ticket (BOS-2070).
#
#   INDEXNOW_FAILURE="..." scripts/request-ceo-ticket.sh
#
# The publish step (scripts/publish-site.sh, BOS-1737) supplies this as INDEXNOW_ON_FAILURE. A publish runs in an agent's
# run, and the agent holds Boss Man's own tools, so the agent raises the ticket with create_ticket: one plain tool call,
# never a hand-made request to Boss Man's /mcp endpoint (the built-in rule forbids that).
#
# What this script can do on its own is put the failure where the agent will see it: a loud line it can read in the
# publish output, and a non-zero exit. The publish step never fails a publish because of it (it runs the hook after the
# deploy, and indexnow.mjs always exits 0), but the release step's instructions tell the agent to read this line and
# raise the ticket before it finishes.
#
# It never prints a secret: the reason is the notice's own failure text (an HTTP status or a network error).
set -euf
# The publish step runs the hook with `sh` (it needs nothing from bash), so no `set -o pipefail` here.

reason="${INDEXNOW_FAILURE:-}"
if [ -z "$reason" ]; then
  echo "request-ceo-ticket: no INDEXNOW_FAILURE given; nothing to report"
  exit 0
fi

# One line, so it is easy to find in a publish log and can't swallow the lines after it.
line="RAISE-CEO-TICKET: the website's IndexNow notice failed twice ($reason). Report it with create_ticket (project Development, risk low, size 1, noCode true): check the key file at the site root, the INDEXNOW_KEY value in Settings → Secrets, and the pages the sitemap lists. The full publish log is in the run's scratch folder."
printf '%s\n' "$line"
printf '%s\n' "$line" >&2
exit 1
