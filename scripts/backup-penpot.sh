#!/usr/bin/env bash
# Back up the optional Penpot add-on: its Postgres database and its asset volume, in one dated
# archive next to Boss Man's backups. Safe to run twice; does nothing when Penpot isn't running.
# Run it as root from the host, e.g.  scripts/backup-penpot.sh   (restore steps: docs/15-penpot.md)
#
# Settings (the same as scripts/deploy.sh):
#   BOSSMAN_BACKUP_DIR   where backups go          (the install folder: the one holding this checkout)
#   BOSSMAN_BACKUP_KEEP  how many backups to keep  (14)
#   PENPOT_PROJECT       Compose project name      (boss-man-penpot)
#
# The archive penpot-YYYY-MM-DD-HHMM.tar holds penpot-db.sql.gz and penpot-assets.tar.gz.
# The database is dumped first and the assets second; assets are only ever added, so the
# archive holds every file the dump refers to. Not included: .env (PENPOT_SECRET_KEY and
# PENPOT_DB_PASSWORD); keep your own copy of it, it is needed to run the restored data.
set -euo pipefail

work=""
BACKUP_DIR="${BOSSMAN_BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
KEEP="${BOSSMAN_BACKUP_KEEP:-14}"
PROJECT="${PENPOT_PROJECT:-boss-man-penpot}"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Id of the running container of a Penpot service, empty when it isn't running.
# Labels, not `compose ps`, so no .env is needed to read the Compose file.
container_of() { # service
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -n1
}

# Only files named penpot-*.tar in the backup folder are ever deleted.
prune() {
  local old f
  old="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'penpot-*.tar' -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2-)"
  [[ -z $old ]] || { say "Removing Penpot backups older than the newest $KEEP:"; while IFS= read -r f; do say "  $f"; rm -f -- "$f"; done <<<"$old"; }
}

main() {
  local pg out img vol
  pg="$(container_of penpot-postgres)"
  if [[ -z $pg ]]; then say "Penpot isn't running (project $PROJECT); nothing to back up."; return 0; fi

  mkdir -p "$BACKUP_DIR"
  out="$BACKUP_DIR/penpot-$(date +%F-%H%M).tar"
  if [[ -s $out ]]; then say "Already backed up this minute: $out"; return 0; fi

  work="$(mktemp -d "$BACKUP_DIR/.penpot-backup.XXXXXX")"
  trap '[[ -z $work ]] || rm -rf "$work"' EXIT

  docker exec -T "$pg" pg_dump -U penpot penpot | gzip >"$work/penpot-db.sql.gz" || die "The database dump failed. Nothing was saved."
  { [[ -s $work/penpot-db.sql.gz ]] && gzip -t "$work/penpot-db.sql.gz"; } || die "The database dump is empty or damaged. Nothing was saved."

  # Read the assets through a throwaway container of the image Postgres already runs (it has
  # tar and is already pulled, so no download). The volume is mounted read-only.
  vol="${PROJECT}_penpot_assets"
  docker volume inspect "$vol" >/dev/null 2>&1 || die "The asset volume $vol doesn't exist. Nothing was saved."
  img="$(docker inspect -f '{{.Config.Image}}' "$pg")"
  docker run --rm -v "$vol:/assets:ro" --entrypoint tar "$img" -C /assets -czf - . >"$work/penpot-assets.tar.gz" || die "The asset copy failed. Nothing was saved."
  gzip -t "$work/penpot-assets.tar.gz" || die "The asset copy is damaged. Nothing was saved."

  tar -C "$work" -cf "$out.partial" penpot-db.sql.gz penpot-assets.tar.gz || { rm -f "$out.partial"; die "Could not write the archive. Nothing was saved."; }
  mv "$out.partial" "$out"
  say "Penpot backup saved: $out ($(du -h "$out" | cut -f1))"
  prune
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
