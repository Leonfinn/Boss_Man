// The runner's own pnpm store (BOS-568). Before this, pnpm's own install (in the image) and the start-up
// `pnpm install` in main.ts used a store under the node user's HOME, which is the container's root disk.
// The image's share is about 1.3 GB of packages, so the fix is to point the runner's installs at the shared
// store too and to move what is already there, once. Nothing here is on a path an agent's install writes.
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * PNPM_HOME for the runner's own installs. pnpm puts its store under `$PNPM_HOME/store` when PNPM_STORE_DIR
 * is unset, so the store keeps pnpm's versioned layout and stays one folder for both installs.
 */
export function storeEnv(shared: string): NodeJS.ProcessEnv {
  return { PNPM_HOME: path.join(shared, ".pnpm-home") };
}

/** The store pnpm uses under that PNPM_HOME (its `store` subfolder, where each version has its `vN`). */
export const storeUnderPnpmHome = (shared: string) => path.join(shared, ".pnpm-home", "store");


/**
 * Moves a store found at the old place into the shared one before the runner's install runs, so its packages
 * aren't downloaded again. Only a real folder (never a file or a link) is moved; the move is a rename inside
 * the workspaces volume where it can be, and removes nothing when it fails. `movedLog` remembers the last store
 * moved (its device and inode), so a start that crashed after the move doesn't move the same one twice.
 */
export function moveStore(old: string, shared: string, movedLog: string, log: (m: string) => void = () => {}) {
  const st = lstatSync(old, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return false;
  if (path.resolve(old) === path.resolve(shared)) return false;
  const id = `${st.dev}:${st.ino}`;
  if ((existsSync(movedLog) ? readFileSync(movedLog, "utf8").trim() : "") === id) return false;
  const into = path.join(shared, `moved-${Date.now().toString(36)}`);
  try {
    mkdirSync(path.dirname(into), { recursive: true });
    renameSync(old, into);
    writeFileSync(movedLog, `${id}\n`);
    log(`moved the runner's own pnpm store from ${old} to ${into} (BOS-568)`);
    return true;
  } catch (err) {
    log(`couldn't move the runner's own pnpm store from ${old}: ${(err as Error).message}; its packages aren't reused`);
    return false;
  }
}

/** The state the move is remembered in, beside the workspaces volume so it survives a restart. */
export const movedLogFile = (workspacesRoot: string) => path.join(workspacesRoot, ".pnpm-store-moved");

/** pnpm's default store in the node user's HOME, before the shared one (empty in a freshly built image). */
export const oldStoreInHome = (home: string) => path.join(home, ".pnpm-store");

