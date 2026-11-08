#!/usr/bin/env bash
# Checks the write commands of penpot.sh with a fake curl and the real jq: a layout becomes the right update-file
# changes (with session-id, vern and revn), the ownership guard refuses files outside the agent project, and the
# token never shows up in output or on a command line.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir "$t/bin"
cat >"$t/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >>"$FAKE_CURL_LOG"
[[ "$*" == *" -K -"* ]] && cat >/dev/null # the auth config arrives on stdin
code=""; out=""; wc=""; data=""; url="${*: -1}"
a=("$@")
for i in "${!a[@]}"; do
  [[ ${a[i]} == -o ]] && out="${a[i+1]}"
  [[ ${a[i]} == -w ]] && wc="${a[i+1]}"
  [[ ${a[i]} == --data ]] && data="${a[i+1]#@}"
done
case "$url" in
  */update-file) cp "$data" "$FAKE_DIR/update-file.json"; body='{}' ;;
  */upload-file-media-object) if [[ -n ${FAKE_UPLOAD_FAIL:-} ]]; then code=500; body='{}'; else body='{"id":"MEDIA1","width":640,"height":480,"mtype":"image/png","name":"image"}'; fi ;;
  */get-file) [[ -n ${FAKE_FILE_JSON:-} ]] && body="$(cat "$FAKE_FILE_JSON")" || body='{"id":"FILE1","projectId":"PROJ1","teamId":"T1","revn":3,"vern":0,"data":{"pagesIndex":{"PAGE1":{"id":"PAGE1","name":"Page 1","objects":{"00000000-0000-0000-0000-000000000000":{"id":"00000000-0000-0000-0000-000000000000","parentId":"00000000-0000-0000-0000-000000000000","type":"frame","x":0,"y":0,"width":0.01}}}}}}' ;;
  */get-teams) body='[{"id":"T1","name":"Team","permissions":{"isOwner":true}}]'; [[ -n ${FAKE_TEAMS:-} ]] && body="$FAKE_TEAMS" ;;
  */get-projects) body="[{\"id\":\"PROJ1\",\"name\":\"${FAKE_PROJECT_NAME}\"}]" ;;
  */create-file) body='{"id":"NEWFILE"}' ;;
  *) body='{}' ;;
esac
printf '%s' "$body" >"$out"; printf '%s' "${code:-200}"
FAKE
chmod +x "$t/bin/curl"
export PATH="$t/bin:$PATH" FAKE_CURL_LOG="$t/curl.log" FAKE_DIR="$t" TMPDIR="$t"
export PENPOT_URL="http://10.9.9.9:9001" PENPOT_TOKEN="SUPERSECRET123" FAKE_PROJECT_NAME="Agent designs"
fail() { echo "FAIL: $*"; exit 1; }
run() { bash "$here/penpot.sh" "$@" 2>"$t/err"; }

cat >"$t/layout.json" <<'JSON'
{"page":"Home","boards":[
 {"name":"Desktop","w":1440,"h":900,"children":[
  {"type":"rect","name":"Hero","x":0,"y":0,"w":1440,"h":400,"fill":"#1e40af"},
  {"type":"text","name":"Title","x":80,"y":120,"text":"Hello","size":48,"fill":"#ffffff"},
  {"type":"group","name":"Card","children":[{"type":"rect","x":80,"y":450,"w":300,"h":200}]}]},
 {"name":"Mobile","w":390,"h":844}]}
JSON

# A file in the agent project: apply works and sends a well-formed update-file.
run apply FILE1 "$t/layout.json" >"$t/out" || { cat "$t/err"; fail "apply failed"; }
u="$t/update-file.json"
jq -e '.["session-id"] and .vern == 0 and .revn == 3 and .id == "FILE1"' "$u" >/dev/null || fail "session-id/vern/revn missing"
jq -e '.changes[0].type == "add-page" and .changes[0].name == "Home"' "$u" >/dev/null || fail "new page not added"
jq -e '[.changes[] | select(.type == "add-obj")] | length == 6' "$u" >/dev/null || fail "expected 6 shapes"
jq -e '[.changes[] | select(.type == "add-obj") | .obj | select(.selrect and .["transform-inverse"] and .["frame-id"])] | length == 6' "$u" >/dev/null || fail "add-obj lacks selrect/transform-inverse/frame-id"
jq -e '[.changes[] | select(.obj.type == "frame" and .obj.name == "Desktop")] | .[0].obj.width == 1440' "$u" >/dev/null || fail "board size wrong"
jq -e '([.changes[] | select(.obj.name == "Mobile")][0].obj.x) == 1540' "$u" >/dev/null || fail "second board not placed beside the first"
grp="$(jq -r '.changes[] | select(.obj.type == "group") | .id' "$u")"
jq -e --arg g "$grp" '[.changes[] | select(.obj["parent-id"] == $g)] | length == 1' "$u" >/dev/null || fail "group child not inside the group"
jq -e '.changes[] | select(.obj.type == "group") | .obj.width == 300' "$u" >/dev/null || fail "group size is not its children's box"
grep -q "^board" "$t/out" || fail "no ids printed"

# Bad layouts are refused with a message.
echo '{"boards":[{"name":"X","children":[{"type":"star"}]}]}' >"$t/bad.json"
if run apply FILE1 "$t/bad.json" >/dev/null; then fail "accepted an unknown shape type"; fi

# A file outside the agent project is refused, and nothing is sent.
export FAKE_PROJECT_NAME="Owner stuff"; rm -f "$u"
if run apply FILE1 "$t/layout.json" >/dev/null; then fail "wrote to an owner's file"; fi
grep -q "Agents only change their own files" "$t/err" || fail "unclear refusal"
[[ ! -e $u ]] || fail "sent a change despite the refusal"
if run delete-file FILE1 >/dev/null; then fail "deleted an owner's file"; fi
if run remove-shape FILE1 PAGE1 SHAPE1 >/dev/null; then fail "removed a shape in an owner's file"; fi

# A file this helper created is allowed wherever it lives.
run create-file PROJX "My design" >/dev/null || fail "create-file failed"
run remove-shape NEWFILE PAGE1 SHAPE1 >/dev/null || { cat "$t/err"; fail "could not edit own file"; }
jq -e '.changes[0].type == "del-obj"' "$u" >/dev/null || fail "remove-shape sent the wrong change"

# There is no override: an agent cannot unlock an owner file by setting a variable.
FAKE_PROJECT_NAME="Other" PENPOT_ALLOW_OWNER_FILE=1 run remove-shape FILE1 PAGE1 SHAPE1 >/dev/null 2>&1 && fail "override still works"

# ---- BOS-57: presets, palette, validate, update by name, images ----------------------------------------------------
export FAKE_PROJECT_NAME="Agent designs"; rm -f "$u"

# Presets and the 100px gap; palette names become real colours in fills and strokes.
cat >"$t/pal.json" <<'JSON'
{"page":"Pal","colours":{"brand":"#1e40af","ink":"#111111"},"boards":[
 {"name":"Desktop","preset":"desktop","fill":"ink","children":[
  {"type":"rect","name":"Hero","w":200,"h":100,"fill":"brand","stroke":"ink"},
  {"type":"text","name":"T","x":10,"y":10,"text":"Hi","fill":"#ffffff"}]},
 {"name":"Phone","preset":"mobile"},
 {"name":"Wide","preset":"mobile","w":500}]}
JSON
run apply FILE1 "$t/pal.json" >/dev/null || { cat "$t/err"; fail "palette apply failed"; }
jq -e '[.changes[] | select(.obj.type == "frame")] | (.[0].obj | .width == 1440 and .height == 1024 and .x == 0 and .y == 0)' "$u" >/dev/null || fail "desktop preset wrong"
jq -e '[.changes[] | select(.obj.type == "frame")] | (.[1].obj | .width == 390 and .height == 844 and .x == 1540)' "$u" >/dev/null || fail "mobile preset or 100px gap wrong"
jq -e '[.changes[] | select(.obj.type == "frame")] | (.[2].obj | .width == 500 and .height == 844 and .x == 2030)' "$u" >/dev/null || fail "explicit w should beat the preset"
jq -e '.changes[] | select(.obj.name == "Hero") | .obj | .fills[0]["fill-color"] == "#1e40af" and .strokes[0]["stroke-color"] == "#111111"' "$u" >/dev/null || fail "palette names not resolved"
jq -e '.changes[] | select(.obj.name == "Desktop") | .obj.fills[0]["fill-color"] == "#111111"' "$u" >/dev/null || fail "board palette fill not resolved"

# validate: plain-word errors that name the shape and the fix; writes and calls nothing; works without Penpot settings.
cat >"$t/badv.json" <<'JSON'
{"page":"P","colours":{"brand":"#1e40af","oops":"blue"},"boards":[
 {"name":"Desktop","preset":"tablet","children":[
  {"type":"rect","name":"Hero","fill":"brnd"},
  {"type":"star","name":"Spark"},
  {"name":"Loose"},
  {"type":"text","name":"Empty"},
  {"type":"group","name":"Card","children":[]},
  {"type":"rect","name":"Wide","w":"big"}]}]}
JSON
: >"$t/curl.log"; rm -f "$u"
out="$(env -u PENPOT_URL -u PENPOT_TOKEN bash "$here/penpot.sh" validate "$t/badv.json" 2>&1)" && fail "validate passed a bad layout"
for want in '"Desktop" > "Hero": fill "brnd" is not a #rrggbb colour' '"Desktop" > "Spark": unknown shape type "star"' '"Desktop" > "Loose": this shape has no "type"' \
  '"Desktop" > "Empty": a text shape needs a "text"' '"Desktop" > "Card": a group needs at least one shape' '"Desktop" > "Wide": "w" must be a number' \
  'unknown preset "tablet"' 'Colour "oops"'; do
  grep -qF "$want" <<<"$out" || fail "validate missing: $want"
done
[[ ! -s $t/curl.log ]] || fail "validate talked to Penpot"
[[ ! -e $u ]] || fail "validate wrote"
# apply refuses the same layout before sending anything
if run apply FILE1 "$t/badv.json" >/dev/null; then fail "apply accepted a bad layout"; fi
[[ ! -e $u ]] || fail "apply sent changes for a bad layout"

# Contrast: warns under 4.5:1 (3:1 from 24px up), uses the shape behind the text, and still passes (warnings aren't errors).
cat >"$t/contrast.json" <<'JSON'
{"page":"C","boards":[{"name":"Desktop","fill":"#ffffff","children":[
 {"type":"text","name":"Faint","x":10,"y":10,"text":"hello","size":16,"fill":"#aaaaaa"},
 {"type":"text","name":"FaintBig","x":10,"y":50,"text":"hello","size":32,"fill":"#aaaaaa"},
 {"type":"text","name":"Ok","x":10,"y":90,"text":"hello","size":16,"fill":"#111111"},
 {"type":"rect","name":"Band","x":0,"y":120,"w":400,"h":100,"fill":"#1e40af"},
 {"type":"text","name":"OnBand","x":10,"y":130,"text":"hello","size":16,"fill":"#222222"},
 {"type":"text","name":"WhiteOnBand","x":10,"y":170,"text":"hello","size":16,"fill":"#ffffff"}]}]}
JSON
out="$(bash "$here/penpot.sh" validate "$t/contrast.json" 2>&1)" || fail "warnings should not fail validate: $out"
grep -qF '"Desktop" > "Faint": the text colour #aaaaaa on #ffffff has a contrast of 2.32:1, but it needs 4.5:1' <<<"$out" || fail "no small-text contrast warning: $out"
{ grep -qF '"Faint"' <<<"$out" && grep -qF '"FaintBig": the text colour #aaaaaa on #ffffff has a contrast of 2.32:1, but it needs 3:1' <<<"$out"; } || fail "no large-text warning"
grep -qF '"OnBand": the text colour #222222 on #1e40af' <<<"$out" || fail "background shape not used"
grep -q '"Ok"\|WhiteOnBand' <<<"$out" && fail "warned about readable text"

# Re-apply by name: boards and matching shapes keep their ids, new shapes are added, only {"remove": ..} deletes.
cat >"$t/page.json" <<'JSON'
{"id":"FILE1","projectId":"PROJ1","teamId":"t1","revn":4,"vern":0,"data":{"pagesIndex":{"pg":{"id":"pg","name":"Home","objects":{
 "00000000-0000-0000-0000-000000000000":{"id":"00000000-0000-0000-0000-000000000000","parentId":"00000000-0000-0000-0000-000000000000","type":"frame","x":0,"y":0,"width":0.01,"shapes":["b1","b2"]},
 "b1":{"id":"b1","parentId":"00000000-0000-0000-0000-000000000000","type":"frame","name":"Desktop","x":0,"y":0,"width":1440,"height":900,"shapes":["r1","t1","old"]},
 "b2":{"id":"b2","parentId":"00000000-0000-0000-0000-000000000000","type":"frame","name":"Gone","x":1540,"y":0,"width":390,"height":844,"shapes":[]},
 "r1":{"id":"r1","parentId":"b1","frameId":"b1","type":"rect","name":"Hero","x":0,"y":0,"width":100,"height":100},
 "t1":{"id":"t1","parentId":"b1","frameId":"b1","type":"text","name":"Title","x":5,"y":5,"width":50,"height":20},
 "old":{"id":"old","parentId":"b1","frameId":"b1","type":"rect","name":"Keep me","x":0,"y":0,"width":10,"height":10}}}}}}
JSON
cat >"$t/again.json" <<'JSON'
{"page":"Home","boards":[
 {"name":"Desktop","w":999,"h":999,"fill":"#eeeeee","children":[
  {"type":"rect","name":"Hero","x":0,"y":0,"w":300,"h":200,"fill":"#1e40af"},
  {"type":"rect","name":"Footer","x":0,"y":800,"w":1440,"h":100,"fill":"#111111"},
  {"remove":"Title"},
  {"remove":"Never existed"}]},
 {"remove":"Gone"},
 {"name":"Tablet","w":768,"h":1024}]}
JSON
FAKE_FILE_JSON="$t/page.json" run apply FILE1 "$t/again.json" >"$t/out" || { cat "$t/err"; fail "re-apply failed"; }
jq -e '[.changes[] | select(.type == "add-page")] | length == 0' "$u" >/dev/null || fail "re-apply added the page again"
jq -e '[.changes[] | select(.obj.name == "Desktop")] | length == 0' "$u" >/dev/null || fail "re-apply re-created the existing board (comments would be lost)"
jq -e '[.changes[] | select(.type == "del-obj" and .id == "b1")] | length == 0' "$u" >/dev/null || fail "re-apply deleted the board"
jq -e '[.changes[] | select(.type == "del-obj" and .id == "old")] | length == 0' "$u" >/dev/null || fail "re-apply removed a shape that was not asked for"
jq -e '[.changes[] | select(.type == "del-obj")] | map(.id) | sort == ["b2","r1","t1"]' "$u" >/dev/null || fail "wrong set of deletions (R1 re-created, T1 and B2 removed)"
jq -e '.changes[] | select(.type == "add-obj" and .obj.name == "Hero") | .id == "r1" and .index == 0 and .obj.width == 300 and .["frame-id"] == "b1"' "$u" >/dev/null || fail "Hero not updated in place"
jq -e '[.changes[] | select(.type == "add-obj" and .obj.name == "Footer")] | (length == 1 and .[0].id != "r1" and .[0].obj.y == 800)' "$u" >/dev/null || fail "new shape not added"
jq -e '.changes[] | select(.type == "mod-obj" and .id == "b1") | .operations[0].attr == "fills" and .operations[0].val[0]["fill-color"] == "#eeeeee"' "$u" >/dev/null || fail "board fill not updated"
jq -e '[.changes[] | select(.obj.name == "Tablet")] | (length == 1 and .[0].obj.x == 2030)' "$u" >/dev/null || fail "new board not placed after the existing ones"
grep -q "^rect.*r1.*Hero.*updated" "$t/out" || fail "output does not say Hero was updated"
grep -q "^removed.*t1" "$t/out" || fail "output does not list the removal"
# Applying the same layout twice must not duplicate: second run on a page that has the shapes.
FAKE_FILE_JSON="$t/page.json" run apply FILE1 "$t/layout.json" >/dev/null || fail "apply on a page without that name failed"

# Images: uploaded when Penpot takes it, a grey "Image" placeholder when it doesn't.
printf '\x89PNG\r\n\x1a\n%s' "0000000000" >"$t/pic.png"
echo 'not a picture' >"$t/fake.png"
cat >"$t/img.json" <<JSON
{"page":"I","boards":[{"name":"B","children":[
 {"type":"image","name":"Photo","x":0,"y":0,"w":200,"h":100,"path":"$t/pic.png"},
 {"type":"image","name":"Nope","x":0,"y":200,"w":200,"h":100,"path":"$t/fake.png"},
 {"type":"image","x":0,"y":400,"w":50,"h":50}]}]}
JSON
run apply FILE1 "$t/img.json" >/dev/null || { cat "$t/err"; fail "image apply failed"; }
jq -e '.changes[] | select(.obj.name == "Photo") | .obj.fills[0]["fill-image"] | .id == "MEDIA1" and .width == 640' "$u" >/dev/null || fail "uploaded image not used as the fill"
jq -e '.changes[] | select(.obj.name == "Nope") | .obj.fills[0]["fill-color"] == "#cccccc"' "$u" >/dev/null || fail "non-picture file should become a grey placeholder"
grep -q "does not look like a real picture" "$t/err" || fail "no note about the bad picture"
jq -e '.changes[] | select(.obj.name == "Image") | .obj.fills[0]["fill-color"] == "#cccccc"' "$u" >/dev/null || fail "image without a path should be a grey Image"
grep -c 'upload-file-media-object' "$t/curl.log" | grep -qx 1 || fail "should upload exactly the one real picture"
FAKE_UPLOAD_FAIL=1 run apply FILE1 "$t/img.json" >/dev/null || fail "apply should survive a refused upload"
jq -e '.changes[] | select(.obj.name == "Photo") | .obj.fills[0]["fill-color"] == "#cccccc"' "$u" >/dev/null || fail "refused upload should fall back to grey"
grep -q "Penpot did not accept the upload" "$t/err" || fail "no note about the refused upload"
if grep '^curl ' "$t/curl.log" | grep -q SUPERSECRET123; then fail "token on a command line (upload)"; fi

# ---- BOS-94: text sizing, line height, font weights, pages, the guard in a team the agent only belongs to ----------
rm -f "$u"
cat >"$t/text.json" <<'JSON'
{"page":"T","boards":[{"name":"B","children":[
 {"type":"text","name":"Short","x":0,"y":0,"text":"FAQ","size":16},
 {"type":"text","name":"Wrapped","x":0,"y":40,"w":200,"size":16,"lineHeight":1.5,
  "text":"Boss Man runs a small company of agents that plan, build, review and ship work for you while you sleep."},
 {"type":"text","name":"Fixed","x":0,"y":300,"w":200,"h":30,"size":16,"text":"Boss Man runs a small company of agents that plan and build."},
 {"type":"text","name":"Two lines","x":0,"y":400,"size":20,"text":"First\nSecond"},
 {"type":"text","name":"Plex","x":0,"y":500,"size":20,"text":"Plex","font":"IBM Plex Sans","weight":"bold"},
 {"type":"text","name":"Plex semi","x":0,"y":540,"size":20,"text":"Plex","font":"IBM Plex Sans","weight":600},
 {"type":"text","name":"Source","x":0,"y":580,"size":20,"text":"Source","weight":"bold"}]}]}
JSON
run apply FILE1 "$t/text.json" >/dev/null || { cat "$t/err"; fail "text apply failed"; }
tx() { jq -c --arg n "$1" '.changes[] | select(.obj.name == $n) | .obj' "$u"; }
jq -e '.width >= 3 * 16 * 0.6 and .height >= 19' <<<"$(tx Short)" >/dev/null || fail "auto-width text too small: $(tx Short | jq -c '{width,height}')"
# 104 characters at 200px wide (about 20 per line) is 6 lines or more: at 16px x 1.5 that is at least 144px.
jq -e '.width == 200 and .height >= 144 and .["grow-type"] == "auto-height"' <<<"$(tx Wrapped)" >/dev/null || fail "wrapped text height not from its lines: $(tx Wrapped | jq -c '{width,height}')"
jq -e '[.. | objects | select(has("line-height")) | .["line-height"]] | unique == ["1.5"]' <<<"$(tx Wrapped)" >/dev/null || fail "lineHeight not applied"
jq -e '[.. | objects | select(has("line-height")) | .["line-height"]] | unique == ["1.2"]' <<<"$(tx Short)" >/dev/null || fail "default line height is not 1.2"
jq -e '.height == 30' <<<"$(tx Fixed)" >/dev/null || fail "explicit h should win"
jq -e '([.content.children[0].children[] | select(.type == "paragraph")] | map(.children[0].text)) == ["First","Second"] and .height >= 48' <<<"$(tx "Two lines")" >/dev/null || fail "a newline should start a second paragraph (and line)"
jq -e '.content.children[0].children[0].children[0] | .["font-id"] == "gfont-ibm-plex-sans" and .["font-variant-id"] == "700" and .["font-weight"] == "700"' <<<"$(tx Plex)" >/dev/null || fail "Google font bold should use variant 700"
jq -e '.content.children[0].children[0].children[0] | .["font-variant-id"] == "600" and .["font-weight"] == "600"' <<<"$(tx "Plex semi")" >/dev/null || fail "numeric weight not passed on"
jq -e '.content.children[0].children[0].children[0] | .["font-id"] == "sourcesanspro" and .["font-variant-id"] == "bold" and .["font-weight"] == "700"' <<<"$(tx Source)" >/dev/null || fail "built-in font bold should use variant bold"

echo '{"boards":[{"name":"B","children":[{"type":"text","name":"A","text":"a","weight":"heavy"},{"type":"text","name":"S","text":"s","weight":600},{"type":"text","name":"L","text":"l","lineHeight":9},{"type":"text","name":"M","text":"m","lineHeight":"tall"}]}]}' >"$t/badt.json"
out="$(bash "$here/penpot.sh" validate "$t/badt.json" 2>&1)" && fail "validate passed bad text options"
for want in '"B" > "A": unknown weight "heavy"' '"B" > "S": the built-in font only has "regular" and "bold"' '"B" > "L": "lineHeight" is a multiple' '"B" > "M": "lineHeight" must be a number'; do
  grep -qF "$want" <<<"$out" || fail "validate missing: $want"
done

# Pages: list, rename, delete; the only page can't be deleted, nor a page that isn't there.
cat >"$t/pages.json" <<'JSON'
{"id":"FILE1","projectId":"PROJ1","revn":5,"vern":0,"data":{"pages":["p1","p2"],"pagesIndex":{
 "p1":{"id":"p1","name":"Page 1","objects":{}},"p2":{"id":"p2","name":"Home","objects":{}}}}}
JSON
export FAKE_FILE_JSON="$t/pages.json"
run pages FILE1 >"$t/out" || fail "pages failed"
[[ "$(cat "$t/out")" == $'p1\tPage 1\np2\tHome' ]] || fail "pages output wrong: $(cat "$t/out")"
rm -f "$u"; run delete-page FILE1 p1 >/dev/null || { cat "$t/err"; fail "delete-page failed"; }
jq -e '.changes == [{"type":"del-page","id":"p1"}] and .revn == 5' "$u" >/dev/null || fail "delete-page sent the wrong change"
rm -f "$u"; run rename-page FILE1 p2 "Website" >/dev/null || fail "rename-page failed"
jq -e '.changes == [{"type":"mod-page","id":"p2","name":"Website"}]' "$u" >/dev/null || fail "rename-page sent the wrong change"
rm -f "$u"; if run delete-page FILE1 nope >/dev/null; then fail "deleted a missing page"; fi
grep -q "has no page nope" "$t/err" || fail "missing page unexplained"
cat >"$t/onepage.json" <<'JSON'
{"id":"FILE1","projectId":"PROJ1","revn":5,"vern":0,"data":{"pages":["p1"],"pagesIndex":{"p1":{"id":"p1","name":"Page 1","objects":{}}}}}
JSON
if FAKE_FILE_JSON="$t/onepage.json" run delete-page FILE1 p1 >/dev/null; then fail "deleted the only page"; fi
grep -q "only page" "$t/err" || fail "only-page refusal unexplained"
[[ ! -e $u ]] || fail "sent a change for a refused page delete"
export FAKE_PROJECT_NAME="Owner stuff"
if run delete-page FILE1 p1 >/dev/null; then fail "deleted a page in an owner's file"; fi
grep -q "Agents only change their own files" "$t/err" || fail "page delete in an owner's file not refused by the guard"
unset FAKE_FILE_JSON

# The guard on a later run (no record of created files): "Agent designs" counts in a team where the agent is an editor
# but not the owner (the owner's team, BOS-81), and not in one where it is only a viewer.
rm -f "$t/penpot-agent-files.txt" "$u"; export FAKE_PROJECT_NAME="Agent designs"
FAKE_TEAMS='[{"id":"T1","name":"Boss Man","permissions":{"type":"editor","isOwner":false,"isAdmin":false,"canEdit":true}}]' \
  run remove-shape FILE1 PAGE1 SHAPE1 >/dev/null || { cat "$t/err"; fail "refused the agent project in a team where the agent is an editor"; }
rm -f "$u"
if FAKE_TEAMS='[{"id":"T1","name":"Boss Man","permissions":{"type":"viewer","isOwner":false,"isAdmin":false,"canEdit":false}}]' \
  run remove-shape FILE1 PAGE1 SHAPE1 >/dev/null; then fail "wrote in a team where the agent is only a viewer"; fi
[[ ! -e $u ]] || fail "sent a change from a viewer team"

# Link has no token; the token reached curl only through stdin.
run link FILE1 >"$t/link"
grep -q "file-id=FILE1" "$t/link" || fail "link missing file id"
if grep -rq 'SUPERSECRET123' "$t/link" "$t/err" "$t/out"; then fail "token printed"; fi
if grep '^curl ' "$t/curl.log" | grep -q SUPERSECRET123; then fail "token on a command line"; fi
if grep -rqs 'SUPERSECRET123' "$t/penpot-agent-files.txt"; then fail "token saved in the file list"; fi

echo "penpot.write.test.sh: ok"
