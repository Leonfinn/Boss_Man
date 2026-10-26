#!/usr/bin/env bash
# Read-only helper for Penpot's API. Needs curl and jq, and these env vars from granted Boss Man secrets:
#   PENPOT_URL    the Penpot address, e.g. http://192.168.1.20:9001
#   PENPOT_TOKEN  the agent account's access token (never printed, never written to a file)
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
    body="$(jq -nc --arg f "$2" --arg p "$3" --arg o "$4" '{cmd:"export-shapes",wait:true,exports:[{"file-id":$f,"page-id":$p,"object-id":$o,type:"png",scale:1,suffix:"",name:"board"}]}')"
    res="$(call /api/export "$body")" || exit 1
    uri="$(printf '%s' "$res" | jq -r '.uri // empty' 2>/dev/null)"
    [ -n "$uri" ] || die "the export call worked but gave no image link. Per-board PNG export is not confirmed on this Penpot version; tell the owner and use the fallback in SKILL.md."
    case "$uri" in
      "$base"/*) dl=curl_auth ;;
      http*) dl="curl -sS -m 120" ;; # another host: never send the token there
      *) uri="$base$uri"; dl=curl_auth ;;
    esac
    $dl -f -o "$out" "$uri" || { rm -f "$out"; die "could not download the exported image."; }
    [ "$(head -c 8 "$out" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || { rm -f "$out"; die "what came back was not a PNG."; }
    size="$(wc -c <"$out")"
    [ "$size" -le 5242880 ] || { rm -f "$out"; die "the PNG is over 5 MB, too big to attach. Export a smaller board."; }
    echo "Saved $out ($size bytes). Attach it with attach_image." ;;
  *) die "usage: penpot.sh check | teams | projects TEAM_ID | files PROJECT_ID | boards FILE_ID | export FILE_ID PAGE_ID BOARD_ID OUT.png" ;;
esac
