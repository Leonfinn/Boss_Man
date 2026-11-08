#!/usr/bin/env bash
# Helper for Penpot's API: read designs, and create/edit designs in files agents own. Needs curl and jq, and these
# env vars from granted Boss Man secrets:
#   PENPOT_URL    the Penpot address, e.g. http://192.168.1.20:9001
#   PENPOT_TOKEN  the agent account's access token (never printed, never written to a file)
#   PENPOT_EMAIL, PENPOT_PASSWORD  the same account's login; only `export` needs them (the export service wants a session, not a token)
# Read:  penpot.sh check | teams | projects TEAM_ID | files PROJECT_ID | pages FILE_ID | boards FILE_ID | shapes FILE_ID
#        penpot.sh link FILE_ID [PAGE_ID] | export FILE_ID PAGE_ID BOARD_ID OUT.png
# Write: penpot.sh agent-project TEAM_ID | create-file PROJECT_ID NAME | rename-file FILE_ID NAME | delete-file FILE_ID
#        penpot.sh rename-page FILE_ID PAGE_ID NAME | delete-page FILE_ID PAGE_ID
#        penpot.sh validate LAYOUT.json (checks only, writes nothing, needs no Penpot)
#        penpot.sh apply FILE_ID LAYOUT.json | modify FILE_ID PAGE_ID SHAPE_ID key=value... | remove-shape FILE_ID PAGE_ID SHAPE_ID
# Writes are only allowed in a file inside the agent project (PENPOT_AGENT_PROJECT, default "Agent designs") or in a
# file this helper created (ids kept in a temp list). There is no override.
set -u -o pipefail
set +x

die() { echo "penpot: $*" >&2; exit 1; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not installed here, so I can't talk to Penpot. Tell the owner."
done
if [ "${1:-}" != validate ] && { [ -z "${PENPOT_URL:-}" ] || [ -z "${PENPOT_TOKEN:-}" ]; }; then
  die "Penpot is not set up for you: PENPOT_URL and PENPOT_TOKEN are not granted to this agent. Ask the owner to follow the Penpot setup steps and grant both secrets to you. Do not look for the token anywhere else."
fi
base="${PENPOT_URL:-}"; base="${base%/}"
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
    401|403) rm -f "$tmp"; die "Penpot refused the token (HTTP $code). It may be expired or the agent account may lack access (drawing needs the Editor role in the agent team). Ask the owner." ;;
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
# A write is allowed when the file was created by this helper (in this run: the list lives in a temp folder), or sits in
# the agent project of a team where the agent account can edit (owner, admin or editor; the agent is often only a member
# of the owner's team, and its "Agent designs" project lives there). This is a convenience check, not the security
# boundary: that is Penpot's own roles (the agent account is only a Viewer wherever it must not draw).
guard() { # guard FILE_ID
  local f="$1" pid name t
  grep -qsx "$f" "$ledger" && return 0
  pid="$(get_file "$f" | jq -r '.["project-id"] // empty')" || exit 1
  [ -n "$pid" ] || die "can't tell which project file $f is in, so I won't change it."
  for t in $(rpc get-teams | jq -r '.[] | (.permissions // {}) as $p
      | select([$p.isOwner, $p["is-owner"], $p.isAdmin, $p["is-admin"], $p.canEdit, $p["can-edit"]] | any) | .id'); do
    name="$(rpc get-projects "$(jq -nc --arg t "$t" '{"team-id":$t}')" | jq -r --arg p "$pid" '.[] | select(.id==$p) | .name')"
    [ "$name" = "$agent_project" ] && return 0
  done
  die "refusing: file $f is not one I created and is not in the \"$agent_project\" project. Agents only change their own files. Ask the owner to make the change or to give you your own copy."
}

# --- update-file -----------------------------------------------------------------------------------------------
update_file() { # update_file FILE_ID CHANGES_JSON: sends the changes with the current revn/vern and a session id
  local f="$1" changes="$2" cur body cf
  cur="$(get_file "$f")" || exit 1
  cf="$(mktemp)"; printf '%s' "$changes" >"$cf" # by file: a big layout would not fit on a command line
  body="$(printf '%s' "$cur" | jq -c --arg id "$f" --arg s "$(newid)" --slurpfile ch "$cf" '{id:$id,"session-id":$s,revn:(.revn // 0),vern:(.vern // 0),changes:$ch[0]}')" || { rm -f "$cf"; die "could not read the file's revision."; }
  rm -f "$cf"
  rpc update-file "$body" >/dev/null || exit 1
}

# --- shared jq helpers -----------------------------------------------------------------------------------------
read -r -d '' COMMON_JQ <<'JQ'
# The name a shape shows in Penpot (and is matched by on re-apply), and the Penpot type it becomes.
def nm: .name // (if .type == "text" then .text elif .type == "image" then "Image" elif .type == "group" then "Group"
  elif (.type == "board" or .type == null) then "Board" else .type end);
def etype: {board:"frame",rect:"rect",image:"rect",ellipse:"circle",text:"text",group:"group"}[.type // "board"];
def hexok: type == "string" and test("^#[0-9a-fA-F]{6}$");
# A colour value: #rrggbb as is, or a name from the palette $p; null when it is neither.
def res($p): . as $v
  | (if ($v | hexok) then $v elif ($v | type) == "string" and ($p | has($v)) then $p[$v] else null end)
  | if hexok then . else null end;
# Text box size. Penpot's export doesn't regrow text, so a box that is too small loses words: estimate generously.
# A character is taken as 0.6 of the font size (capitals and bold are wider than the 0.5 average). With `w`, the text is
# word-wrapped to that width and the height is lines x size x line height; without `w` it is one line per paragraph
# ("\n" starts a new one) and the width gets half a character of slack. An explicit `h` always wins.
def lh($n): ($n.lineHeight // 1.2);
def wraplines($p; $cpl): reduce ($p | split(" ") | .[]) as $wd ({n: 1, len: 0};
    ($wd | length) as $l
    | if .len == 0 then .len = $l
      elif .len + 1 + $l <= $cpl then .len += 1 + $l
      else .n += 1 | .len = $l end)
  | .n + (if .len > $cpl then ((.len / $cpl) | ceil) - 1 else 0 end);
def textsize($n): ($n.size // 16) as $s | ($s * 0.6) as $cw | (($n.text // "") | split("\n")) as $ps
  | ($n.w // ((([$ps[] | length] | max // 0) * $cw + $s * 0.5) | ceil)) as $w
  | ([1, (($w / $cw) | floor)] | max) as $cpl
  | (if $n.w then ([$ps[] | wraplines(.; $cpl)] | add // 1) else ($ps | length) end) as $lines
  | {w: $w, h: ($n.h // (([$lines, 1] | max) * $s * lh($n) + $s * 0.2 | ceil))};
# Bounding box of a node in board coordinates (groups: union of children).
def bbox($n): if $n.type == "group"
  then ([$n.children[] | select(has("remove") | not) | bbox(.)]) as $b
    | {x: ($b|map(.x)|min), y: ($b|map(.y)|min), x2: ($b|map(.x2)|max), y2: ($b|map(.y2)|max)}
  elif $n.type == "text" then textsize($n) as $t | {x:($n.x // 0), y:($n.y // 0), x2:(($n.x // 0)+$t.w), y2:(($n.y // 0)+$t.h)}
  else {x:($n.x // 0), y:($n.y // 0), x2:(($n.x // 0)+($n.w // 100)), y2:(($n.y // 0)+($n.h // 100))} end;
JQ

# --- validate: plain-word problems (errors stop an apply) and contrast/duplicate-name warnings ------------------------
read -r -d '' CHECK_JQ <<'JQ'
def lab: map("\"\(.)\"") | join(" > ");
def hex2n: explode | map(if . >= 97 then . - 87 elif . >= 65 then . - 55 else . - 48 end) | reduce .[] as $d (0; . * 16 + $d);
def chan: . / 255 | if . <= 0.03928 then . / 12.92 else pow((. + 0.055) / 1.055; 2.4) end;
def lum: (.[1:3] | hex2n | chan) as $r | (.[3:5] | hex2n | chan) as $g | (.[5:7] | hex2n | chan) as $b
  | 0.2126 * $r + 0.7152 * $g + 0.0722 * $b;
def ratio($a; $b): ($a | lum) as $x | ($b | lum) as $y | (([$x, $y] | max) + 0.05) / (([$x, $y] | min) + 0.05);
def kids: if (.children | type) == "array" then .children else [] end;
def live: select(type == "object" and (has("remove") | not));
def nodes($pre): (nm | tostring) as $n | ($pre + [$n]) as $p | {path: $p, node: .}, (kids[] | live | nodes($p));

def chk($pal): .path as $p | .node as $n | ($p | lab) as $l | (($p | length) == 1) as $board
  | (if $board then empty
     elif $n.type == null then "\($l): this shape has no \"type\". Add \"type\": \"rect\", \"ellipse\", \"text\", \"group\" or \"image\"."
     elif ($n.type | IN("rect", "ellipse", "text", "group", "image") | not) then "\($l): unknown shape type \"\($n.type)\". Use rect, ellipse, text, group or image."
     else empty end),
    (if $n.type == "text" and (($n.text | type) != "string" or $n.text == "") then "\($l): a text shape needs a \"text\" value. Add the words to show." else empty end),
    (if $n.type == "group" and ($n | kids | length) == 0 then "\($l): a group needs at least one shape in \"children\". Add one, or remove the group." else empty end),
    (if $n.type == "text" and $n.weight != null and (($n.weight | tostring) | IN("regular", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900") | not)
      then "\($l): unknown weight \"\($n.weight)\". Use \"regular\" or \"bold\" (or 100 to 900 in steps of 100 for a Google font)." else empty end),
    (if $n.type == "text" and ($n.font // "sourcesanspro") == "sourcesanspro" and $n.weight != null and (($n.weight | tostring) | IN("regular", "bold", "400", "700") | not)
      then "\($l): the built-in font only has \"regular\" and \"bold\". Use one of those." else empty end),
    (if $n.type == "text" and ($n.lineHeight | type) == "number" and ($n.lineHeight < 0.5 or $n.lineHeight > 4)
      then "\($l): \"lineHeight\" is a multiple of the text size, like 1.5. Use a number between 0.5 and 4." else empty end),
    (("x", "y", "w", "h", "size", "radius", "strokeWidth", "lineHeight") as $k | select($n[$k] != null and ($n[$k] | type) != "number")
      | "\($l): \"\($k)\" must be a number, not \"\($n[$k])\". Fix the value."),
    (("fill", "stroke") as $k | select($n[$k] != null and ($n[$k] | res($pal)) == null)
      | "\($l): \($k) \"\($n[$k])\" is not a #rrggbb colour and is not a name in \"colours\". Use a #rrggbb value, or add the name to \"colours\"."),
    (if $board and $n.preset != null and ($n.preset | IN("desktop", "mobile") | not)
      then "\($l): unknown preset \"\($n.preset)\". Use \"desktop\" (1440x1024) or \"mobile\" (390x844), or give w and h." else empty end),
    ($n | kids[] | select(type != "object") | "\($l): every entry in \"children\" must be a shape written as { ... }. Remove or fix the stray value.");

def dupw($pre; $items): ([$items[] | live]) as $it
  | ([$it[] | (nm | tostring)] | group_by(.) | map(select(length > 1))[]
      | "\(if ($pre | length) == 0 then "The boards" else ($pre | lab) end): \(length) shapes are named \"\(.[0])\". Re-apply matches shapes by name, so give each its own name."),
    ($it[] | . as $x | select(($x | kids | length) > 0) | dupw($pre + [$x | nm | tostring]; $x | kids));

def contrast($pal): . as $b
  | [$b | nodes([])] as $all
  | (($b.fill // "#ffffff") | res($pal)) as $bg0
  | $all | to_entries[] | select(.value.node.type == "text")
  | .key as $i | .value as $t | $t.node as $n
  | ($n.fill // "#000000" | res($pal)) as $fg
  | ($n.x // 0) as $tx | ($n.y // 0) as $ty
  | ([$all[:$i][] | select(.node.type | IN("rect", "ellipse", "image"))
      | select((.node | bbox(.)) as $r | $r.x <= $tx and $tx < $r.x2 and $r.y <= $ty and $ty < $r.y2)
      | (.node.fill // "#cccccc") | res($pal) | select(. != null)] | last // $bg0) as $bg
  | select($fg != null and $bg != null)
  | ratio($fg; $bg) as $r | (if ($n.size // 16) >= 24 then 3 else 4.5 end) as $need
  | select($r < $need)
  | "\($t.path | lab): the text colour \($fg) on \($bg) has a contrast of \($r * 100 | round / 100):1, but it needs \($need):1 to be easy to read. Use a darker or lighter colour for the text or for what is behind it.";

(.colours // {}) as $pal
| if ($pal | type) != "object" then {errors: ["\"colours\" must be a map of names to #rrggbb colours, like {\"brand\": \"#1e40af\"}."], warnings: []}
  elif (.boards | type) != "array" then {errors: ["The layout needs a \"boards\" list, like {\"page\":\"Page 1\",\"boards\":[{\"name\":\"Desktop\",\"preset\":\"desktop\"}]}."], warnings: []}
  else
    ([.boards[] | live | nodes([])]) as $all
    | {errors: ([
        ($pal | to_entries[] | select(.value | hexok | not) | "Colour \"\(.key)\" in \"colours\" is not a #rrggbb value (like #1e40af). Fix its value."),
        (.boards[] | select(type != "object") | "Every entry in \"boards\" must be a board written as { ... }. Remove or fix the stray value."),
        ([.. | objects | select(has("remove") and (.remove | type) != "string")][0] // empty | "A \"remove\" entry must name the shape to remove, like {\"remove\": \"Old title\"}."),
        (if ($all | length) > 400 then "The layout has \($all | length) shapes; the most one apply takes is 400. Split it into pages." else empty end),
        ($all[] | chk($pal))
      ]),
      warnings: ([dupw([]; .boards)] + [.boards[] | live | contrast($pal)])}
  end
JQ

# Resolve presets and palette names to real sizes and #rrggbb colours; boards get type "board".
read -r -d '' PREPARE_JQ <<'JQ'
(.colours // {}) as $pal
| .boards |= map(if has("remove") then . else
    ((if .preset then . + {w: (.w // ({desktop: 1440, mobile: 390}[.preset])), h: (.h // ({desktop: 1024, mobile: 844}[.preset]))} else . end) + {type: "board"}) end)
| walk(if type == "object" and has("type") then
    (if has("fill") then .fill |= res($pal) else . end) | (if has("stroke") then .stroke |= res($pal) else . end) else . end)
| del(.colours)
JQ

# Match layout shapes to the shapes already on the page by name (and kind). Matched ones take the existing id and are
# marked _eid; {"remove": "Name"} entries get _remove = the id to delete. Needs --slurpfile o (the page's objects) and --arg root.
read -r -d '' RESOLVE_JQ <<'JQ'
def resolve($kids; $objs): . as $items
  | [range(0; length) as $i | $items[$i] as $it
     | if ($it | has("remove")) then $it + {_remove: ([$kids[] | select($objs[.].name == $it.remove)][0])}
       else
         ($it | nm) as $n | ($it | etype) as $t
         | ([$items[:$i][] | select(has("remove") | not) | select(nm == $n and etype == $t)] | length) as $k
         | ([$kids[] | select($objs[.].name == $n and $objs[.].type == $t)][$k]) as $eid
         | if $eid == null then $it
           else $it + {_eid: $eid, id: $eid, _idx: ($kids | index($eid)), _x: $objs[$eid].x, _y: $objs[$eid].y}
             | if (.children | type) == "array" then .children |= resolve($objs[$eid].shapes // []; $objs) else . end
           end
       end];
$o[0] as $objs | ($objs[$root].shapes // []) as $kids | .boards |= resolve($kids; $objs)
JQ

# --- layout -> add-obj changes ---------------------------------------------------------------------------------
# Input: the prepared, numbered and resolved layout plus --arg page_id/page_name/root and --argjson new_page/startx/media.
# Output: changes array. New shapes are added; shapes matched by name are re-created in place (same id and place in the
# stack); a matched group keeps its frame and is updated child by child; a matched board keeps its id, place and size
# (so comments on it survive) and only takes a new fill/stroke; nothing is removed unless the layout says {"remove": ..}.
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
# Weight: "regular" or "bold" (or a number 100-900 for Google fonts). The built-in font's variant ids are "regular" and
# "bold"; Google fonts' are "regular", "700" and so on, so "bold" there would match nothing and fall back to a serif.
def wnum($n): ($n.weight // "regular" | tostring) | if . == "bold" then "700" elif . == "regular" then "400" else . end;
def variant($n): wnum($n) as $w | if ($n.font // "sourcesanspro") == "sourcesanspro"
  then (if $w == "400" then "regular" elif $w == "700" then "bold" else $w end)
  else (if $w == "400" then "regular" else $w end) end;
def textstyle($n): {
  "font-id": fontid($n.font // "sourcesanspro"), "font-family": ($n.font // "sourcesanspro"),
  "font-variant-id": variant($n), "font-size": (($n.size // 16) | tostring),
  "font-weight": wnum($n), "font-style": "normal",
  "text-align": ($n.align // "left"), "text-decoration": "none", "text-transform": "none",
  "letter-spacing": "0", "line-height": (lh($n) | tostring), "vertical-align": "top",
  fills: fills($n.fill // "#000000")};
# One paragraph per line of the text ("\n" starts a new paragraph).
def textcontent($n): textstyle($n) as $st
  | {type:"root","vertical-align":"top",children:[{type:"paragraph-set",children:[
      ($n.text | split("\n")[] | {type:"paragraph",children:[($st + {text:.})]} + $st) ]}]};

def op($a; $v): {type:"set",attr:$a,val:$v,"ignore-touched":true};
def delc($id): [{type:"del-obj",id:$id,"page-id":$page_id}];
def relaid($n; $adds): if $n._eid then delc($n.id) + ($adds | map(. + {index: $n._idx})) else $adds end;

# Changes for a node inside a board: ox/oy are the board's page position; the layout's x/y are relative to the board.
def shape($n; $frame; $parent; $ox; $oy):
  if ($n | has("remove")) then (if $n._remove then delc($n._remove) else [] end)
  elif $n.type == "group" then
    if $n._eid then ([$n.children[] | shape(.; $frame; $n.id; $ox; $oy)] | add // [])
    else bbox($n) as $g | ($g.x + $ox) as $x | ($g.y + $oy) as $y
      | [{type:"add-obj",id:$n.id,"page-id":$page_id,"frame-id":$frame,"parent-id":$parent,
          obj:(base + geom($x;$y;($g.x2-$g.x);($g.y2-$g.y)) + {id:$n.id,type:"group",name:($n|nm),"frame-id":$frame,"parent-id":$parent,shapes:[]})}]
      + ([$n.children[] | shape(.; $frame; $n.id; $ox; $oy)] | add // [])
    end
  elif $n.type == "text" then
    textsize($n) as $t | (($n.x // 0) + $ox) as $x | (($n.y // 0) + $oy) as $y
    | relaid($n; [{type:"add-obj",id:$n.id,"page-id":$page_id,"frame-id":$frame,"parent-id":$parent,
        obj:(base + geom($x;$y;$t.w;$t.h) + {id:$n.id,type:"text",name:($n|nm),"frame-id":$frame,"parent-id":$parent,
          content:textcontent($n),"grow-type":(if $n.w then "auto-height" else "auto-width" end),"position-data":null})}])
  else # rect, image (a rect filled with the uploaded picture, or grey), and ellipse (a circle-type rect)
    (($n.x // 0) + $ox) as $x | (($n.y // 0) + $oy) as $y
    | (if $n.type == "image" and $media[$n.id] then [{"fill-image":$media[$n.id],"fill-opacity":1}] else fills($n.fill // "#cccccc") end) as $fl
    | relaid($n; [{type:"add-obj",id:$n.id,"page-id":$page_id,"frame-id":$frame,"parent-id":$parent,
        obj:(base + geom($x;$y;($n.w // 100);($n.h // 100)) + {id:$n.id,type:(if $n.type == "ellipse" then "circle" else "rect" end),
          name:($n|nm),"frame-id":$frame,"parent-id":$parent,fills:$fl,strokes:strokes($n),
          r1:($n.radius // 0),r2:($n.radius // 0),r3:($n.radius // 0),r4:($n.radius // 0),rx:($n.radius // 0),ry:($n.radius // 0)})}])
  end;

def board($b; $x): ($b.y // 0) as $y
  | [{type:"add-obj",id:$b.id,"page-id":$page_id,"frame-id":$root,"parent-id":$root,
      obj:(base + geom($x;$y;($b.w // 1440);($b.h // 900)) + {id:$b.id,type:"frame",name:($b|nm),
        "frame-id":$root,"parent-id":$root,fills:fills($b.fill // "#ffffff"),strokes:strokes($b),shapes:[],"hide-in-viewer":false,
        r1:($b.radius // 0),r2:($b.radius // 0),r3:($b.radius // 0),r4:($b.radius // 0)})}]
    + ([($b.children // [])[] | shape(.; $b.id; $b.id; $x; $y)] | add // []);

def board_update($b):
  (if $b.fill != null or $b.stroke != null then
     [{type:"mod-obj",id:$b.id,"page-id":$page_id,operations:(
        (if $b.fill != null then [op("fills"; fills($b.fill))] else [] end)
        + (if $b.stroke != null then [op("strokes"; strokes($b))] else [] end))}]
   else [] end)
  + ([($b.children // [])[] | shape(.; $b.id; $b.id; $b._x; $b._y)] | add // []);

(if $new_page then [{type:"add-page",id:$page_id,name:$page_name}] else [] end)
+ (reduce .boards[] as $b ({x:$startx, out:[]};
    if ($b | has("remove")) then .out += (if $b._remove then delc($b._remove) else [] end)
    elif $b._eid then .out += board_update($b)
    else ($b.x // .x) as $bx
      | .out += board($b; $bx)
      | .x = ($bx + ($b.w // 1440) + 100) end) | .out)
JQ

# Resolve presets and palette names, then number every board and shape from a pool of ids and check the shape types.
prepare_layout() { # prepare_layout LAYOUT.json: prints the layout with sizes and colours filled in
  jq -c "$COMMON_JQ $PREPARE_JQ" "$1" || die "could not read the layout."
}
number_layout() { # number_layout: prepared layout on stdin; prints it with an id on every board and shape
  local ids
  ids="$(for _ in $(seq 1 400); do newid; done | jq -R . | jq -sc .)"
  jq -c --argjson ids "$ids" '
    if (.boards | type) != "array" then error("layout needs a boards list") else . end
    | [.. | objects | select(has("type") and (.type | IN("board","rect","text","group","ellipse","image") | not))] as $bad
    | if ($bad | length) > 0 then error("unknown shape type: " + ($bad[0].type | tostring)) else . end
    | [paths(type == "object" and has("type"))] as $ps
    | if ($ps | length) > ($ids | length) then error("layout is too big (max 400 shapes)") else . end
    | reduce range(0; $ps | length) as $i (.; setpath($ps[$i] + ["id"]; $ids[$i]))' || die "the layout is not valid (needs {\"page\":\"Name\",\"boards\":[{\"name\":..,\"w\":..,\"h\":..,\"children\":[..]}]}, shape types rect, text, group, ellipse, image). Run validate on it for details."
}

# Prints the problems and warnings found in the layout; fails when there are problems.
check_layout() { # check_layout LAYOUT.json
  local rep
  rep="$(jq -c "$COMMON_JQ $CHECK_JQ" "$1")" || { echo "error: $1 is not valid JSON (or has the wrong shape). Check the commas and brackets."; return 1; }
  printf '%s' "$rep" | jq -r '(.errors[] | "error: " + .), (.warnings[] | "warning: " + .)'
  [ "$(printf '%s' "$rep" | jq '.errors | length')" -eq 0 ]
}

# Uploads each image shape's file (its "path") into the Penpot file; prints {shape-id: image fill} for the ones that worked.
# Anything that fails is told on stderr and left out, so that shape is drawn as a grey "Image" placeholder instead.
upload_images() { # upload_images FILE_ID LAYOUT_JSON
  local f="$1" media='{}' id path ext mime size dir tmp code entry
  while IFS=$'\t' read -r id path; do
    [ -n "$id" ] || continue
    ext="$(printf '%s' "${path##*.}" | tr '[:upper:]' '[:lower:]')"
    case "$ext" in png) mime=image/png ;; jpg|jpeg) mime=image/jpeg ;; gif) mime=image/gif ;; webp) mime=image/webp ;;
      *) echo "note: image '$path' is not a png, jpg, gif or webp; drawn as a grey Image placeholder." >&2; continue ;; esac
    if [ ! -f "$path" ] || [ ! -r "$path" ]; then echo "note: can't read image '$path'; drawn as a grey Image placeholder." >&2; continue; fi
    size="$(wc -c <"$path")"
    if [ "$size" -gt 5242880 ]; then echo "note: image '$path' is over 5 MB; drawn as a grey Image placeholder." >&2; continue; fi
    case "$(head -c 12 "$path" | od -An -tx1 | tr -d ' \n')" in
      89504e47*|ffd8ff*|47494638*|52494646????????57454250) ;;
      *) echo "note: '$path' does not look like a real picture file; drawn as a grey Image placeholder." >&2; continue ;;
    esac
    dir="$(mktemp -d)"; cp "$path" "$dir/image.$ext"; tmp="$(mktemp)"
    code="$(curl_auth -o "$tmp" -w '%{http_code}' -X POST -H 'Accept: application/json' -F "file-id=$f" -F "name=image" -F "is-local=true" -F "content=@$dir/image.$ext;type=$mime" "$base/api/rpc/command/upload-file-media-object")" || code=000
    rm -rf "$dir"
    entry=""
    case "$code" in 2??) entry="$(jq -c --arg m "$mime" 'select(.id != null and .width != null) | {id:.id,width:.width,height:.height,mtype:(.mtype // $m),"keep-aspect-ratio":true}' "$tmp" 2>/dev/null)" ;; esac
    rm -f "$tmp"
    if [ -n "$entry" ]; then media="$(printf '%s' "$media" | jq -c --arg k "$id" --argjson e "$entry" '. + {($k):$e}')"
    else echo "note: Penpot did not accept the upload of '$path' (HTTP $code); drawn as a grey Image placeholder." >&2; fi
  done < <(printf '%s' "$2" | jq -r '.. | objects | select(.type == "image" and (.path | type) == "string") | "\(.id)\t\(.path)"')
  printf '%s' "$media"
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
  pages)
    need "pages FILE_ID" "${2:-}"
    get_file "$2" | jq -r '.data as $d | ($d.pages // ($d["pages-index"] | keys))[] | "\(.)\t\($d["pages-index"][.].name)"' ;;
  rename-page)
    need "rename-page FILE_ID PAGE_ID NAME" "${4:-}"; guard "$2"
    get_file "$2" | jq -e --arg p "$3" '.data["pages-index"] | has($p)' >/dev/null || die "file $2 has no page $3 (list them with: pages $2)."
    update_file "$2" "$(jq -nc --arg p "$3" --arg n "$4" '[{type:"mod-page",id:$p,name:$n}]')" && echo "Renamed page to $4" ;;
  delete-page)
    need "delete-page FILE_ID PAGE_ID" "${3:-}"; guard "$2"
    n="$(get_file "$2" | jq -r --arg p "$3" '.data["pages-index"] | if has($p) then length else "missing" end')" || exit 1
    [ "$n" != missing ] || die "file $2 has no page $3 (list them with: pages $2)."
    [ "$n" -gt 1 ] || die "page $3 is the file's only page, and a Penpot file needs one. Add your page first, or delete the whole file."
    update_file "$2" "$(jq -nc --arg p "$3" '[{type:"del-page",id:$p}]')" && echo "Deleted page $3" ;;
  validate)
    need "validate LAYOUT.json" "${2:-}"; [ -r "$2" ] || die "can't read $2."
    if check_layout "$2"; then echo "Layout is fine: nothing was written."; else echo "Fix the errors above, then validate again. Nothing was written."; exit 1; fi ;;
  apply)
    need "apply FILE_ID LAYOUT.json" "${3:-}"; [ -r "$3" ] || die "can't read $3."
    guard "$2"
    check_layout "$3" >&2 || die "the layout has problems (listed above); nothing was changed. Fix them and apply again."
    layout="$(prepare_layout "$3" | number_layout)" || exit 1
    cur="$(get_file "$2")" || exit 1
    page_name="$(printf '%s' "$layout" | jq -r '.page // "Page 1"')"
    page_id="$(printf '%s' "$cur" | jq -r --arg n "$page_name" '[.data["pages-index"][] | select(.name==$n)][0].id // empty')"
    new_page=false
    if [ -z "$page_id" ]; then page_id="$(newid)"; new_page=true; fi
    startx="$(printf '%s' "$cur" | jq -r --arg p "$page_id" '[.data["pages-index"][$p].objects // {} | .[] | select(.["parent-id"] == "'"$root_id"'" and .id != "'"$root_id"'") | (.x + .width)] | (max // -100) + 100 | floor')"
    # Shapes already on the page are matched by name: those are updated in place, the rest added.
    of="$(mktemp)"; printf '%s' "$cur" | jq -c --arg p "$page_id" '.data["pages-index"][$p].objects // {}' >"$of"
    layout="$(printf '%s' "$layout" | jq -c --slurpfile o "$of" --arg root "$root_id" "$COMMON_JQ $RESOLVE_JQ")"; rc=$?; rm -f "$of"
    [ "$rc" -eq 0 ] || die "could not match the layout to the shapes already on the page."
    media="$(upload_images "$2" "$layout")"
    changes="$(printf '%s' "$layout" | jq -c --arg page_id "$page_id" --arg page_name "$page_name" --argjson new_page "$new_page" --argjson startx "$startx" --argjson media "$media" --arg root "$root_id" "$COMMON_JQ $LAYOUT_JQ")" || die "could not turn the layout into Penpot changes."
    update_file "$2" "$changes" || exit 1
    printf 'page\t%s\t%s\n' "$page_id" "$page_name"
    printf '%s' "$layout" | jq -r "$COMMON_JQ"'
      def status: if ._eid then "updated" else "added" end;
      .boards[] | if has("remove") then (select(._remove) | "removed\t\(._remove)\t\(.remove)")
        else "board\t\(.id)\t\(nm)\t\(status)",
          ((.children // [] | .. | objects | select(has("type") or has("remove"))
            | if has("remove") then (select(._remove) | "removed\t\(._remove)\t\(.remove)") else "\(.type)\t\(.id)\t\(nm)\t\(status)" end)) end' ;;
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
          | ($sh + {x:$x,y:$y,width:$w,height:$h,"position-data":null,
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
  *) die "usage: penpot.sh check | teams | projects TEAM_ID | files PROJECT_ID | pages FILE_ID | boards FILE_ID | shapes FILE_ID | link FILE_ID [PAGE_ID] | export FILE_ID PAGE_ID BOARD_ID OUT.png | agent-project TEAM_ID | create-file PROJECT_ID NAME | rename-file FILE_ID NAME | delete-file FILE_ID | rename-page FILE_ID PAGE_ID NAME | delete-page FILE_ID PAGE_ID | validate LAYOUT.json | apply FILE_ID LAYOUT.json | modify FILE_ID PAGE_ID SHAPE_ID key=value... | remove-shape FILE_ID PAGE_ID SHAPE_ID" ;;
esac
