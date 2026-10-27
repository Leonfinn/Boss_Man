#!/usr/bin/env bash
# Checks restore-test.sh with a fake docker: it only ever creates, writes to and drops bossman_restore_test.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir "$t/bin" "$t/backups"
fail() { echo "FAIL: $*"; exit 1; }
cat >"$t/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
[[ $1 == compose && $2 == exec ]] || exit 99
case "$*" in
  *"df -Pk"*) printf "Filesystem 1024-blocks Used Available Capacity Mounted\nx 100 1 ${FAKE_FREE_KB:-1000000} 1%% /\n" ;;
  *"SELECT pg_database_size"*) echo "${FAKE_LIVE_BYTES:-1000000}" ;;
  *"LEFT JOIN"*) echo "${FAKE_ORPHANS:-0}" ;;
  *"-c SELECT count"*) case "$*" in *"-d bossman_restore_test"*) echo "${FAKE_RESTORED:-3}" ;; *) echo 5 ;; esac ;;
  *"__drizzle_migrations"*) echo 48 ;;
  *"pg_size_pretty"*) echo 10MB ;;
  *"-d bossman_restore_test"*) cat >/dev/null ;;   # the restore stream
  *) ;;
esac
FAKE
chmod +x "$t/bin/docker"
touch "$t/docker-compose.yml"; cd "$t"
export PATH="$t/bin:$PATH" FAKE_LOG="$t/log" BOSSMAN_BACKUP_DIR="$t/backups"
echo "select 1;" | gzip >"$t/backups/bossman-2026-01-01-0000.sql.gz"

"$here/restore-test.sh" >"$t/out"
grep -q "^OK:" "$t/out" || fail "no OK: $(cat "$t/out")"
grep -q "DROP DATABASE IF EXISTS bossman_restore_test" "$t/log" || fail "throwaway not dropped"
! grep -E "DROP DATABASE( IF EXISTS)? bossman([^_]|$)" "$t/log" || fail "touched the live database"
! grep -E "psql.* -d bossman( |$)" "$t/log" | grep -v -e "count" -e pg_size -e pg_database_size -e drizzle >/dev/null || fail "wrote to the live database"

# Too little free disk: refused before anything is created.
: >"$t/log"
if FAKE_FREE_KB=1000 "$here/restore-test.sh" >"$t/out" 2>&1; then fail "ran with too little disk"; fi
grep -q "Not enough free disk" "$t/out" || fail "no disk message"
! grep -q "CREATE DATABASE" "$t/log" || fail "created a database without room"

# A broken backup is refused before anything is created.
: >"$t/log"; echo junk >"$t/backups/bossman-2026-01-02-0000.sql.gz"
if "$here/restore-test.sh" >"$t/out" 2>&1; then fail "a damaged backup passed"; fi
! grep -q "CREATE DATABASE" "$t/log" || fail "created a database for a damaged backup"

# Empty restored data fails the check, and the throwaway is still dropped.
rm "$t/backups/bossman-2026-01-02-0000.sql.gz"; : >"$t/log"
if FAKE_RESTORED=0 "$here/restore-test.sh" >"$t/out" 2>&1; then fail "empty data passed"; fi
grep -q "FAIL: no tickets" "$t/out" || fail "no failure message"
grep -q "DROP DATABASE IF EXISTS bossman_restore_test" "$t/log" || fail "throwaway left behind"
echo "restore-test.test.sh: ok"
