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
# With no company on staging, the check makes a staging-only company and project (BOS-2405); SMOKE_RUNNER_WAIT (seconds, default 120) is how long it waits for that company's runner to connect.
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
SMOKE_COMPANY="Staging smoke check company" SMOKE_PROJECT="Staging smoke check project"
RUNNER_WAIT="${SMOKE_RUNNER_WAIT:-120}"
[[ $RUNNER_WAIT =~ ^[0-9]{1,4}$ ]] || { echo "ERROR: SMOKE_RUNNER_WAIT must be a whole number." >&2; exit 2; }
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
  # A fresh staging (new host, or its data removed with down -v) has no owner at all, so the smoke account can't exist yet.
  # Boss Man's first-run setup (POST /api/setup) creates the one owner and refuses with 409 once an owner exists, so it can
  # never change an account that is already there. Staging holds no real data; the smoke account becomes its owner.
  created=""; needs=""; scode=""
  if [[ $(api "$BASE/api/setup" 2>/dev/null | field needsSetup) == true ]]; then
    needs=1
    # Boss Man refuses a password under 12 characters (and a name over 64), so setup fails with 400 and no owner is made.
    scode="$(printf '%s' "$body" | api -o /dev/null -w '%{http_code}' --data-binary @- "$BASE/api/setup" 2>/dev/null)"
    [[ $scode == 201 ]] && created=1
  fi
  code="$(printf '%s' "$body" | api -o /dev/null -w '%{http_code}' --data-binary @- "$BASE/api/login" 2>/dev/null)"
  if [[ $code == 200 ]]; then
    report signin pass "the smoke account signs in${created:+ (staging had no owner, so the smoke account was created as its first owner)}"
    companies="$(api "$BASE/api/companies" 2>/dev/null)"
    pid="$(grep -oE '"projects":\[\{"id":"[0-9a-f-]{36}"' <<<"$companies" | head -n 1 | grep -oE '[0-9a-f-]{36}')"
    cid="$(grep -oE '"projects":\[\{"id":"[0-9a-f-]{36}","companyId":"[0-9a-f-]{36}"' <<<"$companies" | head -n 1 | grep -oE '[0-9a-f-]{36}"$' | tr -d '"')"
    # Staging has no company (a new host, or its data was reset): make a staging-only company and project, once.
    # No repo link, no secrets, no integrations. An earlier run's company is found by its name and reused, never duplicated.
    made_company="" setup_fail="" relaunch=""
    if [[ -z $pid ]]; then
      if [[ -z $cid ]]; then
        # The company list puts a company's own id before its name, so this finds the smoke company even without a project.
        cid="$(grep -oE "\"id\":\"[0-9a-f-]{36}\"[^{}]*\"name\":\"$SMOKE_COMPANY\"" <<<"$companies" | head -n 1 | grep -oE '^"id":"[0-9a-f-]{36}"' | grep -oE '[0-9a-f-]{36}')"
        if [[ -z $cid ]]; then
          if [[ $companies == *"\"name\":\"$SMOKE_COMPANY\""* ]]; then setup_fail="a company named \"$SMOKE_COMPANY\" exists but its id could not be read"
          else
            mc="$(printf '{"name":"%s","mission":"Made by the staging smoke check. Safe to delete."}' "$SMOKE_COMPANY" | api --data-binary @- "$BASE/api/companies" 2>/dev/null)"
            cid="$(grep -oE '"company":\{"id":"[0-9a-f-]{36}"' <<<"$mc" | grep -oE '[0-9a-f-]{36}')"
            if [[ $cid =~ ^[0-9a-f-]{36}$ ]]; then made_company=1; else cid=""; setup_fail="creating the staging company failed: ${mc:0:120}"; fi
          fi
        else relaunch=1
        fi
      else relaunch=1
      fi
      if [[ -z $setup_fail ]]; then
        mp="$(printf '{"name":"%s"}' "$SMOKE_PROJECT" | api --data-binary @- "$BASE/api/companies/$cid/projects" 2>/dev/null)"
        pid="$(field id <<<"$mp")"
        [[ $pid =~ ^[0-9a-f-]{36}$ ]] || { pid=""; setup_fail="creating the staging project failed: ${mp:0:120}"; }
      fi
    else relaunch=1
    fi
    if [[ -z $pid ]]; then
      report ticket fail "$setup_fail"
    else
      made="$(printf '{"title":"Smoke check %s"}' "${COMMIT:0:8}" | api --data-binary @- "$BASE/api/projects/$pid/tickets" 2>/dev/null)"
      tid="$(field id <<<"$made")"
      if [[ $tid =~ ^[0-9a-f-]{36}$ ]]; then
        # Tidy up after itself: the owner may move a ticket to done by hand.
        if printf '{"state":"done"}' | api -o /dev/null --data-binary @- "$BASE/api/tickets/$tid/state" 2>/dev/null; then report ticket pass "created a ticket and closed it"; else report ticket pass "created a ticket (could not close it)"; fi
      else report ticket fail "the ticket was not created"; fi
    fi
    if [[ $cid =~ ^[0-9a-f-]{36}$ ]]; then
      # A new company's runner is started by staging's launcher and takes a little while to connect: wait for it.
      # A company that exists but has no runner (the launcher failed before) is asked to start one, once.
      rr="" rend=$((SECONDS + RUNNER_WAIT)) asked="" launch_err=""
      while :; do
        rr="$(api "$BASE/api/companies/$cid/runner" 2>/dev/null)"
        [[ $(field connected <<<"$rr") == true ]] && break
        if [[ -z $asked && -n $relaunch && $(field registered <<<"$rr") != true ]]; then
          asked=1; lr="$(api -X POST "$BASE/api/companies/$cid/runner/launch" 2>/dev/null)"
          [[ $lr != *'"error"'* ]] || launch_err=" (starting it failed: ${lr:0:100})"
        fi
        ((SECONDS < rend)) || break; sleep 2
      done
      img="$(field imageVersion <<<"$rr")"
      if [[ $(field connected <<<"$rr") == true ]]; then report runner pass "runner connected${img:+, image $img}${made_company:+ (staging company made by this check)}"
      else report runner fail "the staging runner is not connected after ${RUNNER_WAIT}s$launch_err"; fi
    else
      report runner fail "no staging company to check: ${setup_fail:-it could not be made}"
    fi
  else
    hint=""
    if [[ $code == 401 ]]; then
      if [[ -z $needs ]]; then
        hint=": staging already has an owner whose name or password differs from the credentials file"
      elif [[ $scode == 400 ]]; then
        hint=": staging has no owner, but it refused to create one from the credentials file (the password must be at least 12 characters and the name at most 64; the password is ${#pass} characters, the name ${#user})"
      else
        hint=": staging has no owner and creating one from the credentials file failed (HTTP ${scode:-none})"
      fi
    fi
    report signin fail "the smoke account could not sign in (HTTP ${code:-none})$hint"; report ticket skipped "not signed in"; report runner skipped "not signed in"
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
