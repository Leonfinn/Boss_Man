#!/usr/bin/env bash
# Raises a ticket for the CEO when the website's IndexNow notice fails twice (BOS-2070).
#
#   INDEXNOW_FAILURE="..." scripts/request-ceo-ticket.sh
#
# The publish step (scripts/publish-site.sh, BOS-1737) supplies this as INDEXNOW_ON_FAILURE, so a search-engine
# notice that keeps failing reaches the CEO as a ticket instead of only being printed in a run's log.
#
# The run's own MCP connection is the one thing a publish has to reach Boss Man with, and the site's build has no
# Boss Man client, so this calls the agent-facing MCP endpoint with the run's token/address when Boss Man sends them
# with the run (BOSSMAN_TOKEN and BOSSMAN_API_URL; ask the CEO to have the runner pass them). Nothing is hardcoded.
# It never fails a publish: a missing token, address or reason only prints why and exits 0.
#
# A website publish that changed no pages sends no notice, so a real failure is worth a look: the pages may have
# changed without search engines being told, and the key file (or the key) is often the cause.
set -euf
# The publish step runs the hook with `sh` (it needs nothing from bash), so no `set -o pipefail` here.

reason="${INDEXNOW_FAILURE:-}"
[ -n "$reason" ] || { echo "request-ceo-ticket: no INDEXNOW_FAILURE given; nothing raised"; exit 0; }
token="${BOSSMAN_TOKEN:-}"
api="${BOSSMAN_API_URL:-}"
if [ -z "$token" ] || [ -z "$api" ]; then
  echo "request-ceo-ticket: BOSSMAN_TOKEN or BOSSMAN_API_URL is not set for this run, so no ticket was raised; the failure was: $reason"
  exit 0
fi

body="${reason}. Raised by the website publish step (scripts/publish-site.sh) after the IndexNow notice failed twice. Check: the key file served at the site root, the INDEXNOW_KEY value in Settings → Secrets, and the pages the sitemap lists. The full publish log is in the publishing run's scratch folder."

# JSON-escape the text without a helper that needs installing: backslash, double quote, newline, tab.
json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""}{if(NR>1)printf "\\n"; print}' | sed -e 's/\t/\\t/g'; }

payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"create_ticket\",\"arguments\":{\"title\":\"Website IndexNow notice failed twice: search engines were not told what changed\",\"body\":\"$(json "$body")\",\"project\":\"Development\",\"risk\":\"low\",\"size\":1,\"noCode\":true}}}"

curl --silent --show-error --fail-with-body \
  --header "authorization: Bearer $token" \
  --header "content-type: application/json" \
  --header "accept: application/json, text/event-stream" \
  --request POST \
  --data "$payload" \
  "${api%/}/mcp" \
  && echo "request-ceo-ticket: raised a ticket for the CEO" \
  || echo "request-ceo-ticket: could not raise a ticket; the failure was: $reason"
exit 0
