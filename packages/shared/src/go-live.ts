// When an after-merge check can be made (BOS-1021): not at merge, but once the merged commit is live on the
// server and, for runner code, once the runners are on an image built from it.

/**
 * What "Build and update runners" builds from (BOS-1648): the Dockerfiles of the three images it builds (runner,
 * launcher, netguard) and every repository path their COPY lines take in. A path ending in "/" is a folder. Read from
 * the build, not chosen by hand: apps/server/test/runner-build-inputs.test.ts parses the Dockerfiles and fails when
 * this list and their COPY lines differ, so a new COPY can't be missed. Tests, docs and anything else in those
 * folders that no COPY takes in can't change an image, so they don't count.
 */
export const RUNNER_BUILD_INPUTS: readonly string[] = [
  "apps/runner/Dockerfile",
  "apps/runner/package.json",
  "apps/runner/src/",
  "apps/runner/claude-pack/",
  "apps/launcher/Dockerfile",
  "apps/launcher/package.json",
  "apps/launcher/tsconfig.json",
  "apps/launcher/tsconfig.build.json",
  "apps/launcher/src/",
  "apps/netguard/Dockerfile",
  "apps/netguard/netguard.sh",
  "packages/shared/package.json",
  "packages/shared/src/",
  "scripts/check-slot.sh",
  "scripts/scan-added-lines.mjs",
  "scripts/scan-allow.txt",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
  "NOTICE",
];

/**
 * Files whose change needs the runners rebuilt: RUNNER_BUILD_INPUTS as one pattern. The same rule as RUNNER_PATHS in
 * scripts/host-deployer.sh and needs_runner in scripts/deploy.sh (tests keep the three equal).
 */
export const RUNNER_CODE_PATHS = new RegExp(`^(${RUNNER_BUILD_INPUTS.map((p) => (p.endsWith("/") ? p : `${p}$`).replace(/\./g, "\\.")).join("|")})`);

/**
 * True when any of the changed files is runner code that ships in the runner image. Tests and test config under
 * apps/runner (or packages/shared) are not: the image copies only src, so a rebuild carries nothing from them
 * (BOS-1693: BOS-1641, a merge-check fix that changed runner tests, held ~35 merges waiting for a rebuild that
 * would have changed nothing). Deliberately narrower than RUNNER_PATHS in the deploy scripts: those decide whether
 * to rebuild, where an extra rebuild is harmless; this decides whether to wait for one, where a needless wait hangs.
 */
export const touchesRunnerCode = (paths: readonly string[]): boolean => paths.some((p) => RUNNER_CODE_PATHS.test(p) && !NO_DEPLOY_PATHS.test(p));

/**
 * The runner-update path (BOS-1467): the script the "Build and update runners" press runs. Runners are built only from
 * the version the server runs, so a fix to it does nothing until the server runs it.
 */
export const RUNNER_UPDATE_PATHS = /^scripts\/update-runner\.sh$/;

/** True when any of the changed files is on the runner-update path. */
export const touchesRunnerUpdate = (paths: readonly string[]): boolean => paths.some((p) => RUNNER_UPDATE_PATHS.test(p));

/**
 * Files that never go live through a server deploy or a runner rebuild (BOS-1609): tests, docs and CI workflows. They
 * take effect the moment they are on main (the merge gate and CI read them from the tree they check). Deliberately
 * narrow: scripts, configs and anything else count as needing a deploy. Markdown counts only at the repository root
 * (README.md, CLAUDE.md, ...) and under docs/: a .md inside an app (apps/runner/claude-pack, skills) can ship in an image.
 * A package's vitest config only steers its tests (BOS-1693).
 */
export const NO_DEPLOY_PATHS = /(^|\/)(test|tests|__tests__)\/|\.test\.[a-z]+$|^docs\/|^[^/]+\.md$|^\.github\/|(^|\/)vitest\.(config|workspace)\.[cm]?[jt]s$/;

/** True when the file list is known, non-empty, and every file is a test, a doc or CI: the merge needs no deploy. */
export const deploysNothing = (paths: readonly string[]): boolean => paths.length > 0 && paths.every((p) => NO_DEPLOY_PATHS.test(p));

/**
 * Files the owner must approve before a change to them merges (BOS-1094, widened by BOS-1100). A diff that touches one is
 * held at high risk, so the owner's sign-off is needed whatever the card says.
 *
 * The merge gate itself (scripts/check-all.sh) and the pieces it runs from the branch's own tree to decide what it
 * checks and whether the run passed: the shell lint and shell tests, the thread budget that sizes a run, the
 * migration lint, the in-memory state check, and the two checks that can fail a run outright (memory ceiling and
 * skipped tests). A branch that edits one of these can weaken the gate that is about to merge it, so each needs the
 * owner's eyes. CLAUDE.md is here because it sets the rules the team works by (the full-check and test rules): a
 * change to it changes what "before you hand work in" means, so the owner approves it too.
 *
 * scripts/check-quick.sh is deliberately not here: it is the quick gate an agent runs before review, and the merge
 * gate always runs the full check (check-all.sh) whatever it says, so changing it cannot merge unreviewed code.
 */
export const OWNER_APPROVED_PATHS: readonly string[] = [
  "scripts/check-all.sh",
  "scripts/check-shell.sh",
  "scripts/test-shell.sh",
  "scripts/check-threads.mjs",
  "scripts/check-in-memory-state.mjs",
  "scripts/lint-migrations.mjs",
  "scripts/check-mem-guard.mjs",
  "scripts/check-no-skips.mjs",
  "CLAUDE.md",
];

/** The owner-approved files among the changed ones. */
export const ownerApprovedFiles = (paths: readonly string[]): string[] => paths.filter((p) => OWNER_APPROVED_PATHS.includes(p));

/**
 * What a merged ticket's after-merge checks still wait for: the server deploy, the runner rebuild, or both; or,
 * for a company Boss Man's server doesn't put live (BOS-1345), its CEO marking the ticket live ("own").
 */
export type GoLiveWait = "server" | "runner" | "both" | "own";

/** Plain words for the board: what "waiting for go-live" is waiting for. */
export const goLiveWaitWords = (w: GoLiveWait): string =>
  w === "own"
    ? "waiting for go-live: the CEO to mark it live (this company puts its own work live)"
    : w === "both"
      ? "waiting for go-live: the server update and the runner rebuild"
      : w === "runner"
        ? "waiting for go-live: the runner rebuild"
        : "waiting for go-live: the server update";

/** How long a ticket may wait before the watchdog looks at it again (nobody may have deployed). */
export const GO_LIVE_WAIT_MAX_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * BOS-1636: a merged ticket parked in Blocked only for its after-merge (live) check, whether it still waits for the
 * server update or runner rebuild (goLiveWait) or the merge is already live and an agent or the owner's card has the
 * check. It is not stuck, so the board shows it in its own lane and the "N blocked" counts leave it out. The one rule;
 * the server's SQL twin is liveCheckWaitSql (services/go-live-note.ts).
 */
/**
 * BOS-1907: the lane is "Merged, watching". It holds a ticket with a merge in Blocked, and also one still in In progress
 * (merged before this change; it never counts toward a limit either), and a split-out check ticket (checksCriterion) whose
 * parent is merged and not done (`checksParentMerged`, set by the server from the parent link).
 */
export const isLiveCheckWait = (t: { systemState: string; mergeCommit?: string | null; checksParentMerged?: boolean | null }): boolean =>
  (t.systemState === "blocked" || t.systemState === "in_progress") && (!!t.mergeCommit || !!t.checksParentMerged);

/** BOS-1907: days a merged ticket is watched when the agent gave no end date for an open-ended event. */
export const WATCH_DEFAULT_DAYS = 14;
/** BOS-1907: the furthest ahead an agent may set a watch's end date. */
export const WATCH_MAX_DAYS = 60;

/**
 * When a merged ticket's watch ends: the date the agent recorded, else WATCH_DEFAULT_DAYS after go-live (or after the merge
 * when no go-live was recorded; existing rows have neither a watch date nor a go-live time). Null for a ticket that never merged.
 */
export function watchEndsAt(t: { watchUntil?: Date | string | null; liveAt?: Date | string | null; mergedAt?: Date | string | null }): Date | null {
  if (t.watchUntil) return new Date(t.watchUntil);
  const from = t.liveAt ?? t.mergedAt;
  return from ? new Date(new Date(from).getTime() + WATCH_DEFAULT_DAYS * 24 * 60 * 60 * 1000) : null;
}
