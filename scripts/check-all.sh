#!/usr/bin/env bash
# Everything in CI's "check" job that runs without Docker or a real Postgres, for Boss Man's
# "Before merging" command. CI still runs leader.test.ts (real Postgres) and the image job
# on pushes that touch those areas, every night, and on every pull request.
set -euo pipefail
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$self")/.."

# Only the merge gate runs the full check. Inside an agent session (Claude Code sets CLAUDECODE; the runner's own
# sessions may set BOSSMAN_AGENT_SESSION) a hand run is refused, because it fills the one-slot queue for hours.
# The merge gate (BOSSMAN_MERGE_CHECK, which also runs with a bare environment) and humans are unaffected;
# CHECK_ALL_FORCE=1 overrides, for when the CEO asked for a full run.
if [ -z "${BOSSMAN_CHECK_CHILD:-}" ] && [ -z "${BOSSMAN_MERGE_CHECK:-}" ] && [ -z "${CHECK_ALL_FORCE:-}" ] \
  && { [ -n "${CLAUDECODE:-}" ] || [ -n "${BOSSMAN_AGENT_SESSION:-}" ]; }; then
  echo "Full check runs at the merge gate. Run scripts/check-quick.sh for your branch instead, or set CHECK_ALL_FORCE=1 if the CEO asked you to." >&2
  exit 2
fi

# Where finished runs are kept (result + full log), keyed by the git tree of the checked-out files, so a check that
# already passed on identical content is not run again. /var/tmp survives between runs; "off" switches the store off.
STORE="${BOSSMAN_CHECK_STORE:-/var/tmp/bossman-check-results}"

# A ticket's kept scratch (BOSSMAN_SCRATCH, BOS-592, set by the runner): the full log of every run goes there too,
# under its own name, so a failed check's whole output can be read back after the runner restarted. Best effort: a check
# that can't write a log still checks. scripts/sweep-tmp.sh never touches it, unlike /tmp.
SCRATCH=${BOSSMAN_SCRATCH:-}
SCRATCH_LOG="$SCRATCH/check-all.log"
# scratch_log <file> <exit code>: put this run's completed log in the ticket's kept scratch, so it can be read after a
# restart wiped /tmp. Written as .next then moved into place, so a half-written log is never read, and the previous
# run is kept as .previous. Best effort: a check that can't keep a log still checks. A fenced agent may not write the
# scratch folder itself, so a copy is first made somewhere this run surely can (/tmp, under a name the tmp sweep clears
# after 6 h), and the runner moves that into the scratch at the next start.
scratch_log() {
  local rc=$2 tmp="" out=""
  [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ] || return 0
  # Written to a scratch file, then moved in: a half-written log is never read. A folder the run may not write (a
  # fenced agent's) takes the log through /tmp under a kept name instead, and the runner moves that in at its next start.
  if out="$( { : >"$SCRATCH_LOG.next"; } 2>/dev/null && echo "$SCRATCH_LOG.next")" && [ -n "$out" ]; then
    { printf 'check-all: finished %s (exit %s)\n' "$(date -u +%FT%TZ)" "$rc"; cat "$1" 2>/dev/null; } >"$out" 2>/dev/null || out=""
  fi
  if [ -z "$out" ]; then
    [ -n "${BOSSMAN_TICKET:-}" ] && [ -d /tmp ] && [ -w /tmp ] || return 0
    tmp="/tmp/bossman-scratch-$BOSSMAN_TICKET.log"; out=$tmp
    { printf 'check-all: finished %s (exit %s)\n' "$(date -u +%FT%TZ)" "$rc"; cat "$1" 2>/dev/null; } >"$tmp" 2>/dev/null || return 0
  fi
  if [ -z "$tmp" ]; then
    [ ! -s "$SCRATCH_LOG" ] || mv -f "$SCRATCH_LOG" "$SCRATCH_LOG.previous" 2>/dev/null || true
    mv -f "$out" "$SCRATCH_LOG" 2>/dev/null || true
  fi
}
# The shared runner caps processes (pids.max 1024) and other agents use most of them, so a step can die
# with "spawn EAGAIN" / "Cannot fork" through no fault of the code. Run the checks in a child and re-run
# them, after a pause, only when the failure output shows that kind of error; any other failure is final.
if [ -z "${BOSSMAN_CHECK_CHILD:-}" ]; then
  attempts="${BOSSMAN_CHECK_ATTEMPTS:-3}"
  budget="${BOSSMAN_CHECK_BUDGET_SECONDS:-3000}"  # Boss Man kills the merge check 60 min after its slot is taken (VERIFY_TIMEOUT_MS); stay well inside it
  pause="${BOSSMAN_CHECK_RETRY_SECONDS:-30}"
  log="$(mktemp)"; began_file="$(mktemp)"; slot_at=""
  # The child leaves per-file test times here (vitest JSON reports, shell test times); record() folds them into $STORE/<tree>.test-times (BOS-654).
  times_dir="$(mktemp -d)"
  trap 'rm -f "$log" "$began_file"; rm -rf "$times_dir"' EXIT

  # Only a clean checkout has a tree hash that says what was checked.
  key=""
  if [ "$STORE" != off ] && [ -z "$(git status --porcelain 2>/dev/null)" ] && key="$(git rev-parse 'HEAD^{tree}' 2>/dev/null)" && mkdir -p "$STORE" 2>/dev/null; then
    # A pass on the same tree is reused, except by Boss Man's merge gate (BOSSMAN_MERGE_CHECK): the gate always runs
    # every stage itself and never trusts a stored result. BOSSMAN_CHECK_FORCE=1 also re-runs.
    if [ -z "${BOSSMAN_MERGE_CHECK:-}" ] && [ -z "${BOSSMAN_CHECK_FORCE:-}" ] && grep -q '"status":"pass"' "$STORE/$key.json" 2>/dev/null; then
      echo "check-all: this exact content already passed ($(sed -n 's/.*"finished":"\([^"]*\)".*/\1/p' "$STORE/$key.json")); not running it again."
      echo "check-all: log $STORE/$key.log (set BOSSMAN_CHECK_FORCE=1 to run it anyway)"
      exit 0
    fi
  else
    key=""
  fi
  # A signal ends the run with a visible trace: stop the child (which frees its queue place), write the line to the
  # log and the result store, and exit non-zero. Without this a killed check just vanished and the agent waited for nothing.
  child=""
  on_signal() {
    local name=$1
    trap '' TERM INT HUP
    if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
    sleep 0.2  # let tee drain before the line is added
    echo "check-all: killed by signal $name" | tee -a "$log"
    record killed "$((128 + $2))"
    scratch_log "$log" "$((128 + $2))"
    exit "$((128 + $2))"
  }
  trap 'on_signal TERM 15' TERM
  trap 'on_signal INT 2' INT
  trap 'on_signal HUP 1' HUP
  # record <status> <exit code>: keep the result and the full log; a pass is what later runs reuse.
  record() {
    [ -n "$key" ] || return 0
    local dur=0
    [ -s "$began_file" ] && dur=$(( $(date +%s) - $(cat "$began_file") ))
    cp "$log" "$STORE/$key.log" 2>/dev/null || return 0
    # Per-step times ("check-all: step <name> took <s>s"), as {"name":seconds,...} in order, so the result shows where the time went.
    local steps
    steps=$(sed -n 's/^check-all: step \([A-Za-z0-9:._-]*\) took \([0-9]*\)s.*/"\1":\2/p' "$log" | paste -sd, -)
    printf '{"status":"%s","exit":%s,"tree":"%s","commit":"%s","finished":"%s","duration_seconds":%s,"merge_check":%s,"steps":{%s}}\n' \
      "$1" "$2" "$key" "$(git rev-parse HEAD)" "$(date -u +%FT%TZ)" "$dur" "$([ -n "${BOSSMAN_MERGE_CHECK:-}" ] && echo true || echo false)" "$steps" >"$STORE/$key.json" || return 0
    # Per-file test times of this run (best effort): the slowest server test files and shell tests, in seconds, for the next speed-up.
    if [ -n "$(ls -A "$times_dir" 2>/dev/null)" ]; then
      if node "$(dirname "$self")/test-times.mjs" "$times_dir" >"$STORE/$key.test-times.tmp" 2>/dev/null; then
        mv "$STORE/$key.test-times.tmp" "$STORE/$key.test-times"
      else
        rm -f "$STORE/$key.test-times.tmp"
      fi
    else
      rm -f "$STORE/$key.test-times"
    fi
    # keep the newest 50 results
    local old
    while read -r old; do rm -f "$old" "${old%.json}.log" "${old%.json}.test-times"; done < <(find "$STORE" -maxdepth 1 -name '*.json' -printf '%T@ %p\n' | sort -rn | tail -n +51 | cut -d' ' -f2-)
  }
  [ -z "$key" ] || echo "check-all: the result and log of this run will be kept in $STORE/$key.{json,log}"
  for ((n = 1; n <= attempts; n++)); do
    # Test hook: a simulated queue wait, which the fixed budget ignores (check-all.test.sh retry-budget case).
    [ "$n" -gt 1 ] || [ -z "${CHECK_ALL_QUEUE_TEST_SLEEP:-}" ] || sleep "$CHECK_ALL_QUEUE_TEST_SLEEP"
    rc=0; : >"$began_file"; attempt_start=$SECONDS; rm -rf "${times_dir:?}"/* 2>/dev/null || true
    # The child runs in the background and we wait for it, so a signal reaches the trap at once instead of after the child.
    BOSSMAN_CHECK_CHILD=1 BOSSMAN_CHECK_STORE="$STORE" BOSSMAN_CHECK_TIMES_DIR="$times_dir" CHECK_ALL_STARTED_FILE="$began_file" bash "$self" > >(tee "$log") 2>&1 &
    child=$!
    wait "$child" || rc=$?
    wait 2>/dev/null || true  # let tee finish writing the log
    # Exit 75: nothing ran (gave up waiting for a slot), so there is no result to keep.
    if [ "$rc" -eq 0 ]; then record pass 0; scratch_log "$log" 0; exit 0; fi
    # Each retry re-runs everything, so only retry if another run of this length still fits the budget.
    # The budget counts from the slot-taken time (the first non-empty $began_file), not from before the queue wait:
    # a long wait used to use it up, so a check that then hit EAGAIN was never retried.
    took=$((SECONDS - attempt_start)); began=$(cat "$began_file")
    if [ -n "$began" ]; then [ -n "$slot_at" ] || slot_at=$began; took=$(($(date +%s) - began)); fi
    if [ "$n" -lt "$attempts" ] && [ $(( $(date +%s) - ${slot_at:-$(date +%s)} + took + pause )) -le "$budget" ] && grep -qE 'spawn(Sync)? .*EAGAIN|EAGAIN: resource|Cannot fork|Resource temporarily unavailable|fork: retry' "$log"; then
      echo "check-all: attempt $n hit the runner's process limit (exit $rc); retrying in ${pause}s" >&2
      # Run the pause in the background and wait for it, so a signal reaches on_signal at once, not up to ${pause}s later.
      sleep "$pause" & pause_pid=$!; wait "$pause_pid" 2>/dev/null || true
    else
      [ "$rc" -eq 75 ] || record fail "$rc"
      scratch_log "$log" "$rc"
      exit "$rc"
    fi
  done
fi

# BOSSMAN_CHECK_BODY replaces the checks below with a stub command (for check-all.test.sh).
if [ -n "${BOSSMAN_CHECK_BODY:-}" ]; then bash -c "$BOSSMAN_CHECK_BODY"; exit; fi

# Clear old test scratch out of /tmp (older than 6 h, held by no process); best effort, never fails the check.
"$(dirname "${BASH_SOURCE[0]}")/sweep-tmp.sh" || true

# CHECK_ALL_SLOT_COMMAND (used by check-quick.sh, with BOSSMAN_CHECK_CHILD=1): wait for a slot exactly like a hand-run check,
# run that one command while holding it, and exit with its status. None of the full checks run.
if [ -z "${CHECK_ALL_SLOT_COMMAND:-}" ]; then
  pnpm install --frozen-lockfile --prefer-offline >/dev/null
  node --test scripts/*.test.mjs
  node scripts/lint-migrations.mjs
fi
# The heavy phases below peak well above 2 GB each, so only CHECK_ALL_SLOTS checks (1 until a side-by-side pair has passed, then 2) run them at once;
# the rest queue in order, merge checks first. Each slot is a lock file held until this script exits.
# A waiter prints its place and an estimated wait. Hand-run checks never give up. A merge check keeps its place for as
# long as the queue moves, and gives up (exit 75) only when it stands still: neither its place nor who holds a slot has
# changed for CHECK_ALL_STUCK_AFTER seconds (default 1 h, longer than a check runs); it then says so ("made no progress").
# CHECK_ALL_LOCK_WAIT, when set, is a hard cap on the whole wait for a merge check (exit 75, which Boss Man retries).
# The merge check queues like the rest but goes ahead of waiting hand-run checks; one already running is never interrupted.
# fd 9 is inherited by pnpm/vitest: if a timed-out check leaves children behind they keep the slot until
# they exit (tracked in the runner-cleanup ticket). Skipped where flock is missing (macOS).
# BOSSMAN_CHECK_NO_LOCK=1 (set by the runner for a server-queued job, DR-003): the server holds the slots, so this script
# touches no lock file and does not queue; it still keeps the result store.
if [ -n "${BOSSMAN_CHECK_NO_LOCK:-}" ]; then
  echo "check-all: slot taken, running the checks (the server holds the slots; no lock files)"
elif command -v flock >/dev/null; then
  LOCK=${CHECK_ALL_LOCK:-/tmp/bossman-check-all}
  # One check at a time until a measured side-by-side pair has passed: that run writes the proof file below
  # (see the Build and test note). CHECK_ALL_PAIR_TRIAL=1 lets the two measuring runs use more slots.
  PROOF=${CHECK_ALL_PAIR_PROOF:-/var/tmp/bossman-check-pair-passed}
  SLOTS=1
  # A proof file holding just a whole number sets the slot count (the runner writes it from BOSSMAN_CHECK_SLOTS, so sessions
  # cannot); any other content (a pair-measurement note) keeps the old meaning: CHECK_ALL_SLOTS, default 2.
  if [ -s "$PROOF" ] && [[ "$(tr -d '[:space:]' <"$PROOF" 2>/dev/null)" =~ ^[0-9]{1,2}$ ]]; then SLOTS=$((10#${BASH_REMATCH[0]})); [ "$SLOTS" -ge 1 ] || SLOTS=1; [ "$SLOTS" -le 16 ] || SLOTS=16
  elif [ -s "$PROOF" ] || [ -n "${CHECK_ALL_PAIR_TRIAL:-}" ]; then SLOTS=${CHECK_ALL_SLOTS:-2}
  elif [ "${CHECK_ALL_SLOTS:-1}" -gt 1 ]; then echo "check-all: CHECK_ALL_SLOTS=$CHECK_ALL_SLOTS ignored, no passed side-by-side pair recorded in $PROOF; running one at a time"
  fi
  QDIR="$LOCK.queue"  # one file per waiting check, "<0 merge | 1 hand-run>-<time>-<pid>"; names sort into serving order
  WAIT=${CHECK_ALL_LOCK_WAIT:-0}; STUCK=0; prio=1
  if [ -n "${BOSSMAN_MERGE_CHECK:-}" ]; then prio=0; STUCK=${CHECK_ALL_STUCK_AFTER:-3600}; fi
  AGEREF="$LOCK.age.$$"  # an empty file dated 2 h ago, to tell stale queue entries by their modification time
  # Fair line (BOS-558): a hand-run entry that has waited CHECK_ALL_AGE_AFTER seconds (default 1200, one full check) is served
  # before merge checks that queued after it (never before older ones); a new entry from the same folder replaces the older one (marker file REPLACED, read by the older
  # waiter); every slot hold is logged to SLOTLOG (start and end), so a gap in the line can be named later.
  AGE_AFTER=${CHECK_ALL_AGE_AFTER:-1200}; [[ $AGE_AFTER =~ ^[0-9]{1,9}$ ]] || AGE_AFTER=1200
  FOLDER=${CHECK_ALL_FOLDER:-$(pwd -P)}; FOLDER=${FOLDER//[$'\n\r']/ }
  REPLACED="$LOCK.replaced.$$"; SLOTLOG=${CHECK_ALL_SLOT_LOG:-$LOCK.slotlog}; SLOT_K=0
  rm -f "$REPLACED" 2>/dev/null || true
  # Line rules that can't jam (BOS-591). Every queue entry is three lines: the folder, "rules=<N>" and "boot=<id>".
  # RULES is the serving-order version of this copy of the script: bump it whenever the queue rules change. A waiter that
  # finds an entry with a newer version is an old copy of the script and leaves (exit 75, "merge origin/main"), so it can't
  # sit at the head waiting on an order the newer copies don't follow. Entries from an older runner boot are dropped.
  # A waiter that sees a free slot and no change in the line for CHECK_ALL_STALL_AFTER seconds (default 120) tries for the
  # slot whatever its place; the flock itself keeps two from running in one slot. Old copies (no version lines) still queue.
  # v3 (BOS-613): one list in queue-time order for merge checks and aged hand-run entries; hand-run checks hold at most SLOTS-1 slots while a merge check waits.
  RULES=${CHECK_ALL_QUEUE_RULES:-3}; [[ $RULES =~ ^[0-9]{1,6}$ ]] || RULES=3; RULES=$((10#$RULES))
  STALL_AFTER=${CHECK_ALL_STALL_AFTER:-120}; [[ $STALL_AFTER =~ ^[0-9]{1,9}$ ]] || STALL_AFTER=120
  boot_id() {  # kernel boot id plus when pid 1 started: the second part changes when the runner container restarts too
    local b="" s=""; read -r b </proc/sys/kernel/random/boot_id 2>/dev/null || true
    local f=(); s=$(</proc/1/stat) || s=""; s=${s##*) }; read -ra f <<<"$s"; echo "${b:-noboot}-${f[19]:-nopid1}"
  }
  BOOT=${CHECK_ALL_BOOT_ID:-$(boot_id)}; BOOT=${BOOT//[^A-Za-z0-9._-]/_}
  write_entry() { printf '%s\nrules=%s\nboot=%s\n' "$FOLDER" "$RULES" "$BOOT" >"$qfile"; }
  # An unreachable lock folder (for example outside a fenced session's grant) fails at once with a clear message,
  # never a silent wait: a slot file that cannot be opened would otherwise read as "busy" forever.
  lock_unusable() { echo "check-all: cannot use the check lock folder: $1 (set CHECK_ALL_LOCK to a writable path)" >&2; exit 2; }
  mkdir -p "$QDIR" 2>/dev/null || lock_unusable "cannot create $QDIR"
  qfile="$QDIR/$prio-$(date +%s%N)-$$"
  { write_entry; } 2>/dev/null || lock_unusable "cannot write $qfile"
  trap 'rm -f "$qfile" "$AGEREF" "$REPLACED"' EXIT
  # One place per folder: a hand-run entry replaces older hand-run entries of the same folder (live ones get a marker to exit on).
  if [ "$prio" = 1 ]; then
    mine_base=${qfile##*/}; seen_n=0
    for f in "$QDIR"/1-*; do
      [ -e "$f" ] || continue; [ "$f" != "$qfile" ] || continue
      seen_n=$((seen_n + 1)); [ "$seen_n" -le "${CHECK_ALL_QUEUE_SCAN:-200}" ] || break
      base=${f##*/}; [[ $base < $mine_base ]] || continue
      [[ $base =~ ^1-[0-9]{1,19}-([0-9]{1,9})$ ]] || continue
      other=""; read -r other <"$f" 2>/dev/null || true
      [ "$other" = "$FOLDER" ] || continue
      [ ! -d "/proc/$((10#${BASH_REMATCH[1]}))" ] || { : >"$LOCK.replaced.$((10#${BASH_REMATCH[1]}))"; } 2>/dev/null || true
      rm -f "$f"
    done
  fi
  # Killed while waiting: leave the queue and free the place for the next one at once. The parent's TERM/INT/HUP
  # trap (on_signal) then writes the "killed by signal" line and stops this child. Sleeping in the background and
  # waiting on it makes a signal act immediately instead of after the sleep ends (up to CHECK_ALL_QUEUE_REPORT).
  # A signal here runs the EXIT trap above, which removes the queue entry, then exits 143 so the parent records it.
  wait_signal() { sleep "$1" & sleep_pid=$!; wait "$sleep_pid" 2>/dev/null || true; }
  trap '[ -z "${BOSSMAN_CHECK_CHILD:-}" ] || exit 143' TERM INT HUP
  take_slot() {
    local k
    for ((k = 1; k <= SLOTS; k++)); do
      { exec 9>"$LOCK.slot.$k"; } 2>/dev/null || lock_unusable "cannot open $LOCK.slot.$k"
      # Note who holds the slot in a file of its own (every waiter's open truncates the slot file): a waiter
      # sees the queue move when this line changes. Best effort; a holder from an older script leaves none.
      if flock -n 9; then SLOT_K=$k; echo "$$ $(date +%s) $([ "$prio" = 1 ] && echo hand || echo merge)" >"$LOCK.holder.$k" 2>/dev/null || true; return 0; fi
    done
    exec 9>&-
    return 1
  }
  # Prints "<my place> <checks waiting>", dropping queue entries whose process is gone.
  # Agents can write this folder, so it is read defensively: no subprocess per entry (5000 planted entries
  # took 13.6 s a pass with them), and only the first CHECK_ALL_QUEUE_SCAN entries in serving order count.
  # A waiter further back sees a place past the scan and keeps waiting.
  queue_place() {
    # Serving order (BOS-613): merge checks and aged hand-run entries in one list, oldest queue time first (an aged hand-run
    # entry beats only merge checks that queued after it), then the other hand-run entries oldest first. While a merge check
    # waits and the hand-run checks already running fill all but one slot (more than one slot), no hand-run entry goes ahead
    # of a merge check: aged ones drop to the back with the rest. $1 is the number of hand-run checks running now.
    local f base qts qpid mine=0 total=0 scan=${CHECK_ALL_QUEUE_SCAN:-200} now stale=0 nM=0 nA=0 nH=0 myclass="" newer=0 sig="" el2 el3
    local key mykey="" capped=0 mk=() ak=() hk=() ns qns; now=$(date +%s)
    # A live waiter touches its entry every report, so age is read from the file's modification time (a bash test,
    # no subprocess per entry), not from the name: a check that has waited more than 2 h in a long queue keeps its place.
    touch -d "@$((now - 7200))" "$AGEREF" 2>/dev/null && stale=1
    for f in "$QDIR"/*; do
      [ -e "$f" ] || continue
      # Drop malformed entries first: the folder is shared, so a name is never used in arithmetic unless it is
      # digits only, and short enough not to overflow. Then drop entries whose process is gone, older than 2 h
      # (a killed waiter whose pid was reused), or dated more than a minute ahead (planted to jump the queue).
      # "Gone" is read from /proc, not kill -0: a fenced agent may not signal other sessions (BOS-321).
      base=${f##*/}
      if ! [[ $base =~ ^[01]-([0-9]{1,19})-([0-9]{1,9})$ ]]; then rm -f "$f"; continue; fi
      qns=${BASH_REMATCH[1]}; qts=$((10#$qns / 1000000000)); qpid=$((10#${BASH_REMATCH[2]}))
      if [ ! -d "/proc/$qpid" ] || [ $((qts - now)) -gt 60 ] || { [ "$stale" = 1 ] && [ "$f" -ot "$AGEREF" ]; }; then rm -f "$f"; continue; fi
      # Version lines (BOS-591): an entry from an older runner boot is dropped; one with newer rules than mine is noted.
      el2=""; el3=""; { read -r _; read -r el2; read -r el3; } <"$f" 2>/dev/null || true
      if [[ $el3 == boot=* ]] && [ "${el3#boot=}" != "$BOOT" ]; then rm -f "$f"; continue; fi
      if [[ $el2 =~ ^rules=([0-9]{1,6})$ ]] && [ $((10#${BASH_REMATCH[1]})) -gt "$RULES" ] && [ "$f" != "$qfile" ]; then newer=$((10#${BASH_REMATCH[1]})); fi
      sig="$sig $base"
      total=$((total + 1))
      # Sort key: the queue time in nanoseconds, zero-padded to 19 digits so a string compare is a number compare (no overflow),
      # then the name to break a tie. Digits only: the name matched the pattern above.
      ns="0000000000000000000$qns"; key="${ns: -19}-$base"
      if [ "${base:0:1}" = 0 ]; then nM=$((nM + 1)); mk+=("$key"); [ "$f" != "$qfile" ] || { myclass=M; mykey=$key; }
      elif [ $((now - qts)) -ge "$AGE_AFTER" ]; then nA=$((nA + 1)); ak+=("$key"); [ "$f" != "$qfile" ] || { myclass=A; mykey=$key; }
      else nH=$((nH + 1)); hk+=("$key"); [ "$f" != "$qfile" ] || { myclass=H; mykey=$key; }
      fi
      if [ "$total" -ge "$scan" ]; then break; fi
    done
    # Cap: with a merge check waiting and more than one slot, hand-run checks may hold at most SLOTS-1 slots.
    if [ "$nM" -gt 0 ] && [ "$SLOTS" -gt 1 ] && [ "${1:-0}" -ge $((SLOTS - 1)) ]; then capped=1; fi
    # Groups, served in this order: 0 = merge checks (+ aged hand-run entries unless capped), 1 = aged hand-run entries when
    # capped, 2 = the other hand-run entries. Inside a group, oldest queue time first. Place = entries in earlier groups +
    # older entries in my group + 1.
    older() { local n=0 x; for x in "$@"; do if [[ $x < $mykey ]]; then n=$((n + 1)); fi; done; cnt=$n; }
    local cnt=0
    case $myclass in
      M) if [ "$capped" = 0 ]; then older ${mk[@]+"${mk[@]}"} ${ak[@]+"${ak[@]}"}; else older ${mk[@]+"${mk[@]}"}; fi
         mine=$((cnt + 1)) ;;
      A) if [ "$capped" = 0 ]; then older ${mk[@]+"${mk[@]}"} ${ak[@]+"${ak[@]}"}; mine=$((cnt + 1))
         else older ${ak[@]+"${ak[@]}"}; mine=$((nM + cnt + 1)); fi ;;
      H) older ${hk[@]+"${hk[@]}"}; mine=$((nM + nA + cnt + 1)) ;;
    esac
    # Own entry not seen (past the scan, or dropped): count it behind the scan.
    [ "$mine" -gt 0 ] || mine=$((scan + 1))
    echo "$mine $total $newer $capped ${sig// /,}"
  }
  # Prints how many hand-run checks hold a slot right now (BOS-613): a slot is held when its lock can't be taken, and its
  # holder file (written by take_slot: "<pid> <time> <hand|merge>") names the kind. A holder from an older copy has no
  # kind and counts as a merge check. Not atomic with take_slot: two hand-run checks may take the last two allowed slots
  # in the same second; the next pass corrects the line, nothing is left stuck.
  hand_running() {
    local k n=0 line="" kind
    for ((k = 1; k <= SLOTS; k++)); do
      { exec 8>"$LOCK.slot.$k"; } 2>/dev/null || continue
      if flock -n 8; then exec 8>&-; continue; fi
      exec 8>&-
      line=""; read -r line <"$LOCK.holder.$k" 2>/dev/null || true
      kind=${line##* }; if [ "$kind" = hand ]; then n=$((n + 1)); fi
    done
    echo "$n"
  }
  # True when some slot is free right now (probed on fd 8 and let go at once, so nothing is held).
  slot_free() {
    local k ok=1
    for ((k = 1; k <= SLOTS; k++)); do
      { exec 8>"$LOCK.slot.$k"; } 2>/dev/null || continue
      if flock -n 8; then ok=0; fi
      exec 8>&-
      [ "$ok" = 1 ] || return 0
    done
    return 1
  }
  # Average length of the last passed runs, for the wait estimate (10 minutes when there are none).
  typical_run() {
    local sum=0 n=0 d f
    if [ -d "${BOSSMAN_CHECK_STORE:-off}" ]; then
      while read -r f; do
        grep -q '"status":"pass"' "$f" || continue
        d=$(sed -n 's/.*"duration_seconds":\([0-9]*\).*/\1/p' "$f")
        if [ -n "$d" ] && [ "$((10#$d))" -gt 0 ]; then sum=$((sum + 10#$d)); n=$((n + 1)); fi
      done < <(find "$BOSSMAN_CHECK_STORE" -maxdepth 1 -name '*.json' -printf '%T@ %p\n' | sort -rn | head -n 10 | cut -d' ' -f2-)
    fi
    if [ "$n" -gt 0 ]; then echo $((sum / n)); else echo 600; fi
  }
  waited_from=$SECONDS; last_said=-1000; got=no; typical=""; stuck=no; seen=""; moved_at=$SECONDS; stall_sig=""; stall_since=$SECONDS
  while :; do
    if [ "$prio" = 1 ] && [ -e "$REPLACED" ]; then
      echo "check-all: replaced by a newer check of this folder ($FOLDER); leaving the line" >&2; exit 75
    fi
    read -r place total newer capped linesig < <(queue_place "$(hand_running)")
    if [ "${newer:-0}" -gt 0 ]; then
      echo "check-all: this copy of check-all.sh uses queue rules v$RULES but the line is on v$newer: merge origin/main to get the current script; leaving the line" >&2; exit 75
    fi
    if [ "$place" -le 1 ] && take_slot; then got=yes; break; fi
    # A line that stands still with a free slot (an old copy at the head, waiting on an order the rest don't follow) must not
    # jam: after STALL_AFTER seconds of a free slot and no change in the line, try for the slot whatever my place.
    # A hand-run check held back by the hand-run cap (BOS-613) does not take part: the free slot is the merge check's.
    if slot_free && [ "$linesig" = "${stall_sig:-}" ]; then
      if [ $((SECONDS - stall_since)) -ge "$STALL_AFTER" ] && { [ "$prio" = 0 ] || [ "$capped" != 1 ]; } && take_slot; then
        echo "check-all: the line stood still for $((SECONDS - stall_since)) s with a free slot (place $place of $total); taking it"; got=yes; break
      fi
    else stall_sig=$linesig; stall_since=$SECONDS; fi
    if [ "$WAIT" -gt 0 ] && [ $((SECONDS - waited_from)) -ge "$WAIT" ]; then break; fi
    # The queue moves when my place changes or a slot gets a new holder; one that stands still too long is stuck.
    if [ "$STUCK" -gt 0 ]; then
      holders=""
      for h in "$LOCK".holder.*; do
        [ -f "$h" ] || continue
        line=""; read -r line <"$h" 2>/dev/null || true
        holders="$holders|$line"
      done
      if [ "$place|$holders" != "$seen" ]; then seen="$place|$holders"; moved_at=$SECONDS; fi
      if [ $((SECONDS - moved_at)) -ge "$STUCK" ]; then stuck=yes; break; fi
    fi
    if [ $((SECONDS - last_said)) -ge "${CHECK_ALL_QUEUE_REPORT:-30}" ]; then
      { write_entry; } 2>/dev/null || true  # keep my queue entry fresh (and put it back if someone removed it)
      [ -n "$typical" ] || typical=$(typical_run)
      rounds=$(((place + SLOTS - 1) / SLOTS))
      echo "check-all: waiting for a free check slot (place $place of $total, $SLOTS run at once); about $(((rounds * typical + 59) / 60)) min to go"
      last_said=$SECONDS
    fi
    wait_signal 1
  done
  if [ "$got" = no ]; then
    # Exit 75 (EX_TEMPFAIL) and this exact wording tell Boss Man nothing ran: it retries the merge instead of sending the ticket back.
    if [ "$stuck" = yes ]; then
      echo "check-all: gave up waiting for the heavy-phase lock $LOCK: the queue made no progress for $(((STUCK + 59) / 60)) min (place $place of $total; the check holding the slot has not changed)" >&2; exit 75
    fi
    echo "check-all: gave up waiting for the heavy-phase lock $LOCK" >&2; exit 75
  fi
  rm -f "$qfile" "$AGEREF" "$REPLACED"; trap - EXIT
  # Slot log: one line when the slot is taken and one when it is let go (a killed holder leaves only the first), best effort.
  slot_kind=hand; [ "$prio" = 1 ] || slot_kind=merge
  # check= is what runs in the slot (check-quick.sh sets CHECK_ALL_CHECK_KIND=quick) and tree= the git tree of the checked
  # files, with "-dirty" when the folder has changes git has no tree for, so repeat checks of one tree can be counted (BOS-666).
  slot_check=${CHECK_ALL_CHECK_KIND:-full}; [[ $slot_check =~ ^[a-z]{1,10}$ ]] || slot_check=full
  slot_tree=$(git rev-parse 'HEAD^{tree}' 2>/dev/null) || slot_tree=none
  [ "$slot_tree" = none ] || [ -z "$(git status --porcelain 2>/dev/null)" ] || slot_tree="$slot_tree-dirty"
  slot_log() { printf '%s %s pid=%s kind=%s slot=%s check=%s tree=%s folder=%s\n' "$(date -u +%FT%TZ)" "$1" "$$" "$slot_kind" "$SLOT_K" "$slot_check" "$slot_tree" "$FOLDER" >>"$SLOTLOG" 2>/dev/null || true; }
  if [ -f "$SLOTLOG" ] && [ "$(wc -l <"$SLOTLOG" 2>/dev/null || echo 0)" -gt 5000 ]; then
    { tail -n 2000 "$SLOTLOG" >"$SLOTLOG.tmp.$$" && mv "$SLOTLOG.tmp.$$" "$SLOTLOG"; } 2>/dev/null || rm -f "$SLOTLOG.tmp.$$"
  fi
  slot_log start; trap 'slot_log end' EXIT
  echo "check-all: slot taken, running the checks"
else
  echo "check-all: flock not found, running without the heavy-phase lock"
fi
[ -z "${CHECK_ALL_STARTED_FILE:-}" ] || date +%s >"$CHECK_ALL_STARTED_FILE"
# Nested check-all runs (the script tests inside the full check) inherit this variable and would overwrite the start time, so the
# recorded duration came out as seconds: only the run that owns the file may write it (BOS-545).
unset CHECK_ALL_STARTED_FILE
# Test hook: scripts/check-all.test.sh stops here once the lock is held.
[ -z "${CHECK_ALL_STOP_AFTER_LOCK:-}" ] || { echo "check-all: lock held"; exit 0; }
if [ -n "${CHECK_ALL_SLOT_COMMAND:-}" ]; then rc=0; bash -c "$CHECK_ALL_SLOT_COMMAND" || rc=$?; exit "$rc"; fi
# step <name> <command...>: runs one stage and prints how long it took, so a slow host shows which stage slowed down (BOS-523).
step() { local name=$1 began=$SECONDS rc=0; shift; "$@" || rc=$?; echo "check-all: step $name took $((SECONDS - began))s (exit $rc, at $(date -u +%H:%M:%S) UTC)"; return "$rc"; }
step in-memory-state node scripts/check-in-memory-state.mjs
# Memory-safe on a shared runner (a 12 GB cgroup shared with other agents, two checks at once): one package at a time,
# at most 2 PGlite workers (fewer when the cgroup has less free; see apps/server/vitest.config.ts),
# and a capped heap for tsc only. Callers can override any of these.
export BOSSMAN_TEST_MAX_WORKERS="${BOSSMAN_TEST_MAX_WORKERS:-2}"
# /tmp fills with the tests' own scratch (BOS-568), and a check that starts on a full one fails oddly. Say so up front,
# in the kept log, instead: 64 MB written and read back once per check. A probe that can't finish in 20 s is left as is.
if [ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ] && [ -z "${BOSSMAN_SKIP_TMP_PROBE:-}" ]; then
  probe="$TMPDIR/.bossman-probe.$$"
  if mkdir -p "$probe" 2>/dev/null && dd if=/dev/zero of="$probe/blob" bs=1M count=64 conv=fsync 2>/dev/null; then
    wrote=$(date +%s%N)
    if timeout 20 dd if="$probe/blob" of=/dev/null bs=1M iflag=fullblock 2>/dev/null; then
      elapsed=$(( ($(date +%s%N) - wrote) / 1000000 ))
      [ "$elapsed" -lt 3000 ] || echo "check-all: note: $TMPDIR is slow (read 64 MB in ${elapsed} ms), so tests that scratch there are slow too"
    fi
  else
    echo "check-all: note: $TMPDIR may be full (couldn't write 64 MB there), so a check that needs temp space may fail"
  fi
  rm -rf "$probe" 2>/dev/null || true
fi
# Typecheck and tests run one package at a time (the same order and limits as `pnpm -r --workspace-concurrency=1`), each as its own
# timed step, so the time shows which package is slow (BOS-415). Packages come from pnpm in dependency order.
pkg_dirs=(); while IFS= read -r d; do pkg_dirs+=("$d"); done < <(pnpm -r --workspace-concurrency=1 exec pwd 2>/dev/null | grep '^/' || true)
[ "${#pkg_dirs[@]}" -gt 0 ] || { echo "check-all: could not list the workspace packages" >&2; exit 1; }
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
for d in "${pkg_dirs[@]}"; do
  grep -q '"typecheck"' "$d/package.json" || continue
  step "typecheck:${d##*/}" pnpm --dir "$d" run typecheck
done
unset NODE_OPTIONS  # the heap cap is for tsc only
for d in "${pkg_dirs[@]}"; do
  grep -q '"test"' "$d/package.json" || continue
  # BOSSMAN_TEST_TIMES_FILE makes vitest also write a JSON report, which the parent folds into the result store (BOS-654).
  step "test:${d##*/}" env ${BOSSMAN_CHECK_TIMES_DIR:+BOSSMAN_TEST_TIMES_FILE="$BOSSMAN_CHECK_TIMES_DIR/vitest-${d##*/}.json"} pnpm --dir "$d" run test
done
step build pnpm build
step shellcheck scripts/check-shell.sh
step shell-tests env ${BOSSMAN_CHECK_TIMES_DIR:+BOSSMAN_SHELL_TIMES_FILE="$BOSSMAN_CHECK_TIMES_DIR/shell.tsv"} scripts/test-shell.sh
echo "check-all: everything passed"
