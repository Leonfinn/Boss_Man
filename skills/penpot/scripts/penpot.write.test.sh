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
out=""; wc=""; data=""; url="${*: -1}"
a=("$@")
for i in "${!a[@]}"; do
  [[ ${a[i]} == -o ]] && out="${a[i+1]}"
  [[ ${a[i]} == -w ]] && wc="${a[i+1]}"
  [[ ${a[i]} == --data ]] && data="${a[i+1]#@}"
done
case "$url" in
  */update-file) cp "$data" "$FAKE_DIR/update-file.json"; body='{}' ;;
  */get-file) body='{"id":"FILE1","projectId":"PROJ1","teamId":"T1","revn":3,"vern":0,"data":{"pagesIndex":{"PAGE1":{"id":"PAGE1","name":"Page 1","objects":{"00000000-0000-0000-0000-000000000000":{"id":"00000000-0000-0000-0000-000000000000","parentId":"00000000-0000-0000-0000-000000000000","type":"frame","x":0,"y":0,"width":0.01}}}}}}' ;;
  */get-teams) body='[{"id":"T1","name":"Team","permissions":{"isOwner":true}}]' ;;
  */get-projects) body="[{\"id\":\"PROJ1\",\"name\":\"${FAKE_PROJECT_NAME}\"}]" ;;
  */create-file) body='{"id":"NEWFILE"}' ;;
  *) body='{}' ;;
esac
printf '%s' "$body" >"$out"; printf '%s' 200
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

# Link has no token; the token reached curl only through stdin.
run link FILE1 >"$t/link"
grep -q "file-id=FILE1" "$t/link" || fail "link missing file id"
if grep -rq 'SUPERSECRET123' "$t/link" "$t/err" "$t/out"; then fail "token printed"; fi
if grep '^curl ' "$t/curl.log" | grep -q SUPERSECRET123; then fail "token on a command line"; fi
if grep -rq 'SUPERSECRET123' "$t/penpot-agent-files.txt"; then fail "token saved in the file list"; fi

echo "penpot.write.test.sh: ok"
