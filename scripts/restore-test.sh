#!/usr/bin/env bash
# Proves a backup restores: loads it into a THROWAWAY database next to the live one, counts what is in it,
# times it, then drops the throwaway. The live database ("bossman") is never written to, dropped or locked.
# Run it on the host from the repository, as root:  scripts/restore-test.sh   (docs: wiki "Database restore: proven procedure")
#
#   scripts/restore-test.sh                 test the newest bossman-*.sql.gz in the backup folder
#   scripts/restore-test.sh FILE.sql.gz     test this backup
#   scripts/restore-test.sh --keep          leave the throwaway database (bossman_restore_test) in place to look at
#   scripts/restore-test.sh --fresh-backup  take a new backup first (same command as deploy.sh), then test that one
#
# Settings: BOSSMAN_BACKUP_DIR (the install folder, the one holding this checkout).
# Extra disk: the throwaway is a full copy of the data inside the same Postgres volume; the script refuses to start unless
# the volume has at least twice the live database size free. It competes with the live app for disk I/O: run it at a quiet time.
set -euo pipefail

BACKUP_DIR="${BOSSMAN_BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
[[ -f docker-compose.yml ]] || { echo "ERROR: run this from the checkout (the folder with docker-compose.yml)." >&2; exit 1; }
TEST_DB=bossman_restore_test # fixed: the only database this script ever creates or drops
KEEP=0 FRESH=0 FILE=""
for a in "$@"; do
  case "$a" in
    --keep) KEEP=1 ;;
    --fresh-backup) FRESH=1 ;;
    -*) echo "Usage: $0 [--keep] [--fresh-backup] [FILE.sql.gz]" >&2; exit 2 ;;
    *) FILE="$a" ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
psql_db() { docker compose exec -T db psql -v ON_ERROR_STOP=1 -U bossman -d "$1" -tA "${@:2}"; }

if ((FRESH)); then
  # Named outside bossman-*.sql.gz on purpose: deploy backups are pruned to the newest 14 by that name, and a test must not push one out.
  FILE="$BACKUP_DIR/restore-test-$(date +%F-%H%M%S).sql.gz"
  docker compose exec -T db pg_dump -U bossman bossman | gzip >"$FILE.partial" || { rm -f "$FILE.partial"; die "The backup failed."; }
  mv "$FILE.partial" "$FILE"
fi
if [[ -z $FILE ]]; then
  FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'bossman-*.sql.gz' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
  [[ -n $FILE ]] || die "No bossman-*.sql.gz in $BACKUP_DIR."
fi
[[ -s $FILE ]] && gzip -t "$FILE" || die "$FILE is empty or damaged."
age=$(($(date +%s) - $(stat -c %Y "$FILE")))
say "Backup:      $FILE ($(du -h "$FILE" | cut -f1), taken $((age / 60)) minutes ago)"

TABLES=(owners companies sessions projects tickets ticket_messages wiki_pages agents runs)
count() { psql_db "$1" -c "SELECT count(*) FROM $2" 2>/dev/null || echo "missing"; }

cleanup() { if ((!KEEP)); then psql_db postgres -c "DROP DATABASE IF EXISTS $TEST_DB" >/dev/null 2>&1 || say "Could not drop $TEST_DB; drop it by hand (see the wiki)."; fi; }
trap cleanup EXIT

# The throwaway is a full copy inside the live Postgres volume: refuse unless there is room for at least twice the live size.
live_bytes="$(psql_db bossman -c "SELECT pg_database_size('bossman')")"
free_bytes="$(docker compose exec -T db df -Pk /var/lib/postgresql/data | awk 'NR==2 { print $4 * 1024 }')"
[[ $live_bytes =~ ^[0-9]+$ && $free_bytes =~ ^[0-9]+$ ]] || die "Could not read the database size or the free disk space; nothing was changed."
((free_bytes >= 2 * live_bytes)) || die "Not enough free disk space on the database volume: $((free_bytes / 1048576)) MB free, need at least $((2 * live_bytes / 1048576)) MB (twice the live database). Nothing was changed."
psql_db postgres -c "DROP DATABASE IF EXISTS $TEST_DB" -c "CREATE DATABASE $TEST_DB OWNER bossman" >/dev/null
start=$SECONDS
gunzip -c "$FILE" | docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U bossman -d "$TEST_DB" >/dev/null || die "The restore FAILED. The live database was not touched."
took=$((SECONDS - start))
say "Restore:     finished in ${took}s into the throwaway database $TEST_DB (live database untouched)"
say "Size:        $(psql_db "$TEST_DB" -c "SELECT pg_size_pretty(pg_database_size('$TEST_DB'))") restored; live is $(psql_db bossman -c "SELECT pg_size_pretty(pg_database_size('bossman'))")"

say ""
say "Rows         restored   live now   (live minus restored = written since the backup = lost if you restored it)"
bad=0
for t in "${TABLES[@]}"; do
  r="$(count "$TEST_DB" "$t")" l="$(count bossman "$t")"
  if [[ $r == missing || $l == missing ]]; then say "  $t: missing in one side (restored=$r live=$l)"; continue; fi
  printf '  %-16s %8s %10s   %s\n' "$t" "$r" "$l" "$((l - r))"
done
[[ $(count "$TEST_DB" owners) != 0 && $(count "$TEST_DB" owners) != missing ]] || { say "FAIL: no owner account in the restored data"; bad=1; }
[[ $(count "$TEST_DB" tickets) != 0 && $(count "$TEST_DB" tickets) != missing ]] || { say "FAIL: no tickets in the restored data"; bad=1; }
# A ticket must still point at a real project (the data is joined up, not just present).
orphans="$(psql_db "$TEST_DB" -c "SELECT count(*) FROM tickets t LEFT JOIN projects p ON p.id = t.project_id WHERE p.id IS NULL" 2>/dev/null || echo error)"
[[ $orphans == 0 ]] || { say "FAIL: tickets without a project: $orphans"; bad=1; }
say "Migrations:  restored $(psql_db "$TEST_DB" -c 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null || echo '?'), live $(psql_db bossman -c 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null || echo '?')"
if ((KEEP)); then say "Left in place: database $TEST_DB. Drop it with: docker compose exec -T db psql -U bossman -d postgres -c 'DROP DATABASE $TEST_DB'"; fi
if ((bad)); then die "The backup restored but the data does not look right (see FAIL above)."; fi
say "OK: the backup restores, has accounts, projects and tickets, and took ${took}s."
