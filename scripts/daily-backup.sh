#!/usr/bin/env bash
# Daily backup of Boss Man's database (BOS-2176). It runs inside the `backup` service of
# docker-compose.yml (the database's own image, so pg_dump always matches the server version) and needs
# nobody to start it. Each pass is safe to repeat: it dumps only when the newest daily-*.sql.gz is older
# than 24 hours.
#
#   daily-backup.sh          check once an hour, forever (what the service runs)
#   daily-backup.sh --once   one pass, then exit (tests, or a hand run: docker compose exec backup ...)
#
# Settings (environment; the service sets them):
#   BOSSMAN_BACKUP_DIR       where backups go, as the container sees it  (/backups)
#   BOSSMAN_BACKUP_KEEP      how many daily backups to keep               (14)
#   BOSSMAN_DAILY_MAX_HOURS  a daily backup newer than this is enough    (24)
#   BOSSMAN_DAILY_SLEEP      seconds between checks in the loop           (3600)
#   PGHOST PGUSER PGPASSWORD PGDATABASE  the usual libpq settings for the database
#
# Files: daily-YYYY-MM-DD-HHMM.sql.gz, owner-only. Only daily-*.sql.gz is ever deleted; the update
# backups (bossman-*), restore-test-*, penpot-* and everything else in the folder are never touched.
# After each pass the result is written to the settings table (keys daily_backup_last and
# daily_backup_failed) so Settings → Server can show it.
set -uo pipefail
umask 077 # the file holds the whole database

BACKUP_DIR="${BOSSMAN_BACKUP_DIR:-/backups}"
KEEP="${BOSSMAN_BACKUP_KEEP:-14}"
MAX_HOURS="${BOSSMAN_DAILY_MAX_HOURS:-24}"
SLEEP="${BOSSMAN_DAILY_SLEEP:-3600}"

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Write one settings row. $2 is JSON built only from values this script makes (a date, a file name, a number).
put_setting() { # key json
  psql -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO settings (key, value) VALUES ('$1', '$2'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null 2>&1
}
drop_setting() { psql -X -q -v ON_ERROR_STOP=1 -c "DELETE FROM settings WHERE key = '$1'" >/dev/null 2>&1; }

newest() { find "$BACKUP_DIR" -maxdepth 1 -type f -name 'daily-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-; }

record_ok() { # file
  local f="$1" at bytes
  at="$(date -u -d "@$(stat -c %Y "$f")" +%FT%TZ)"
  bytes="$(stat -c %s "$f")"
  put_setting daily_backup_last "{\"at\":\"$at\",\"file\":\"$(basename "$f")\",\"bytes\":$bytes}" && drop_setting daily_backup_failed
}

record_failed() { # short plain-words reason (no quotes)
  say "FAILED: $1"
  put_setting daily_backup_failed "{\"at\":\"$(date -u +%FT%TZ)\",\"message\":\"$1\"}" || true
}

prune() {
  local old f
  old="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'daily-*.sql.gz' -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2-)"
  [[ -z $old ]] || { say "Removing daily backups older than the newest $KEEP"; while IFS= read -r f; do say "  $f"; rm -f -- "$f"; done <<<"$old"; }
}

dump_to() { (set -o pipefail; pg_dump | gzip >"$1") 2>/dev/null; }

pass() {
  local cur out
  mkdir -p "$BACKUP_DIR" || { record_failed "The backup folder cannot be created"; return 1; }
  cur="$(newest)"
  if [[ -n $cur && -z $(find "$cur" -mmin "-$((MAX_HOURS * 60))" 2>/dev/null) ]]; then cur=""; fi
  if [[ -n $cur ]]; then record_ok "$cur" || true; prune; return 0; fi # recent enough: keep the status line right, and the count

  out="$BACKUP_DIR/daily-$(date +%F-%H%M).sql.gz"
  [[ ! -s $out ]] || { record_ok "$out" || true; return 0; }
  rm -f -- "$out.partial"
  if ! dump_to "$out.partial"; then
    rm -f -- "$out.partial"; record_failed "The database dump failed"; return 1
  fi
  # An empty dump still gzips to about 20 bytes, so the size of the file proves nothing: look at what is inside.
  if ! { gzip -t "$out.partial" 2>/dev/null && [[ $(gzip -dc "$out.partial" 2>/dev/null | head -c 1 | wc -c) -gt 0 ]]; }; then
    rm -f -- "$out.partial"; record_failed "The database dump was empty or damaged"; return 1
  fi
  if ! { chmod 600 "$out.partial" && mv -- "$out.partial" "$out"; }; then rm -f -- "$out.partial"; record_failed "The backup could not be saved"; return 1; fi
  say "Daily backup saved: $out ($(stat -c %s "$out") bytes)"
  record_ok "$out" || say "Saved, but the status line could not be updated"
  prune
}

main() {
  if [[ ${1:-} == --once ]]; then pass; return $?; fi
  say "Daily backup service started (keeps $KEEP, folder $BACKUP_DIR)"
  while :; do
    pass || true
    sleep "$SLEEP"
  done
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
