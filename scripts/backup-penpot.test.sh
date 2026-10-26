#!/usr/bin/env bash
# Checks backup-penpot.sh with a fake docker: skip when off, archive contents, second run, retention.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir "$t/bin" "$t/backups" "$t/vol"; echo asset1 >"$t/vol/file1"
cat >"$t/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
case "$1" in
  ps) [[ ${FAKE_RUNNING:-1} == 1 ]] && echo cid123 || true ;;
  exec) echo "-- dump" ;;
  volume) exit 0 ;;
  inspect) echo postgres:15 ;;
  run) tar -C "$FAKE_VOL" -czf - . ;;
esac
FAKE
chmod +x "$t/bin/docker"
export PATH="$t/bin:$PATH" FAKE_LOG="$t/log" FAKE_VOL="$t/vol" BOSSMAN_BACKUP_DIR="$t/backups" BOSSMAN_BACKUP_KEEP=2
fail() { echo "FAIL: $*"; exit 1; }

# Not running: no-op, exit 0, no files, no dump attempted.
FAKE_RUNNING=0 "$here/backup-penpot.sh" >/dev/null
[[ -z "$(ls -A "$t/backups")" ]] || fail "wrote files while Penpot is off"
if grep -q 'docker exec' "$t/log"; then fail "dumped while Penpot is off"; fi

# Running: one archive with both parts; the asset part restores the file.
"$here/backup-penpot.sh" >/dev/null
set -- "$t"/backups/penpot-*.tar; [[ $# -eq 1 && -s $1 ]] || fail "expected one archive"
[[ "$(tar -tf "$1" | sort | tr '\n' ' ')" == "penpot-assets.tar.gz penpot-db.sql.gz " ]] || fail "archive parts wrong"
mkdir "$t/x"; tar -C "$t/x" -xf "$1"; gzip -t "$t/x/penpot-db.sql.gz"
mkdir "$t/r"; tar -C "$t/r" -xzf "$t/x/penpot-assets.tar.gz"; [[ "$(cat "$t/r/file1")" == asset1 ]] || fail "asset not restored"
if find "$t/backups" -maxdepth 1 -name '.*' -mindepth 1 | grep -q .; then fail "temp files left behind"; fi

# Second run (same minute): still one archive, exit 0.
"$here/backup-penpot.sh" >/dev/null
[[ "$(find "$t/backups" -name 'penpot-*.tar' | wc -l)" -eq 1 ]] || fail "second run changed the archives"

# Retention keeps the newest KEEP penpot archives and never touches Boss Man's files.
rm -f "$t"/backups/penpot-20[2-9]*.tar
touch -d '3 days ago' "$t/backups/penpot-2000-01-01-0000.tar" "$t/backups/bossman-old.sql.gz"
touch -d '2 days ago' "$t/backups/penpot-2000-01-02-0000.tar"
touch -d '1 day ago' "$t/backups/penpot-2000-01-03-0000.tar"
"$here/backup-penpot.sh" >/dev/null
[[ ! -e $t/backups/penpot-2000-01-01-0000.tar && ! -e $t/backups/penpot-2000-01-02-0000.tar ]] || fail "old archives kept"
[[ -e $t/backups/bossman-old.sql.gz ]] || fail "deleted a Boss Man backup"
echo "backup-penpot.test.sh: ok"
