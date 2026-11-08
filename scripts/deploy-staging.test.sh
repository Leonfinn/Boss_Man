#!/usr/bin/env bash
# Checks deploy-staging.sh against throwaway folders and a fake docker: the isolation guard, deploy, repeat and rollback.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

# A "production" install and a "staging" install side by side, the staging one a real git checkout.
mkdir -p "$t/prod/secrets" "$t/bin"
printf 'POSTGRES_PASSWORD=prodpw\nBOSSMAN_DATA=/srv/prod\n' >"$t/prod/.env"; echo k1 >"$t/prod/secrets/master.key"; touch "$t/prod/docker-compose.yml"
git init -q "$t/origin"; git -C "$t/origin" config user.email t@t; git -C "$t/origin" config user.name t
mkdir -p "$t/origin/scripts" "$t/origin/deploy"; cp "$here/deploy-staging.sh" "$here/deploy.sh" "$here/update-runner.sh" "$t/origin/scripts/"; touch "$t/origin/docker-compose.yml" "$t/origin/deploy/staging.yml"
git -C "$t/origin" add -A; git -C "$t/origin" commit -qm one; one="$(git -C "$t/origin" rev-parse HEAD)"
echo 2 >"$t/origin/f"; git -C "$t/origin" add -A; git -C "$t/origin" commit -qm two; two="$(git -C "$t/origin" rev-parse HEAD)"
git clone -q "$t/origin" "$t/staging" 2>/dev/null; git -C "$t/staging" checkout -q "$one"
mkdir -p "$t/staging/secrets"; echo k2 >"$t/staging/secrets/master.key"
good() { printf 'POSTGRES_PASSWORD=stagingpw\nBOSSMAN_HOST_PORT=3200\nBOSSMAN_PORTAL_HOST_PORT=3201\nBOSSMAN_DATA=/srv/stg\nCOMPOSE_PROFILES=launcher\nCOMPOSE_PROJECT_NAME=boss-man-staging\nCOMPOSE_FILE=docker-compose.yml:deploy/staging.yml\n' >"$t/staging/.env"; }
cat >"$t/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
case "$*" in
  *"ps -q"*) echo cid ;; "inspect -f"*) cat "$FAKE_HEALTH" ;; "image inspect"*) exit 0 ;;
esac
FAKE
chmod +x "$t/bin/docker"
export FAKE_LOG="$t/docker.log" FAKE_HEALTH="$t/health" BOSSMAN_HEALTH_TIMEOUT=2 PATH="$t/bin:$PATH"; echo healthy >"$t/health"
s="$t/staging/scripts/deploy-staging.sh"
expect_refuse() { # message-fragment
  if out="$("$s" --check 2>&1)"; then fail "should have refused: $1"; fi
  [[ $out == *"$1"* ]] || fail "refusal did not mention '$1': $out"
}

good; "$s" --check >/dev/null || fail "good .env was refused"
good; echo 'COMPOSE_PROJECT_NAME=boss-man' >>"$t/staging/.env"; expect_refuse "production project"
good; sed -i 's/3200/3100/' "$t/staging/.env"; expect_refuse "BOSSMAN_HOST_PORT"
good; sed -i 's#/srv/stg#/srv/prod#' "$t/staging/.env"; expect_refuse "BOSSMAN_DATA is the same"
good; sed -i 's/stagingpw/prodpw/' "$t/staging/.env"; expect_refuse "POSTGRES_PASSWORD is the same"
good; echo k1 >"$t/staging/secrets/master.key"; expect_refuse "master.key is identical"; echo k2 >"$t/staging/secrets/master.key"
good; sed -i '/BOSSMAN_DATA/d' "$t/staging/.env"; expect_refuse "BOSSMAN_DATA"
good; sed -i '/^COMPOSE_FILE/d' "$t/staging/.env"; expect_refuse "COMPOSE_FILE"

# deploy.sh and update-runner.sh are production's: in a staging folder they refuse before touching docker.
good; : >"$FAKE_LOG"
for sc in deploy.sh update-runner.sh; do
  if out="$(cd "$t/staging" && "scripts/$sc" 2>&1)"; then fail "$sc ran in a staging folder"; fi
  [[ $out == *"not the production install"* ]] || fail "$sc refusal: $out"
done
[[ ! -s $FAKE_LOG ]] || fail "docker was called by a refused script: $(cat "$FAKE_LOG")"

good; : >"$FAKE_LOG"
"$s" --dry-run "$two" >"$t/dry.out"
grep -q '^\[dry-run\] .*docker\|\[dry-run\] dc\|\[dry-run\]' "$t/dry.out" || fail "dry run printed nothing"
[[ $(git -C "$t/staging" rev-parse HEAD) == "$one" ]] || fail "dry run moved the checkout"
! grep -q 'compose' "$FAKE_LOG" || fail "dry run called docker compose"

: >"$FAKE_LOG"
"$s" "$two" >/dev/null || fail "deploy failed"
[[ $(git -C "$t/staging" rev-parse HEAD) == "$two" ]] || fail "did not land on the requested commit"
grep -q -- "-p boss-man-staging -f docker-compose.yml -f deploy/staging.yml build server launcher netguard" "$FAKE_LOG" || fail "build command: $(cat "$FAKE_LOG")"
grep -q -- "-p boss-man-staging .* up -d server launcher" "$FAKE_LOG" || fail "up command"
! grep -q -- "-p boss-man " "$FAKE_LOG" || fail "touched the production project"
"$s" "$two" >/dev/null || fail "second deploy of the same commit failed"
[[ $(git -C "$t/staging" rev-parse HEAD) == "$two" ]] || fail "repeat moved the checkout"

"$s" --rollback >/dev/null || fail "rollback failed"
[[ $(git -C "$t/staging" rev-parse HEAD) == "$one" ]] || fail "rollback did not return to the previous commit"

# A branch name means the remote's branch, not a stale local one; a failed deploy is never a rollback target.
echo 3 >"$t/origin/f"; git -C "$t/origin" add -A; git -C "$t/origin" commit -qm three; three="$(git -C "$t/origin" rev-parse HEAD)"
echo 4 >"$t/origin/f"; git -C "$t/origin" add -A; git -C "$t/origin" commit -qm four; four="$(git -C "$t/origin" rev-parse HEAD)"
branch="$(git -C "$t/origin" rev-parse --abbrev-ref HEAD)"
"$s" "$branch" >/dev/null || fail "deploy of branch failed"
[[ $(git -C "$t/staging" rev-parse HEAD) == "$four" ]] || fail "branch name deployed a stale local branch"
echo unhealthy >"$t/health"
if "$s" "$three" >/dev/null 2>&1; then fail "unhealthy deploy reported success"; fi
echo healthy >"$t/health"
"$s" "$two" >/dev/null || fail "deploy after a failed one"
"$s" --rollback >/dev/null || fail "rollback 2"
[[ $(git -C "$t/staging" rev-parse HEAD) == "$four" ]] || fail "rollback landed on $(git -C "$t/staging" rev-parse HEAD), not the last healthy commit"
echo "deploy-staging.test.sh: ok"
