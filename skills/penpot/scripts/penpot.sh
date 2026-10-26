#!/usr/bin/env bash
# Helper for Penpot's API: read designs, and create/edit designs in files agents own. Needs curl and jq, and these
# env vars from granted Boss Man secrets:
#   PENPOT_URL    the Penpot address, e.g. http://192.168.1.20:9001
#   PENPOT_TOKEN  the agent account's access token (never printed, never written to a file)
# Read:  penpot.sh check | teams | projects TEAM_ID | files PROJECT_ID | boards FILE_ID | shapes FILE_ID | link FILE_ID [PAGE_ID]
#        penpot.sh export FILE_ID PAGE_ID BOARD_ID OUT.png
# Write: penpot.sh agent-project TEAM_ID | create-file PROJECT_ID NAME | rename-file FILE_ID NAME | delete-file FILE_ID
#        penpot.sh apply FILE_ID LAYOUT.json | modify FILE_ID PAGE_ID SHAPE_ID key=value... | remove-shape FILE_ID PAGE_ID SHAPE_ID
# Writes are only allowed in a file inside the agent project (PENPOT_AGENT_PROJECT, default "Agent designs") or in a
# file this helper created (ids kept in a temp list). PENPOT_ALLOW_OWNER_FILE=1 lifts that; use it only when a ticket says so.
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
agent_project="${PENPOT_AGENT_PROJECT:-Agent designs}"
ledger="${TMPDIR:-/tmp}/penpot-agent-files.txt" # ids of files this helper created (ids only, no secrets)
root_id="00000000-0000-0000-0000-000000000000"

# The token goes to curl on stdin (as a curl config line), so it is not in the process list or in any file.
curl_auth() { printf 'header = "Authorization: Token %s"\n' "$PENPOT_TOKEN" | curl -sS -K - -m 120 "$@" 2>/dev/null; }

call() { # call PATH [JSON_BODY]: prints the body, or a plain error
  local path="$1" body="${2:-{\}}" code tmp bf hint
  tmp="$(mktemp)"; bf="$(mktemp)"
  printf '%s' "$body" >"$bf" # the body goes by file so big layouts fit; it never holds the token
  code="$(curl_auth -o "$tmp" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Accept: application/json' --data "@$bf" "$base$path")" || {
    rm -f "$tmp" "$bf"; die "can't reach Penpot at $base (is it running, and can this runner reach it?)."
  }
  rm -f "$bf"
  case "$code" in
    2??) cat "$tmp"; rm -f "$tmp" ;;
    401|403) rm -f "$tmp"; die "Penpot refused the token (HTTP $code). It may be expired or the agent account may lack access (editing needs the Editor role on the project). Ask the owner." ;;
    404) rm -f "$tmp"; die "Penpot says not found (HTTP 404): check the id, or this call doesn't exist in this Penpot version." ;;
    *) hint="$(jq -r '.hint // .message // empty' "$tmp" 2>/dev/null | head -c 300)"; rm -f "$tmp"; die "Penpot answered HTTP $code for $path.${hint:+ $hint}" ;;
  esac
}

rpc() { call "/api/rpc/command/$1" "${2:-{\}}"; }

newid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen; }
need() { [ -n "${2:-}" ] || die "usage: $1"; }

# Penpot answers in camelCase; everything here (and what we send back) is kebab-case, so convert the keys.
get_file() { rpc get-file "$(jq -nc --arg f "$1" '{"id":$f}')" | jq -c 'walk(if type == "object" then with_entries(.key |= gsub("(?<u>[A-Z])"; "-\(.u | ascii_downcase)")) else . end)'; }

# --- ownership guard -------------------------------------------------------------------------------------------
# A write is allowed when the file was created by this helper, or sits in the agent project.
guard() { # guard FILE_ID
  local f="$1" pid name t p
  [ "${PENPOT_ALLOW_OWNER_FILE:-}" = 1 ] && return 0
  grep -qsx "$f" "$ledger" && return 0
  pid="$(get_file "$f" | jq -r '.["project-id"] // empty')" || exit 1
  [ -n "$pid" ] || die "can't tell which project file $f is in, so I won't change it."
  for t in $(rpc get-teams | jq -r '.[].id'); do
    name="$(rpc get-projects "$(jq -nc --arg t "$t" '{"team-id":$t}')" | jq -r --arg p "$pid" '.[] | select(.id==$p) | .name')"
    [ "$name" = "$agent_project" ] && return 0
  done
  die "refusing: file $f is not one I created and is not in the \"$agent_project\" project. Agents only change their own files. If a ticket explicitly says to edit this one, set PENPOT_ALLOW_OWNER_FILE=1 for that command."
}

# --- update-file -----------------------------------------------------------------------------------------------
update_file() { # update_file FILE_ID CHANGES_JSON: sends the changes with the current revn/vern and a session id
  local f="$1" changes="$2" cur body
  cur="$(get_file "$f")" || exit 1
  body="$(printf '%s' "$cur" | jq -c --arg id "$f" --arg s "$(newid)" --argjson ch "$changes" '{id:$id,"session-id":$s,revn:(.revn // 0),vern:(.vern // 0),changes:$ch}')" || die "could not read the file's revision."
  rpc update-file "$body" >/dev/null || exit 1
}

# --- layout -> add-obj changes ---------------------------------------------------------------------------------
# Input: the layout (with ids filled in) plus --arg page_id/page_name/new_page and --argjson startx. Output: changes array.
read -r -d '' LAYOUT_JQ <<'JQ'
def ident: {a:1,b:0,c:0,d:1,e:0,f:0};
def geom($x;$y;$w;$h): {x:$x,y:$y,width:$w,height:$h,
  selrect:{x:$x,y:$y,width:$w,height:$h,x1:$x,y1:$y,x2:($x+$w),y2:($y+$h)},
  points:[{x:$x,y:$y},{x:($x+$w),y:$y},{x:($x+$w),y:($y+$h)},{x:$x,y:($y+$h)}]};
def base: {rotation:0,transform:ident,"transform-inverse":ident,proportion:1,"proportion-lock":false,
  "flip-x":null,"flip-y":null,opacity:1,hidden:false,blocked:false};
def fills($c): if $c then [{"fill-color":$c,"fill-opacity":1}] else [] end;
def strokes($n): if $n.stroke then [{"stroke-color":$n.stroke,"stroke-opacity":1,"stroke-width":($n.strokeWidth // 1),"stroke-style":"solid","stroke-alignment":"inner"}] else [] end;
def fontid($f): if $f == "sourcesanspro" then "sourcesanspro" else "gfont-" + ($f | ascii_downcase | gsub(" "; "-")) end;
def textstyle($n): {
  "font-id": fontid($n.font // "sourcesanspro"), "font-family": ($n.font // "sourcesanspro"),
  "font-variant-id": ($n.weight // "regular"), "font-size": (($n.size // 16) | tostring),
  "font-weight": (if ($n.weight // "regular") == "bold" then "700" else "400" end), "font-style": "normal",
  "text-align": ($n.align // "left"), "text-decoration": "none", "text-transform": "none",
  "letter-spacing": "0", "line-height": "1.2", "vertical-align": "top",
  fills: fills($n.fill // "#000000")};
def textcontent($n): textstyle($n) as $st
  | {type:"root","vertical-align":"top",children:[{type:"paragraph-set",children:[
      {type:"paragraph",children:[($st + {text:$n.text})]} + $st ]}]};
def textsize($n): ($n.size // 16) as $s
  | {w: ($n.w // (($n.text | length) * $s * 0.55 | ceil)), h: ($n.h // ($s * 1.3 | ceil))};

# Bounding box of a node in board coordinates (groups: union of children).
def bbox($n): if $n.type == "group"
  then ([$n.children[] | bbox(.)]) as $b
    | {x: ($b|map(.x)|min), y: ($b|map(.y)|min), x2: ($b|map(.x2)|max), y2: ($b|map(.y2)|max)}
  elif $n.type == "text" then textsize($n) as $t | {x:($n.x // 0), y:($n.y // 0), x2:(($n.x // 0)+$t.w), y2:(($n.y // 0)+$t.h)}
  else {x:($n.x // 0), y:($n.y // 0), x2:(($n.x // 0)+($n.w // 100)), y2:(($n.y // 0)+($n.h // 100))} end;

# Changes for a node inside a board: ox/oy are the board's page position; the layout's x/y are relative to the board.
def shape($n; $frame; $parent; $ox; $oy):
  (if $n.type == "group" then bbox($n) else null end) as $g
  | if $n.type == "group" then
      ($g.x + $ox) as $x | ($g.y + $oy) as $y
      | [{type:"add-obj",id:$n.id,"page-id":$page_id,"frame-id":$frame,"parent-id":$parent,
          obj:(base + geom($x;$y;($g.x2-$g.x);($g.y2-$g.y)) + {id:$n.id,type:"group",name:($n.name // "Group"),"frame-id":$frame,"parent-id":$parent,shapes:[]})}]
      + ([$n.children[] | shape(.; $frame; $n.id; $ox; $oy)] | add // [])
    elif $n.type == "text" then
      textsize($n) as $t | (($n.x // 0) + $ox) as $x | (($n.y // 0) + $oy) as $y
      | [{type:"add-obj",id:$n.id,"page-id":$page_id,"frame-id":$frame,"parent-id":$parent,
          obj:(base + geom($x;$y;$t.w;$t.h) + {id:$n.id,type:"text",name:($n.name // $n.text),"frame-id":$frame,"parent-id":$parent,
            content:textcontent($n),"grow-type":(if $n.w then "auto-height" else "auto-width" end),"position-data":null})}]
    else # rect (and ellipse as a circle-type rect)
      (($n.x // 0) + $ox) as $x | (($n.y // 0) + $oy) as $y
      | [{type:"add-obj",id:$n.id,"page-id":$page_id,"frame-id":$frame,"parent-id":$parent,
          obj:(base + geom($x;$y;($n.w // 100);($n.h // 100)) + {id:$n.id,type:(if $n.type == "ellipse" then "circle" else "rect" end),
            name:($n.name // $n.type),"frame-id":$frame,"parent-id":$parent,fills:fills($n.fill // "#cccccc"),strokes:strokes($n),
            r1:($n.radius // 0),r2:($n.radius // 0),r3:($n.radius // 0),r4:($n.radius // 0),rx:($n.radius // 0),ry:($n.radius // 0)})}]
    end;

def board($b; $x): ($b.y // 0) as $y
  | [{type:"add-obj",id:$b.id,"page-id":$page_id,"frame-id":$root,"parent-id":$root,
      obj:(base + geom($x;$y;($b.w // 1440);($b.h // 900)) + {id:$b.id,type:"frame",name:($b.name // "Board"),
        "frame-id":$root,"parent-id":$root,fills:fills($b.fill // "#ffffff"),strokes:strokes($b),shapes:[],"hide-in-viewer":false,
        r1:($b.radius // 0),r2:($b.radius // 0),r3:($b.radius // 0),r4:($b.radius // 0)})}]
    + ([($b.children // [])[] | shape(.; $b.id; $b.id; $x; $y)] | add // []);

(if $new_page then [{type:"add-page",id:$page_id,name:$page_name}] else [] end)
+ (reduce .boards[] as $b ({x:$startx, out:[]};
    ($b.x // .x) as $bx
    | .out += board($b; $bx)
    | .x = ($bx + ($b.w // 1440) + 100)) | .out)
JQ

# Walk the layout, give every board and shape an id from a pool, and check shape types. Prints the layout with ids.
number_layout() { # number_layout LAYOUT.json
  local ids
  ids="$(for _ in $(seq 1 400); do newid; done | jq -R . | jq -sc .)"
  jq -c --argjson ids "$ids" '
    if (.boards | type) != "array" then error("layout needs a boards list") else . end
    | .boards |= map(. + {type:"board"})
    | [.. | objects | select(has("type") and (.type | IN("board","rect","text","group","ellipse") | not))] as $bad
    | if ($bad | length) > 0 then error("unknown shape type: " + ($bad[0].type | tostring)) else . end
    | [paths(type == "object" and has("type"))] as $ps
    | if ($ps | length) > ($ids | length) then error("layout is too big (max 400 shapes)") else . end
    | reduce range(0; $ps | length) as $i (.; setpath($ps[$i] + ["id"]; $ids[$i]))' "$1" || die "the layout is not valid (needs {\"page\":\"Name\",\"boards\":[{\"name\":..,\"w\":..,\"h\":..,\"children\":[..]}]}, shape types rect, text, group, ellipse)."
}

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
  shapes)
    need "shapes FILE_ID" "${2:-}"
    # Every shape except the page root: page id, shape id, type, name.
    get_file "$2" | jq -r '.data["pages-index"][] as $p | $p.objects[] | select(.id != "'"$root_id"'") | "\($p.id)\t\(.id)\t\(.type)\t\(.name)"' ;;
  agent-project)
    need "agent-project TEAM_ID" "${2:-}"
    # Prints the id of the agent project in the team, making it if it is missing.
    pid="$(rpc get-projects "$(jq -nc --arg t "$2" '{"team-id":$t}')" | jq -r --arg n "$agent_project" '[.[] | select(.name==$n)][0].id // empty')" || exit 1
    if [ -z "$pid" ]; then
      pid="$(rpc create-project "$(jq -nc --arg t "$2" --arg n "$agent_project" '{"team-id":$t,name:$n}')" | jq -r '.id')" || exit 1
    fi
    echo "$pid" ;;
  create-file)
    need "create-file PROJECT_ID NAME" "${3:-}"
    res="$(rpc create-file "$(jq -nc --arg p "$2" --arg n "$3" --arg i "$(newid)" '{id:$i,"project-id":$p,name:$n}')")" || exit 1
    fid="$(printf '%s' "$res" | jq -r '.id')"
    echo "$fid" >>"$ledger"
    printf '%s\t%s\n' "$fid" "$3" ;;
  rename-file)
    need "rename-file FILE_ID NAME" "${3:-}"; guard "$2"
    rpc rename-file "$(jq -nc --arg f "$2" --arg n "$3" '{id:$f,name:$n}')" >/dev/null && echo "Renamed to $3" ;;
  delete-file)
    need "delete-file FILE_ID" "${2:-}"; guard "$2"
    rpc delete-file "$(jq -nc --arg f "$2" '{id:$f}')" >/dev/null && echo "Deleted $2" ;;
  apply)
    need "apply FILE_ID LAYOUT.json" "${3:-}"; [ -r "$3" ] || die "can't read $3."
    guard "$2"
    layout="$(number_layout "$3")" || exit 1
    cur="$(get_file "$2")" || exit 1
    page_name="$(printf '%s' "$layout" | jq -r '.page // "Page 1"')"
    page_id="$(printf '%s' "$cur" | jq -r --arg n "$page_name" '[.data["pages-index"][] | select(.name==$n)][0].id // empty')"
    new_page=false
    if [ -z "$page_id" ]; then page_id="$(newid)"; new_page=true; fi
    startx="$(printf '%s' "$cur" | jq -r --arg p "$page_id" '[.data["pages-index"][$p].objects // {} | .[] | select(.["parent-id"] == "'"$root_id"'" and .id != "'"$root_id"'") | (.x + .width)] | (max // -100) + 100 | floor')"
    changes="$(printf '%s' "$layout" | jq -c --arg page_id "$page_id" --arg page_name "$page_name" --argjson new_page "$new_page" --argjson startx "$startx" --arg root "$root_id" "$LAYOUT_JQ")" || die "could not turn the layout into Penpot changes."
    update_file "$2" "$changes" || exit 1
    printf 'page\t%s\t%s\n' "$page_id" "$page_name"
    printf '%s' "$layout" | jq -r '.boards[] | "board\t\(.id)\t\(.name // "Board")", (.children // [] | .. | objects | select(has("id")) | "\(.type)\t\(.id)\t\(.name // .text // .type)")' ;;
  modify)
    [ $# -ge 5 ] || die "usage: modify FILE_ID PAGE_ID SHAPE_ID key=value... (keys: name, x, y, w, h, fill, text)"
    guard "$2"; f="$2"; pg="$3"; sid="$4"; shift 4
    cur="$(get_file "$f")" || exit 1
    shape="$(printf '%s' "$cur" | jq -c --arg p "$pg" --arg s "$sid" '.data["pages-index"][$p].objects[$s] // empty')"
    [ -n "$shape" ] || die "no shape $sid on page $pg."
    parent_shapes="$(printf '%s' "$cur" | jq -c --arg p "$pg" --arg s "$sid" '.data["pages-index"][$p].objects as $o | $o[$o[$s]["parent-id"]].shapes // []')"
    kv="$(for a in "$@"; do case "$a" in *=*) printf '%s\n' "$a" ;; *) die "bad argument '$a' (expected key=value)." ;; esac; done | jq -R 'split("=") | {key: .[0], value: (.[1:] | join("="))}' | jq -sc 'from_entries')" || exit 1
    # Name, fill and text are plain mod-obj changes. Moving or resizing re-creates the shape with the same id and
    # position in its parent, because Penpot's API does not accept geometry edits as mod-obj values.
    changes="$(jq -nc --argjson sh "$shape" --argjson kv "$kv" --argjson sib "$parent_shapes" --arg p "$pg" --arg s "$sid" '
      def op($a; $v): {type:"set",attr:$a,val:$v,"ignore-touched":true};
      def fillsv($c): [{"fill-color":$c,"fill-opacity":1}];
      ($kv | keys - ["name","x","y","w","h","fill","text"]) as $bad
      | if ($bad | length) > 0 then error("unknown key(s): " + ($bad | join(", "))) else . end
      | (($kv | has("x") or has("y") or has("w") or has("h"))) as $geo
      | if $geo and ($sh.type | IN("rect","circle","text") | not) then error("only rectangles, ellipses and text can be moved or resized; change a board or group by applying a layout") else . end
      | if $kv.text and $sh.type != "text" then error("text can only be changed on text shapes") else . end
      | (if $kv.fill and $sh.type == "text"
          then ($sh.content | walk(if type == "object" and has("fills") then .fills = fillsv($kv.fill) else . end)) else $sh.content end) as $c1
      | (if $kv.text then ($c1 | walk(if type == "object" and has("text") then .text = $kv.text else . end)) else $c1 end) as $content
      | if $geo then
          (($kv.x // $sh.x) | tonumber) as $x | (($kv.y // $sh.y) | tonumber) as $y
          | (($kv.w // $sh.width) | tonumber) as $w | (($kv.h // $sh.height) | tonumber) as $h
          | ($sh + {x:$x,y:$y,width:$w,height:$h,
              selrect:{x:$x,y:$y,width:$w,height:$h,x1:$x,y1:$y,x2:($x+$w),y2:($y+$h)},
              points:[{x:$x,y:$y},{x:($x+$w),y:$y},{x:($x+$w),y:($y+$h)},{x:$x,y:($y+$h)}]}
              + (if $kv.name then {name:$kv.name} else {} end)
              + (if $kv.fill and $sh.type != "text" then {fills:fillsv($kv.fill)} else {} end)
              + (if $sh.type == "text" then {content:$content} else {} end)) as $new
          | [{type:"del-obj",id:$s,"page-id":$p},
             {type:"add-obj",id:$s,"page-id":$p,"frame-id":$sh["frame-id"],"parent-id":$sh["parent-id"],index:($sib | index($s) // 0),obj:$new}]
        else
          [{type:"mod-obj",id:$s,"page-id":$p,operations:(
            [ if $kv.name then op("name"; $kv.name) else empty end ]
            + (if $kv.fill and $sh.type != "text" then [op("fills"; fillsv($kv.fill))] else [] end)
            + (if $sh.type == "text" and ($kv.fill or $kv.text) then [op("content"; $content)] else [] end))}]
        end')" || die "could not build the change (see above)."
    update_file "$f" "$changes" && echo "Changed $sid" ;;
  remove-shape)
    [ $# -eq 4 ] || die "usage: remove-shape FILE_ID PAGE_ID SHAPE_ID"
    guard "$2"
    update_file "$2" "$(jq -nc --arg p "$3" --arg s "$4" '[{type:"del-obj",id:$s,"page-id":$p}]')" && echo "Removed $4" ;;
  link)
    need "link FILE_ID [PAGE_ID]" "${2:-}"
    cur="$(get_file "$2")" || exit 1
    pid="$(printf '%s' "$cur" | jq -r '.["project-id"] // empty')"
    team="$(printf '%s' "$cur" | jq -r '.["team-id"] // empty')"
    if [ -z "$team" ] && [ -n "$pid" ]; then team="$(rpc get-project "$(jq -nc --arg p "$pid" '{id:$p}')" | jq -r '.["team-id"] // empty')"; fi
    pg="${3:-$(printf '%s' "$cur" | jq -r '.data["pages-index"] | to_entries | sort_by(.value.objects | length) | reverse | .[0].key // empty')}"
    echo "$base/#/workspace?${team:+team-id=$team&}file-id=$2${pg:+&page-id=$pg}" ;;
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
  *) die "usage: penpot.sh check | teams | projects TEAM_ID | files PROJECT_ID | boards FILE_ID | shapes FILE_ID | link FILE_ID [PAGE_ID] | export FILE_ID PAGE_ID BOARD_ID OUT.png | agent-project TEAM_ID | create-file PROJECT_ID NAME | rename-file FILE_ID NAME | delete-file FILE_ID | apply FILE_ID LAYOUT.json | modify FILE_ID PAGE_ID SHAPE_ID key=value... | remove-shape FILE_ID PAGE_ID SHAPE_ID" ;;
esac
