// The runner's own pnpm store (BOS-568). Before this, pnpm's own install (in the image) and the start-up
// `pnpm install` in main.ts used a store under the node user's HOME, which is the container's root disk.
// The image's share is about 1.3 GB of packages, so the fix is to point the runner's installs at the same
// shared store every agent install uses and to move what is already there into it, once.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The environment that points the runner's own installs at the shared store. pnpm reads the store's location
 * from `npm_config_store_dir`, the same setting the merge gate and fenced agents get, so every install on the
 * runner — the image's, the runner's start-up one, a check's, an agent's — reaches one physical store (`<dir>/vN`
 * per pnpm major), not a second one nested beside it.
 */
export function storeEnv(shared: string): NodeJS.ProcessEnv {
  return { npm_config_store_dir: shared, PNPM_HOME: path.join(shared, ".pnpm-home") };
}

/** pnpm's store folder for its current major, where the shared store keeps its packages (`<dir>/vN`). */
export const storeRoot = (shared: string) => path.join(shared, "v10");


/**
 * Moves a store pnpm left at the old place into the shared one before the runner's install runs, so its packages
 * are reused rather than downloaded again. Each version folder (pnpm's `vN`) is renamed into the shared store, and
 * only when the shared one has no packages for that version yet; nothing is overwritten. Only a real folder (never
 * a file or a link) is moved. `movedLog` remembers the store last moved (its device and inode), so a start that
 * crashed after the move doesn't try the same one twice.
 */
export function moveStore(old: string, shared: string, movedLog: string, log: (m: string) => void = () => {}) {
  const st = lstatSync(old, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return false;
  if (path.resolve(old).startsWith(path.resolve(shared) + path.sep) || path.resolve(old) === path.resolve(shared)) return false;
  const id = `${st.dev}:${st.ino}`;
  if ((existsSync(movedLog) ? readFileSync(movedLog, "utf8").trim() : "") === id) return false;
  try {
    mkdirSync(shared, { recursive: true });
    let moved = false;
    for (const entry of readdirSync(old)) {
      if (!/^v\d+$/.test(entry)) continue;
      const from = path.join(old, entry);
      const into = path.join(shared, entry);
      if (!lstatSync(from, { throwIfNoEntry: false })?.isDirectory()) continue;
      if (existsSync(into)) continue; // the shared store already has this version; leave its packages alone
      renameSync(from, into);
      moved = true;
    }
    writeFileSync(movedLog, `${id}\n`);
    if (moved) log(`moved the runner's own pnpm store from ${old} into ${shared} (BOS-568)`);
    // Remove the old store once its version folders are gone, so nothing is left on the root disk.
    try {
      if (readdirSync(old).length === 0) rmdirSync(old);
    } catch {
      /* a parallel install may still hold it; harmless */
    }
    return moved;
  } catch (err) {
    log(`couldn't move the runner's own pnpm store from ${old}: ${(err as Error).message}; its packages aren't reused`);
    return false;
  }
}

/** The state the move is remembered in, beside the workspaces volume so it survives a restart. */
export const movedLogFile = (workspacesRoot: string) => path.join(workspacesRoot, ".pnpm-store-moved");

/** pnpm's default store in the node user's HOME, before the shared one (empty in a freshly built image). */
export const oldStoreInHome = (home: string) => path.join(home, ".pnpm-store");
