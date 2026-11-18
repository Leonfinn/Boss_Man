#!/usr/bin/env bash
# Tests for scripts/squeeze-test.sh: results per run, the stop, and that nothing is left running (BOS-1759).
# A fake command stands in for vitest, so no browser or test run is needed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v taskset >/dev/null 2>&1 || { echo "squeeze-test.test: skipped, no taskset on this machine"; exit 0; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
export BOSSMAN_SCRATCH=$T
mkdir -p "$T/fake"
# The script only takes a file under apps/ or packages/ of its repo folder: a made-up one stands in.
export SQUEEZE_ROOT=$T/repo
mkdir -p "$SQUEEZE_ROOT/apps/server/test"
FILE=$SQUEEZE_ROOT/apps/server/test/squeeze-fake.test.ts
: >"$FILE"

# Fake runner: "pass" and "fail" end at once, "hang" sleeps, "flaky" fails on its first run only.
cat >"$T/fake/run.sh" <<'EOF'
#!/usr/bin/env bash
case "$FAKE_MODE" in
  pass) echo "all good"; exit 0 ;;
  fail) echo "AssertionError: expected false to be true"; exit 1 ;;
  skipped) echo " Tests  1 skipped (1)"; exit 0 ;;
  hang) sleep 300; exit 0 ;;
  flaky) if [ -e "$FAKE_STATE" ]; then exit 0; fi; : >"$FAKE_STATE"; exit 1 ;;
  cpu) echo "$(sed -n 's/^Cpus_allowed_list:[[:space:]]*//p' /proc/self/status)" >"$FAKE_STATE"; exit 0 ;;
esac
EOF
chmod +x "$T/fake/run.sh"
export SQUEEZE_COMMAND="$T/fake/run.sh"
export FAKE_STATE=$T/state

alive() { pgrep -f "$1" >/dev/null 2>&1; }

# Pass, fail and mixed runs: a line per run and the right exit code.
FAKE_MODE=pass SQUEEZE_MARK=sqz-t1-$$ scripts/squeeze-test.sh "$FILE" 2 2 >"$T/out" || fail "passing runs exited non-zero"
grep -q "run 1/2: pass" "$T/out" || fail "no pass line for run 1"
grep -q "run 2/2: pass" "$T/out" || fail "no pass line for run 2"
grep -q "2 pass, 0 fail, 0 no answer" "$T/out" || fail "wrong summary for passing runs"
alive "sqz-t1-$$" && fail "busy loops left after a normal finish"

rc=0; FAKE_MODE=fail SQUEEZE_MARK=sqz-t2-$$ scripts/squeeze-test.sh "$FILE" 1 2 >"$T/out" || rc=$?
[ "$rc" -eq 1 ] || fail "failing runs gave exit $rc, want 1"
grep -q "run 1/2: FAIL" "$T/out" || fail "no FAIL line"
grep -q "AssertionError" "$T/out" || fail "failed run's output not shown"

rm -f "$FAKE_STATE"
rc=0; FAKE_MODE=flaky SQUEEZE_MARK=sqz-t3-$$ scripts/squeeze-test.sh "$FILE" 1 2 >"$T/out" || rc=$?
[ "$rc" -eq 1 ] || fail "one failing run gave exit $rc, want 1"
grep -q "run 1/2: FAIL" "$T/out" || fail "flaky: no FAIL line for run 1"
grep -q "run 2/2: pass" "$T/out" || fail "flaky: no pass line for run 2"

# A file whose tests were all skipped proves nothing: an error, not a pass.
rc=0; FAKE_MODE=skipped SQUEEZE_MARK=sqz-t3b-$$ scripts/squeeze-test.sh "$FILE" 1 1 >"$T/out" || rc=$?
[ "$rc" -eq 2 ] || fail "an all-skipped file gave exit $rc, want 2"
grep -q "skipped" "$T/out" || fail "all-skipped not reported"
alive "sqz-t3b-$$" && fail "busy loops left after an all-skipped run"

# The test runs pinned to one CPU.
rm -f "$FAKE_STATE"
FAKE_MODE=cpu SQUEEZE_CPU=0 SQUEEZE_MARK=sqz-t4-$$ scripts/squeeze-test.sh "$FILE" 1 1 >"$T/out" || fail "cpu run failed"
[ "$(cat "$FAKE_STATE")" = "0" ] || fail "test was not pinned to CPU 0: $(cat "$FAKE_STATE")"

# The stop: a hanging run is "no answer", exit 3, and the hanging process and the loops are gone.
rc=0; FAKE_MODE=hang SQUEEZE_STOP_SECONDS=2 SQUEEZE_MARK=sqz-t5-$$ scripts/squeeze-test.sh "$FILE" 2 1 >"$T/out" || rc=$?
[ "$rc" -eq 3 ] || fail "the stop gave exit $rc, want 3"
grep -q "run 1/1: no answer (over 2 s)" "$T/out" || fail "the stop was not reported as no answer"
alive "sqz-t5-$$" && fail "busy loops left after the stop"

# Kill (and Ctrl-C, which takes the same path): the loops and the test process go with the script.
FAKE_MODE=hang SQUEEZE_MARK=sqz-t6-$$ scripts/squeeze-test.sh "$FILE" 3 1 >"$T/out" 2>&1 &
SP=$!
for _ in $(seq 1 100); do alive "sqz-t6-$$" && break; sleep 0.1; done
alive "sqz-t6-$$" || fail "busy loops never started"
for _ in $(seq 1 100); do grep -q "run" "$T/out" 2>/dev/null && break; sleep 0.1; done
sleep 1
kill -TERM "$SP"
wait "$SP" 2>/dev/null || true
for _ in $(seq 1 50); do alive "sqz-t6-$$" || break; sleep 0.1; done
alive "sqz-t6-$$" && fail "busy loops left after the script was killed"
# The fake's "sleep 300" belongs to this script's group; none of ours is left.
pgrep -f "$T/fake/run.sh" >/dev/null 2>&1 && fail "the test process was left after the script was killed"

# Bad use.
scripts/squeeze-test.sh 2>/dev/null && fail "no file accepted"
scripts/squeeze-test.sh "$SQUEEZE_ROOT/apps/server/test/nope.test.ts" 2>/dev/null && fail "missing file accepted"
scripts/squeeze-test.sh "$FILE" x 2>/dev/null && fail "bad loop count accepted"
scripts/squeeze-test.sh README.md 2>/dev/null && fail "file outside apps/ and packages/ accepted"

# No taskset: says so and exits non-zero, never runs unpinned.
mkdir -p "$T/nobin"
for c in bash dirname cut sed mktemp cat setsid timeout sleep; do ln -sf "$(command -v "$c")" "$T/nobin/$c"; done
rc=0; PATH=$T/nobin FAKE_MODE=pass "$(command -v bash)" scripts/squeeze-test.sh "$FILE" >"$T/out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "ran without taskset"
grep -q "taskset" "$T/out" || fail "missing taskset not named"
echo "squeeze-test.test: ok"
