#!/usr/bin/env bash
# Read-only helper for Penpot's API. Needs curl and jq, and these env vars from granted Boss Man secrets:
#   PENPOT_URL    the Penpot address, e.g. http://192.168.1.20:9001
#   PENPOT_TOKEN  the agent account's access token (never printed, never written to a file)
#   PENPOT_EMAIL, PENPOT_PASSWORD  the same account's login; only `export` needs them (the export service wants a session, not a token)
# Usage: penpot.sh check | teams | projects TEAM_ID | files PROJECT_ID | boards FILE_ID
#        penpot.sh export FILE_ID PAGE_ID BOARD_ID OUT.png
set -u -o pipefail
set +x

die() { echo "penpot: $*" >&2; exit 1; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not installed here, so I can't talk to Penpot. Tell the owner."
done
if [ -z "${PENPOT_URL:-}" ] || [ -z "${PENPOT_TOKEN:-}" ]; then
  die "Penpot is not set up for you: PENPOT_URL and PENPOT_TOKEN are not granted to this agent. Ask the owner to follow the Penpot setup steps and grant both secrets to you. Do not look for the token anywhere else."
fi
base="${PENPOT_URL%/}"

# The token goes to curl on stdin (as a curl config line), so it is not in the process list or in any file.
curl_auth() { printf 'header = "Authorization: Token %s"\n' "$PENPOT_TOKEN" | curl -sS -K - -m 120 "$@" 2>/dev/null; }

call() { # call PATH [JSON_BODY]: prints the body, or a plain error
  local path="$1" body="${2:-{\}}" code tmp
  tmp="$(mktemp)"
  code="$(curl_auth -o "$tmp" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Accept: application/json' --data "$body" "$base$path")" || {
    rm -f "$tmp"; die "can't reach Penpot at $base (is it running, and can this runner reach it?)."
  }
  case "$code" in
    2??) cat "$tmp"; rm -f "$tmp" ;;
    401|403) rm -f "$tmp"; die "Penpot refused the token (HTTP $code). It may be expired or the agent account may lack access. Ask the owner to make a new token." ;;
    404) rm -f "$tmp"; die "Penpot says not found (HTTP 404): check the id, or this call doesn't exist in this Penpot version." ;;
    *) rm -f "$tmp"; die "Penpot answered HTTP $code for $path." ;;
  esac
}

rpc() { call "/api/rpc/command/$1" "${2:-{\}}"; }

case "${1:-}" in
  check) rpc get-profile | jq -r '"Connected to Penpot as \(.fullname // .email)"' ;;
  teams) rpc get-teams | jq -r '.[] | "\(.id)\t\(.name)"' ;;
  projects)
    [ -n "${2:-}" ] || die "usage: projects TEAM_ID"
    rpc get-projects "$(jq -nc --arg t "$2" '{"team-id":$t}')" | jq -r '.[] | "\(.id)\t\(.name)"' ;;
  files)
    [ -n "${2:-}" ] || die "usage: files PROJECT_ID"
    rpc get-project-files "$(jq -nc --arg p "$2" '{"project-id":$p}')" | jq -r '.[] | "\(.id)\t\(.name)"' ;;
  boards)
    [ -n "${2:-}" ] || die "usage: boards FILE_ID"
    # Top-level boards (frames) per page: page id, board id, board name.
    rpc get-file "$(jq -nc --arg f "$2" '{"id":$f}')" |
      jq -r '(.data["pages-index"] // .data.pagesIndex)[] as $p | $p.objects[] | select(.type=="frame" and (.["parent-id"] // .parentId)=="00000000-0000-0000-0000-000000000000") | "\($p.id)\t\(.id)\t\(.name)"' ;;
  export)
    [ $# -eq 5 ] || die "usage: export FILE_ID PAGE_ID BOARD_ID OUT.png"
    out="$5"
    # Penpot's export service (separate from the rest of the API, behind /api/export) only reads Transit
    # bodies (plain JSON gives HTTP 500 "conj on a map") and needs a logged-in session cookie, not an
    # access token (the page it renders can't use one). So log in with the agent account's email and
    # password and send the cookie instead of the token.
    if [ -z "${PENPOT_EMAIL:-}" ] || [ -z "${PENPOT_PASSWORD:-}" ]; then
      die "exporting a board needs PENPOT_EMAIL and PENPOT_PASSWORD (the agent account's login) granted to you as well as the token. Ask the owner to add both secrets (docs/16-penpot-agent-setup.md). Do not look for them anywhere else."
    fi
    for id in "$2" "$3" "$4"; do
      case "$id" in ""|*[!0-9a-fA-F-]*) die "ids must be UUIDs, as printed by the boards command." ;; esac
    done
    hdr="$(mktemp)"; tmp="$(mktemp)"; trap 'rm -f "$hdr" "$tmp"' EXIT
    code="$(jq -nc '{email:env.PENPOT_EMAIL,password:env.PENPOT_PASSWORD}' |
      curl -sS -m 60 -D "$hdr" -o "$tmp" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Accept: application/json' --data @- "$base/api/rpc/command/login-with-password" 2>/dev/null)" || die "can't reach Penpot at $base."
    [ "$code" = 200 ] || die "Penpot refused the agent account's email and password (HTTP $code). Ask the owner to check PENPOT_EMAIL and PENPOT_PASSWORD."
    session="$(tr -d '\r' <"$hdr" | sed -n 's/^[Ss]et-[Cc]ookie: auth-token=\([^;]*\).*/\1/p' | head -n1)"
    pid="$(jq -r '.id // empty' "$tmp")"
    case "$pid" in ""|*[!0-9a-fA-F-]*) die "logged in, but Penpot gave no usable profile id. Tell the owner." ;; esac
    if [ -z "$session" ] || [ -z "$pid" ]; then die "logged in, but Penpot gave no session. Tell the owner."; fi
    cookie_curl() { printf 'header = "Cookie: auth-token=%s"\n' "$session" | curl -sS -K - -m 120 "$@" 2>/dev/null; }
    # End the session on every exit path (failures included); a failure here doesn't matter.
    trap 'cookie_curl -o /dev/null -X POST -H "Content-Type: application/json" --data "{}" "$base/api/rpc/command/logout" || true; rm -f "$hdr" "$tmp"' EXIT
    body="[\"^ \",\"~:cmd\",\"~:export-shapes\",\"~:profile-id\",\"~u$pid\",\"~:wait\",true,\"~:exports\",[[\"^ \",\"~:file-id\",\"~u$2\",\"~:page-id\",\"~u$3\",\"~:object-id\",\"~u$4\",\"~:type\",\"~:png\",\"~:scale\",1,\"~:suffix\",\"\",\"~:name\",\"board\"]]]"
    code="$(cookie_curl -o "$tmp" -w '%{http_code}' -X POST -H 'Content-Type: application/transit+json' -H 'Accept: application/transit+json' --data "$body" "$base/api/export")" || die "can't reach Penpot's export service."
    [ "$code" = 200 ] || die "Penpot's export failed (HTTP $code): $(head -c 300 "$tmp"). Check the ids; tell the owner if it keeps failing."
    uri="$(jq -r '.["~:uri"]["~#uri"] // empty' "$tmp" 2>/dev/null)"
    [ -n "$uri" ] || die "the export call worked but gave no image link. Tell the owner."
    # Take only the /assets/... path and fetch it from our own base, so a different spelling of Penpot's
    # public address (hostname vs IP) still works and the session is never sent to another host.
    case "$uri" in /*) path="$uri" ;; *) path="/${uri#*://*/}" ;; esac
    case "$path" in
      /assets/*) ;;
      *) die "the export link is not a Penpot asset link; not sending the session there." ;;
    esac
    cookie_curl -f -o "$out" "$base$path" || { rm -f "$out"; die "could not download the exported image."; }
    [ "$(head -c 8 "$out" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || { rm -f "$out"; die "what came back was not a PNG."; }
    size="$(wc -c <"$out")"
    [ "$size" -le 5242880 ] || { rm -f "$out"; die "the PNG is over 5 MB, too big to attach. Export a smaller board."; }
    echo "Saved $out ($size bytes). Attach it with attach_image." ;;
  *) die "usage: penpot.sh check | teams | projects TEAM_ID | files PROJECT_ID | boards FILE_ID | export FILE_ID PAGE_ID BOARD_ID OUT.png" ;;
esac
