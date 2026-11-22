// The worker image sets BOSSMAN_SCAN_SCRIPT for the real runner (BOS-979). Tests hand process.env to Workspaces, so inside
// the image every check job ran the scanner first, found no origin/main in the test's tiny repo and stopped before its
// command ran (BOS-1641). Tests of the scan set the variable themselves (check-scan.test.ts); every other test runs
// without it, as on a dev machine.
delete process.env.BOSSMAN_SCAN_SCRIPT;

// Git's automatic maintenance runs detached after a commit or fetch and can still be writing (or pruning empty object
// folders) when a test deletes or reads its temp repo: ENOTEMPTY on removal, "unable to create temporary file" in
// merge-tree (BOS-1761, BOS-1709). No test needs it, so every git a test starts runs with it off. Workspaces adds its
// own GIT_CONFIG_* entries after these, so the two lists don't clash. Workspaces builds its git env from scratch (it never
// reads these), so BOSSMAN_GIT_NO_MAINTENANCE tells it to add the same two settings (the first fix missed this, BOS-1761).
process.env.BOSSMAN_GIT_NO_MAINTENANCE = "1";
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
});
