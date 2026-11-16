#!/usr/bin/env bash
# Sourced by scripts/check-quick.sh and scripts/check-all.sh (BOS-1628): one package install for both checks.
# pnpm's install on a fresh tree can die of the machine, not the branch: "EAGAIN ... copyfile" (pnpm could not hardlink from
# its store into the job folder and fell back to copying, which ran out of handles or hit a limit), a full disk (ENOSPC) or too
# many open files (EMFILE/ENFILE). Try again, gentler each time. Returns 75 (EX_TEMPFAIL) and prints the marker line below if it
# still fails for that reason, so the server (check-dispatcher.ts, MACHINE_FAULT_MARKER) puts the check back in line instead
# of sending it to the agent as a failed check. Any other failure (a bad lockfile, a missing package) returns the pnpm exit
# code at once. On a machine fault it also prints the facts that show the cause, so no one has to ask the owner to run commands.
ENV_FAULT_MARKER="check-quick: install stopped on a machine fault"

# Facts for the log: filesystem type and device of the pnpm store and of this folder (different devices = no hardlinks, so
# pnpm copies), the open-file limit and the free space. Best effort: every probe may fail and none changes the result.
install_fault_facts() {
  local store here
  store="$(pnpm store path 2>/dev/null)" || store=""
  here="$PWD"
  echo "install fault facts (why the install failed, for whoever reads this log):"
  echo "  pnpm store:  type=$(stat -f -c %T "${store:-/}" 2>/dev/null || echo '?') device=$(stat -c %d "${store:-/}" 2>/dev/null || echo '?')"
  echo "  job folder:  type=$(stat -f -c %T "$here" 2>/dev/null || echo '?') device=$(stat -c %d "$here" 2>/dev/null || echo '?')"
  echo "  open files limit (ulimit -n): $(ulimit -n 2>/dev/null || echo '?')"
  echo "  free space:  store: $(df -Pk "${store:-/}" 2>/dev/null | awk 'NR==2 {print $4 " KiB free"}') | job folder: $(df -Pk "$here" 2>/dev/null | awk 'NR==2 {print $4 " KiB free"}')"
  return 0
}

install_packages() {
  local out rc=0 try
  for try in 1 2 3; do
    rc=0
    if [ "$try" -eq 1 ]; then out="$(pnpm install --frozen-lockfile --prefer-offline 2>&1)" || rc=$?
    else out="$(pnpm install --frozen-lockfile --prefer-offline --network-concurrency 2 --child-concurrency 1 2>&1)" || rc=$?; fi
    [ "$rc" -ne 0 ] || break
    printf '%s\n' "$out" | tail -n 20
    if ! grep -Eq 'EAGAIN|ENOSPC|EMFILE|ENFILE|resource temporarily unavailable|no space left on device' <<<"$out"; then return "$rc"; fi
    if [ "$try" -ge 3 ]; then
      install_fault_facts
      echo "$ENV_FAULT_MARKER (EAGAIN, ENOSPC or EMFILE after $try tries): the machine, not the branch; the check goes back in line"
      return 75
    fi
    echo "install failed on a machine error (try $try of 3); trying again with fewer files at once"
    sleep "$((try * ${CHECK_QUICK_INSTALL_PAUSE:-5}))"
  done
  [ "$rc" -ne 0 ] || printf '%s\n' "$out" | tail -n 5
  return "$rc"
}
