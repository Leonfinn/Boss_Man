// BOS-2082: real vitest 5.0.5 output from the merge gate, kept as fixtures for ci-flake.test.ts.
//
// GATE_RERUN_COLOURED: the head and tail of BOS-1986's gate re-run, job 197ae8a0 (20 Nov 12:16 UTC), of
// apps/server/test/maintenance.test.ts. 59 of 59 tests passed, yet BOS-1733's grep for the "Tests" line missed it: the colour
// codes sit between "Tests" and "59". check_log shows the log with the ESC bytes dropped; they are put back here as \x1b
// before each "[NNm". The check job's folder in the RUN line is cut to a made-up one.
//
// JSON_PASSED: the top-level fields of vitest 5.0.5's JSON reporter (`--reporter=json --outputFile.json=...`), captured
// from a real run of test/ci-flake.test.ts on the runner (testResults left out; the re-run never reads them).

export const GATE_RERUN_COLOURED = [
  "",
  "\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m \x1b[36mv5.0.5 \x1b[39m\x1b[90m/work/check-jobs/job/apps/server\x1b[39m",
  "",
  " \x1b[32m✓\x1b[39m test/maintenance.test.ts \x1b[2m(\x1b[22m\x1b[2m59 tests\x1b[22m\x1b[2m)\x1b[22m\x1b[33m 28793\x1b[2mms\x1b[22m\x1b[39m",
  "   \x1b[32m✓\x1b[39m runner update drain (docs/09-self-deploy.md, phase 2) \x1b[2m(35)\x1b[22m",
  "     \x1b[33m\x1b[2m✓\x1b[22m\x1b[39m holds new runs in every company, lets running ones finish, and counts them for the banner\x1b[33m 2939\x1b[2mms\x1b[22m\x1b[39m",
  "     \x1b[33m\x1b[2m✓\x1b[22m\x1b[39m tries a failed swap again by itself, and needs nobody when a later try works\x1b[33m 446\x1b[2mms\x1b[22m\x1b[39m",
  "   \x1b[32m✓\x1b[39m Stop N and carry on with the update (BOS-1238) \x1b[2m(4)\x1b[22m",
  "     \x1b[33m\x1b[2m✓\x1b[22m\x1b[39m lists the newest answered update cards for Recent updates\x1b[33m 347\x1b[2mms\x1b[22m\x1b[39m",
  "",
  "\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m1 passed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m",
  "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m59 passed\x1b[39m\x1b[22m\x1b[90m (59)\x1b[39m",
  "\x1b[2m   Start at \x1b[22m 12:15:28",
  "\x1b[2m   Duration \x1b[22m 44.08s\x1b[2m (tests 76%, transform 18%, import 6%)\x1b[22m",
  "",
].join("\n");

export const JSON_PASSED = {
  numTotalTestSuites: 4,
  numPassedTestSuites: 4,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 23,
  numPassedTests: 23,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  snapshot: { added: 0, failure: false, filesAdded: 0, filesRemoved: 0, filesRemovedList: [], filesUnmatched: 0, filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0, updated: 0, didUpdate: false },
  startTime: 1795177442218,
  success: true,
};

/** BOS-1733's pass test, as it stood in the re-run command: kept so the test shows it misses the real coloured line. */
export const OLD_PASS_GREP = /Tests +([0-9]+ [a-z]+ \| )*[0-9]+ passed/;
