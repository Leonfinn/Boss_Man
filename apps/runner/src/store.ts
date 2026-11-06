// The runner's own pnpm store (BOS-568). Before this, pnpm's own install (in the image) and the runner's
// installs used a store under the node user's HOME, which is the container's root disk. The image's share
// is about 1.3 GB of packages, so the runner's installs are pointed at the shared store instead.
//
// The merge gate (an unfenced check, run as the runner's own user) gets a store of its own (BOS-568 review):
// fenced agents may write the shared store, so the gate must not install from it, or a poisoned package file
// in it would run in the gate and could reach the runner token.
import path from "node:path";

/**
 * The environment that points the runner's own installs at the shared store. pnpm reads the store's location
 * from `npm_config_store_dir`, the same setting an agent's install gets, so every install on the runner reaches
 * the one shared store (`<dir>/vN` per pnpm major) rather than a new one in HOME on the root disk.
 */
export function storeEnv(shared: string): NodeJS.ProcessEnv {
  return { npm_config_store_dir: shared };
}

/** The merge gate's own store: the same kind of store, in a folder the fence never grants (see `assertSeparateStore`). */
export const gateStoreDir = (shared: string) => `${shared}-gate`;

/**
 * Refuses a gate store the shared store contains (or that contains it): pnpm links files from the store, so a
 * folder reached through the fence's write grant would let an agent plant a package the gate then runs.
 */
export function assertSeparateStore(shared: string, gate: string) {
  const s = path.resolve(shared);
  const g = path.resolve(gate);
  if (g === s || g.startsWith(s + path.sep) || s.startsWith(g + path.sep)) {
    throw new Error(`the merge gate's pnpm store (${gate}) must be outside the agents' shared store (${shared})`);
  }
}
