// When an after-merge check can be made (BOS-1021): not at merge, but once the merged commit is live on the
// server and, for runner code, once the runners are on an image built from it.

/**
 * Files whose change needs the runners rebuilt. The same rule as RUNNER_PATHS in scripts/host-deployer.sh and
 * needs_runner in scripts/deploy.sh (a test keeps the three equal).
 */
export const RUNNER_CODE_PATHS = /^(apps\/runner\/|apps\/launcher\/|apps\/netguard\/|packages\/shared\/|pnpm-lock\.yaml$)/;

/** True when any of the changed files is runner code. */
export const touchesRunnerCode = (paths: readonly string[]): boolean => paths.some((p) => RUNNER_CODE_PATHS.test(p));

/**
 * The runner-update path (BOS-1467): the script the "Build and update runners" press runs. Runners are built only from
 * the version the server runs, so a fix to it does nothing until the server runs it.
 */
export const RUNNER_UPDATE_PATHS = /^scripts\/update-runner\.sh$/;

/** True when any of the changed files is on the runner-update path. */
export const touchesRunnerUpdate = (paths: readonly string[]): boolean => paths.some((p) => RUNNER_UPDATE_PATHS.test(p));

/**
 * Files the owner must approve before a change to them merges (BOS-1094; CLAUDE.md: the owner approves changes to
 * check-all.sh). A diff that touches one is held at high risk, so the owner's sign-off is needed whatever the card says.
 */
export const OWNER_APPROVED_PATHS: readonly string[] = ["scripts/check-all.sh"];

/** The owner-approved files among the changed ones. */
export const ownerApprovedFiles = (paths: readonly string[]): string[] => paths.filter((p) => OWNER_APPROVED_PATHS.includes(p));

/** What a merged ticket's after-merge checks still wait for: the server deploy, the runner rebuild, or both. */
export type GoLiveWait = "server" | "runner" | "both";

/** Plain words for the board: what "waiting for go-live" is waiting for. */
export const goLiveWaitWords = (w: GoLiveWait): string =>
  w === "both" ? "waiting for go-live: the server update and the runner rebuild" : w === "runner" ? "waiting for go-live: the runner rebuild" : "waiting for go-live: the server update";

/** How long a ticket may wait before the watchdog looks at it again (nobody may have deployed). */
export const GO_LIVE_WAIT_MAX_MS = 3 * 24 * 60 * 60 * 1000;
