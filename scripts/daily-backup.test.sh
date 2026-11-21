#!/usr/bin/env bash
# Checks daily-backup.sh with a fake pg_dump and psql: name, owner-only mode, no second dump the same day,
# a new dump once the newest is old, retention that touches only daily-* files, failures that save nothing
# and say so, and the status rows written to the settings table.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir "$t/bin" "$t/backups"
cat >"$t/bin/pg_dump" <<'FAKE'
#!/usr/bin/env bash
echo pg_dump >>"$FAKE_LOG"
case "${FAKE_DUMP:-ok}" in
  ok) echo "-- dump of the example database" ;;
  empty) : ;;
  fail) echo "boom" >&2; exit 1 ;;
esac
FAKE
cat >"$t/bin/psql" <<'FAKE'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do [[ $1 == -c ]] && { echo "$2" >>"$FAKE_SQL"; break; }; shift; done
[[ ${FAKE_PSQL:-ok} == ok ]] || exit 2
FAKE
chmod +x "$t/bin/pg_dump" "$t/bin/psql"
export PATH="$t/bin:$PATH" FAKE_LOG="$t/log" FAKE_SQL="$t/sql" BOSSMAN_BACKUP_DIR="$t/backups" BOSSMAN_BACKUP_KEEP=3
: >"$t/log"; : >"$t/sql"
fail() { echo "FAIL: $*"; exit 1; }
dumps() { grep -c pg_dump "$t/log" || true; }
count() { find "$t/backups" -maxdepth 1 -name 'daily-*.sql.gz' | wc -l; }

# First pass: one correctly named, owner-only, readable file; the status row names it.
"$here/daily-backup.sh" --once >/dev/null
[[ $(count) -eq 1 ]] || fail "expected one daily file"
f="$(find "$t/backups" -name 'daily-*.sql.gz')"
[[ $(basename "$f") =~ ^daily-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}\.sql\.gz$ ]] || fail "bad name: $f"
[[ $(stat -c %a "$f") == 600 ]] || fail "not mode 600"
[[ $(gzip -dc "$f") == *example* ]] || fail "dump content wrong"
grep -q "daily_backup_last" "$t/sql" || fail "status row not written"
grep -q "$(basename "$f")" "$t/sql" || fail "status row does not name the file"
grep -q "DELETE FROM settings WHERE key = 'daily_backup_failed'" "$t/sql" || fail "old failure row not cleared"
[[ -z $(find "$t/backups" -name '*.partial' -o -name '.*' -mindepth 1) ]] || fail "temp files left"

# A restart or second pass the same day: no new dump.
"$here/daily-backup.sh" --once >/dev/null
[[ $(dumps) -eq 1 && $(count) -eq 1 ]] || fail "dumped twice in one day"

# Retention keeps the newest KEEP daily files and never touches any other file.
mv "$f" "$t/backups/daily-2000-02-01-0300.sql.gz"; touch -d '5 days ago' "$t/backups/daily-2000-02-01-0300.sql.gz"
for d in 1 2 3 4; do touch -d "$((d + 10)) days ago" "$t/backups/daily-2000-01-0${d}-0300.sql.gz"; done
touch -d '9 days ago' "$t/backups/bossman-2000-01-01-0000.sql.gz" "$t/backups/restore-test-1.sql.gz" "$t/backups/penpot-2000-01-01-0000.tar" "$t/backups/deploy-status.json"
"$here/daily-backup.sh" --once >/dev/null # newest is 5 days old: a new dump, then prune
[[ $(dumps) -eq 2 ]] || fail "no new dump when the newest was old"
[[ $(count) -eq 3 ]] || fail "retention kept $(count), want 3"
for k in bossman-2000-01-01-0000.sql.gz restore-test-1.sql.gz penpot-2000-01-01-0000.tar deploy-status.json; do [[ -e $t/backups/$k ]] || fail "deleted $k"; done
[[ -e $t/backups/daily-2000-01-01-0300.sql.gz ]] || fail "third newest daily deleted"
for d in 2 3 4; do [[ ! -e $t/backups/daily-2000-01-0${d}-0300.sql.gz ]] || fail "old daily $d kept"; done

# A failing dump saves nothing, keeps the old files, records the failure, exits non-zero.
rm -f "$t/backups/daily-$(date +%F)-"*.sql.gz # today's file would hide the failure (same-minute name)
for f2 in "$t"/backups/daily-*; do touch -d '3 days ago' "$f2"; done
before="$(find "$t/backups" -type f | sort)"
for mode in fail empty; do
  : >"$t/sql"
  if FAKE_DUMP=$mode "$here/daily-backup.sh" --once >/dev/null; then fail "dump $mode exited 0"; fi
  [[ "$(find "$t/backups" -type f | sort)" == "$before" ]] || fail "files changed after dump $mode"
  grep -q "daily_backup_failed" "$t/sql" || fail "failure not recorded for $mode"
  grep -q "daily_backup_last" "$t/sql" && fail "success row written after $mode"
done

# With the default keep count: 16 daily files (the newest one fresh) end as the newest 14, other files untouched.
rm -f "$t"/backups/daily-* "$t"/backups/bossman-* "$t"/backups/restore-test-* "$t"/backups/penpot-*
for d in $(seq 1 15); do touch -d "$((d + 1)) days ago" "$t/backups/daily-2001-01-$(printf %02d "$d")-0300.sql.gz"; done
touch -d '2 hours ago' "$t/backups/daily-2001-02-01-0300.sql.gz"
touch -d '9 days ago' "$t/backups/bossman-a.sql.gz" "$t/backups/rebuild-a.sql.gz" "$t/backups/restore-test-a.sql.gz" "$t/backups/penpot-a.tar"
BOSSMAN_BACKUP_KEEP=14 "$here/daily-backup.sh" --once >/dev/null
[[ $(count) -eq 14 ]] || fail "16 files should end as 14, got $(count)"
[[ -e $t/backups/daily-2001-02-01-0300.sql.gz && ! -e $t/backups/daily-2001-01-15-0300.sql.gz ]] || fail "wrong files pruned"
for k in bossman-a.sql.gz rebuild-a.sql.gz restore-test-a.sql.gz penpot-a.tar; do [[ -e $t/backups/$k ]] || fail "deleted $k"; done

# A failed dump says so in plain words on the way out.
rm -f "$t"/backups/daily-*
out="$(FAKE_DUMP=fail "$here/daily-backup.sh" --once 2>&1 || true)"
[[ $out == *"FAILED: The database dump failed"* ]] || fail "no plain failure message: $out"

# A status-row failure never loses the file.
rm -f "$t"/backups/daily-*
FAKE_PSQL=fail "$here/daily-backup.sh" --once >/dev/null
[[ $(count) -eq 1 ]] || fail "file lost when the status row failed"

echo "daily-backup.test.sh: ok"
