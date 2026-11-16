#!/usr/bin/env bash
# Tests setup-host-deployer.sh in a throwaway install folder (no root, no docker, no systemd).
# Run: scripts/setup-host-deployer.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
has() { grep -qF -- "$2" "$1" || fail "$1 lacks: $2 (has: $(cat "$1" 2>/dev/null))"; }
hasnt() { ! grep -qF -- "$2" "$1" 2>/dev/null || fail "$1 should not have: $2"; }
mode() { stat -c %a "$1"; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export INSTALL_DEPLOYER_TEST=1 BOSSMAN_ETC="$T/etc"
# A fake systemctl that records its calls; is-enabled/is-active answer from marker files.
mkdir -p "$T/etc/cron.d" "$T/etc/systemd/system"
cat >"$T/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$SC_LOG"
case "$1" in
  enable) touch "$SC_STATE" ;;
  is-enabled|is-active) [[ -e $SC_STATE ]]; exit $? ;;
esac
exit 0
STUB
chmod +x "$T/systemctl"
export BOSSMAN_SYSTEMCTL="$T/systemctl" SC_LOG="$T/sc.log" SC_STATE="$T/sc.state"

# A checkout at <install>/src with the real script, a stub deployer and an origin to read.
B="$T/boss-man"; mkdir -p "$B"
git init -q -b main "$B/src"
mkdir -p "$B/src/scripts"
cp "$here/setup-host-deployer.sh" "$here/install-deployer.sh" "$B/src/scripts/"
cat >"$B/src/scripts/host-deployer.sh" <<'STUB'
#!/usr/bin/env bash
# stub deployer v1
mkdir -p "$(dirname "$0")/outbox"; echo '{}' >"$(dirname "$0")/outbox/available.json"
STUB
chmod +x "$B/src/scripts/"*.sh
printf 'FOO=bar\nCOMPOSE_FILE=docker-compose.yml:deploy/truenas.yml\n' >"$B/src/.env"
echo '.env' >"$B/src/.gitignore"
git -C "$B/src" add -A; git -C "$B/src" commit -qm base
I="$B/src/scripts/setup-host-deployer.sh"; D="$B/deployer"
snap() { (cd "$B" && find . -path ./src/.git -prune -o -type f -printf '%p %s %m\n' -o -type d -printf '%p %m\n' | sort; cat src/.env; ls "$T/etc/cron.d" "$T/etc/systemd/system") | sha256sum; }

# --- dry run changes nothing ---
before="$(snap)"
"$I" --timer cron --dry-run >"$T/o" || fail "dry run exited non-zero: $(cat "$T/o")"
has "$T/o" "would change"
[[ $(snap) == "$before" ]] || fail "dry run changed files"
[[ ! -e $D ]] || fail "dry run made the deployer folder"

# --- first real run ---
"$I" --timer cron >"$T/o" || fail "first run failed: $(cat "$T/o")"
[[ $(mode "$D") == 755 && $(mode "$D/inbox") == 750 && $(mode "$D/outbox") == 755 && $(mode "$D/state") == 700 ]] || fail "folder modes"
[[ -f $D/host-deployer.sh && ! -L $D/host-deployer.sh && $(mode "$D/host-deployer.sh") == 750 ]] || fail "script copy"
cmp -s "$B/src/scripts/host-deployer.sh" "$D/host-deployer.sh" || fail "copy differs"
has "$B/src/.env" "COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml:deploy/truenas-deployer.yml"
has "$B/src/.env" "BOSSMAN_DEPLOYER=$D"
has "$B/src/.env" "FOO=bar"
ls "$B"/src/.env.bak-* >/dev/null || fail "no .env backup"
has "$T/etc/cron.d/boss-man-deployer" "* * * * * root $D/host-deployer.sh > /dev/null"
[[ $(mode "$T/etc/cron.d/boss-man-deployer") == 644 ]] || fail "cron file mode"
has "$T/o" "trial tick wrote outbox/available.json"
has "$T/o" "docker compose up -d server"

# --- second run: nothing changes ---
before="$(snap)"
"$I" --timer cron >"$T/o" || fail "second run failed: $(cat "$T/o")"
hasnt "$T/o" "changed "
has "$T/o" "Nothing to change"
[[ $(snap) == "$before" ]] || fail "second run changed files"
[[ $(grep -c '^COMPOSE_FILE=' "$B/src/.env") == 1 && $(grep -c deploy/truenas-deployer.yml "$B/src/.env") == 1 ]] || fail ".env got a duplicate"

# --- existing inbox content and host.conf survive a rerun ---
echo req >"$D/inbox/request.json"; echo 'WEBHOOK_URL=x' >"$D/host.conf"; chmod 600 "$D/host.conf"
"$I" --timer cron >/dev/null; has "$D/inbox/request.json" req; has "$D/host.conf" WEBHOOK_URL

# --- no COMPOSE_FILE line: the default is added ---
printf 'FOO=bar\n' >"$B/src/.env"
"$I" --timer cron --no-tick >/dev/null
has "$B/src/.env" "COMPOSE_FILE=docker-compose.yml:deploy/truenas-deployer.yml"
# --- quoted COMPOSE_FILE is refused, not mangled ---
printf 'COMPOSE_FILE="a.yml"\n' >"$B/src/.env"
if "$I" --timer cron --no-tick >"$T/o"; then fail "quoted COMPOSE_FILE should fail"; fi
has "$T/o" "quoted"; has "$B/src/.env" 'COMPOSE_FILE="a.yml"'
# --- --no-compose leaves .env alone ---
"$I" --timer cron --no-tick --no-compose >/dev/null; has "$B/src/.env" 'COMPOSE_FILE="a.yml"'

# --- a newer script in the checkout is refreshed through install-deployer.sh (BOS-1588) ---
printf 'FOO=bar\n' >"$B/src/.env"; "$I" --timer cron --no-tick >/dev/null
printf '#!/usr/bin/env bash\n# stub deployer v2\n' >"$B/src/scripts/host-deployer.sh"
git -C "$B/src" commit -qam v2
"$I" --timer cron --no-tick --no-compose --dry-run >"$T/o" || fail "dry refresh failed: $(cat "$T/o")"
has "$T/o" "would replace"; has "$D/host-deployer.sh" "v1"
"$I" --timer cron --no-tick --no-compose >"$T/o" || fail "refresh failed: $(cat "$T/o")"
has "$D/host-deployer.sh" "v2"; has "$D/host-deployer.sh.old" "v1"; has "$T/o" "is updated"
[[ $(mode "$D/host-deployer.sh") == 750 ]] || fail "refresh lost the mode"
"$I" --timer cron --no-tick --no-compose >"$T/o"; has "$T/o" "Nothing to change"
# an uncommitted edit is refused
echo "# edit" >>"$B/src/scripts/host-deployer.sh"
if "$I" --timer cron --no-tick --no-compose >"$T/o"; then fail "uncommitted script should be refused"; fi
has "$T/o" "uncommitted"; git -C "$B/src" checkout -q -- scripts/host-deployer.sh
# a link as the copy is refused
rm "$D/host-deployer.sh"; ln -s "$B/src/scripts/host-deployer.sh" "$D/host-deployer.sh"
if "$I" --timer cron --no-tick --no-compose >"$T/o"; then fail "a link copy should be refused"; fi
has "$T/o" "is a link"
rm "$D/host-deployer.sh"; "$I" --timer cron --no-tick --no-compose >/dev/null; [[ ! -L $D/host-deployer.sh ]] || fail "copy is still a link"

# --- systemd timer: units written once, enabled once, rerun quiet ---
rm -f "$T/etc/cron.d/boss-man-deployer"; : >"$SC_LOG"; rm -f "$SC_STATE"
"$I" --timer systemd --no-tick >/dev/null
has "$T/etc/systemd/system/boss-man-deployer.timer" "OnCalendar=minutely"
has "$T/etc/systemd/system/boss-man-deployer.service" "ExecStart=$D/host-deployer.sh"
has "$SC_LOG" "enable --now boss-man-deployer.timer"
: >"$SC_LOG"; "$I" --timer systemd --no-tick >"$T/o"
hasnt "$SC_LOG" "enable --now"; hasnt "$T/o" "changed "

# --- none prints what to do; a checkout that is not at <dir>/src is refused ---
"$I" --timer none --no-tick >"$T/o"; has "$T/o" "every minute"
mkdir -p "$T/other"; if "$I" --dir "$T/other" >/dev/null 2>&1; then fail "wrong --dir should be refused"; fi
echo "setup-host-deployer.test.sh: all passed"
