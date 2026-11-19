#!/usr/bin/env bash
# Scripted smoke checks for the staging stack (BOS-1472, docs/22-staging.md "Smoke checklist"). Run on the host by the
# host deployer after a staging deploy, or by hand:
#
#   scripts/smoke-staging.sh <staging folder> <commit>
#
# It prints one tab-separated line per check:  name<TAB>pass|fail|skipped<TAB>one line of why
# and exits 0 when nothing failed (skipped is not a failure), 1 when a check failed, 2 on bad usage.
#
# The address comes from the staging folder's own .env (BOSSMAN_BIND, BOSSMAN_HOST_PORT); nothing is assumed.
# Sign-in checks use an optional smoke account: SMOKE_CREDENTIALS names a root-only file with two lines,
# smoke_username=<name> and smoke_password=<password>. The values are only ever sent to staging's own address and
# never printed. Without the file those checks are "skipped: not set up", never a failure.
# Other environment: SMOKE_TIMEOUT (seconds per request, default 10), SMOKE_WAIT (seconds to wait for the address, default 60),
# SMOKE_PRODUCTION_PROJECT (compose project whose containers must not change, default boss-man).
set -uo pipefail

TIMEOUT="${SMOKE_TIMEOUT:-10}"
WAIT="${SMOKE_WAIT:-60}"
[[ $TIMEOUT =~ ^[0-9]{1,3}$ && $WAIT =~ ^[0-9]{1,4}$ ]] || { echo "ERROR: SMOKE_TIMEOUT and SMOKE_WAIT must be whole numbers." >&2; exit 2; }
DIR="${1:-}" COMMIT="${2:-}"
[[ -d $DIR && $COMMIT =~ ^[0-9a-f]{40}$ ]] || { echo "Usage: $0 <staging folder> <40-character commit>" >&2; exit 2; }
FAILS=0

env_get() { # key: the last KEY=value in the staging .env, quotes and trailing comment dropped
  local line v
  [[ -f $DIR/.env ]] || return 0
  line="$({ grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$DIR/.env" || true; } | tail -n 1)"
  [[ -n $line ]] || return 0
  v="${line#*=}"; v="${v#"${v%%[![:space:]]*}"}"
  if [[ $v == \"* ]]; then v="${v#\"}"; v="${v%%\"*}"
  elif [[ $v == \'* ]]; then v="${v#\'}"; v="${v%%\'*}"
  else v="${v%%[[:space:]]#*}"; v="${v%"${v##*[![:space:]]}"}"; fi
  printf '%s\n' "$v"
}
report() { # name result why: one line; tabs and newlines in why are dropped
  local why="${3//[$'\t\r\n']/ }"
  printf '%s\t%s\t%s\n' "$1" "$2" "${why:0:200}"
  [[ $2 != fail ]] || FAILS=$((FAILS + 1))
}
field() { # name: a simple string or number field from JSON on stdin
  LC_ALL=C tr -d '\n\r' | LC_ALL=C grep -oE "\"$1\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|true|false|-?[0-9]+)" | head -n 1 | sed -E 's/^[^:]*:[[:space:]]*"?//; s/"$//'
}

BIND="$(env_get BOSSMAN_BIND)"; PORT="$(env_get BOSSMAN_HOST_PORT)"
case ${BIND:-} in "" | 0.0.0.0) BIND=127.0.0.1 ;; esac
[[ ${PORT:-} =~ ^[0-9]{2,5}$ ]] || { report address fail "BOSSMAN_HOST_PORT is not set in the staging .env."; exit 1; }
BASE="http://$BIND:$PORT"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
api() { curl -sS --max-time "$TIMEOUT" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' "$@"; }

# Production containers before: the same list is compared at the end (check 7). Nothing here starts or stops anything.
PROD_PROJECT="${SMOKE_PRODUCTION_PROJECT:-boss-man}"
prod_ids() { docker ps -q --filter "label=com.docker.compose.project=$PROD_PROJECT" 2>/dev/null | sort | paste -sd, - ; }
HAVE_DOCKER=0; command -v docker >/dev/null 2>&1 && HAVE_DOCKER=1
# The host deployer takes the list before it starts the deploy and passes it in SMOKE_PRODUCTION_BEFORE, so a change made by the deploy itself is caught.
BEFORE=""
if [[ -n ${SMOKE_PRODUCTION_BEFORE+x} ]]; then BEFORE="$SMOKE_PRODUCTION_BEFORE"; elif ((HAVE_DOCKER)); then BEFORE="$(prod_ids)"; fi

# 1. The address answers (the server may still be settling right after a deploy, so wait a little).
health="" end=$((SECONDS + WAIT))
while :; do
  health="$(curl -fsS --max-time "$TIMEOUT" "$BASE/api/health" 2>/dev/null)" && [[ $(field ok <<<"$health") == true ]] && break
  health=""; ((SECONDS < end)) || break; sleep 1
done
if [[ -n $health ]]; then report address pass "staging answers at its own address"; else report address fail "no answer from /api/health within ${WAIT}s"; fi

# 6. The version shown is the commit that was deployed. A server built without a commit says "dev".
got="$(field commit <<<"$health")"
if [[ -z $health ]]; then report version skipped "the address did not answer"
elif [[ $got == "$COMMIT" ]]; then report version pass "running ${COMMIT:0:8}"
elif [[ -z $got || $got == dev ]]; then report version skipped "this build does not report its commit"
else report version fail "running ${got:0:8}, deployed ${COMMIT:0:8}"; fi

# 3. The board page loads: the built web app, not an error page.
if [[ -z $health ]]; then report board skipped "the address did not answer"
else
  page="$(curl -sS --max-time "$TIMEOUT" -o - -w '\n%{http_code}' "$BASE/" 2>/dev/null)"
  code="${page##*$'\n'}"
  if [[ $code == 200 && $page == *"<html"* ]]; then report board pass "the web page loads"; else report board fail "GET / gave HTTP ${code:-none}"; fi
fi

# 2, 4, 5. Sign-in, a ticket and the runner, with the smoke account.
CRED="${SMOKE_CREDENTIALS:-}" user="" pass=""
if [[ -n $CRED && -f $CRED && ! -L $CRED ]]; then
  user="$(grep -E '^smoke_username=' "$CRED" | head -n 1 | cut -d= -f2-)"; pass="$(grep -E '^smoke_password=' "$CRED" | head -n 1 | cut -d= -f2-)"
fi
if [[ -z $health ]]; then
  report signin skipped "the address did not answer"; report ticket skipped "the address did not answer"; report runner skipped "the address did not answer"
elif [[ -z $user || -z $pass ]]; then
  report signin skipped "not set up: no smoke account file"; report ticket skipped "not set up: no smoke account file"; report runner skipped "not set up: no smoke account file"
else
  # JSON-escape backslash and quote (a bare one made invalid JSON or a wrong password); drop a CR left by a Windows-edited file.
  user="${user%$'\r'}"; pass="${pass%$'\r'}"
  user="${user//\\/\\\\}"; user="${user//\"/\\\"}"; pass="${pass//\\/\\\\}"; pass="${pass//\"/\\\"}"
  body="$(printf '{"username":"%s","password":"%s"}' "$user" "$pass")"
  code="$(printf '%s' "$body" | api -o /dev/null -w '%{http_code}' --data-binary @- "$BASE/api/login" 2>/dev/null)"
  if [[ $code == 200 ]]; then
    report signin pass "the smoke account signs in"
    companies="$(api "$BASE/api/companies" 2>/dev/null)"
    pid="$(grep -oE '"projects":\[\{"id":"[0-9a-f-]{36}"' <<<"$companies" | head -n 1 | grep -oE '[0-9a-f-]{36}')"
    cid="$(grep -oE '"projects":\[\{"id":"[0-9a-f-]{36}","companyId":"[0-9a-f-]{36}"' <<<"$companies" | head -n 1 | grep -oE '[0-9a-f-]{36}"$' | tr -d '"')"
    if [[ -z $pid ]]; then
      report ticket skipped "no staging company with a project yet"
    else
      made="$(printf '{"title":"Smoke check %s"}' "${COMMIT:0:8}" | api --data-binary @- "$BASE/api/projects/$pid/tickets" 2>/dev/null)"
      tid="$(field id <<<"$made")"
      if [[ $tid =~ ^[0-9a-f-]{36}$ ]]; then
        # Tidy up after itself: the owner may move a ticket to done by hand.
        if printf '{"state":"done"}' | api -o /dev/null --data-binary @- "$BASE/api/tickets/$tid/state" 2>/dev/null; then report ticket pass "created a ticket and closed it"; else report ticket pass "created a ticket (could not close it)"; fi
      else report ticket fail "the ticket was not created"; fi
    fi
    if [[ $cid =~ ^[0-9a-f-]{36}$ ]]; then
      rr="$(api "$BASE/api/companies/$cid/runner" 2>/dev/null)"
      img="$(field imageVersion <<<"$rr")"
      if [[ $(field connected <<<"$rr") == true ]]; then report runner pass "runner connected${img:+, image $img}"; else report runner fail "the staging runner is not connected"; fi
    else
      report runner skipped "no staging company yet"
    fi
  else
    report signin fail "the smoke account could not sign in (HTTP ${code:-none})"; report ticket skipped "not signed in"; report runner skipped "not signed in"
  fi
fi

# A real agent run costs model tokens and needs an agent set up on staging: left to a person or a ticket's own check.
report agent_run skipped "not scripted: it costs model tokens; check by hand (docs/22-staging.md)"

# 7. Production untouched: the same containers are running as before the checks.
if ((!HAVE_DOCKER)); then report production skipped "no docker on this host"
else
  AFTER="$(prod_ids)"
  if [[ -z $BEFORE && -z $AFTER ]]; then report production skipped "no production containers found under project $PROD_PROJECT"
  elif [[ $BEFORE == "$AFTER" ]]; then report production pass "production's containers are unchanged"
  else report production fail "production's containers changed while staging was deployed"; fi
fi

((FAILS == 0))
