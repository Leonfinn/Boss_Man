// The worker image sets BOSSMAN_SCAN_SCRIPT for the real runner (BOS-979). Tests hand process.env to Workspaces, so inside
// the image every check job ran the scanner first, found no origin/main in the test's tiny repo and stopped before its
// command ran (BOS-1641). Tests of the scan set the variable themselves (check-scan.test.ts); every other test runs
// without it, as on a dev machine.
delete process.env.BOSSMAN_SCAN_SCRIPT;
