// BOS-2217: how much memory a check machine needs for the checks it is told to run at once. One place, so the
// runner's start-up warning, the server's worker list and the worker form all use the same figure and wording.

/**
 * What one full check really peaks at, in MB. Measured on a real worker (BOS-2215): 3.8 to 4.7 GB per check, so 5 GB
 * is the figure used when the owner has not set "Memory per check". Update it when a new measurement says otherwise.
 */
export const CHECK_PEAK_MB = 5120;
/** What the machine itself (the OS, Docker, the worker process) needs besides its checks. */
export const CHECK_HOST_OVERHEAD_MB = 2048;

/**
 * A plain-words warning when `slots` checks at once, each allowed `perCheckMb` (or the real peak when unset), need more
 * than the machine's memory; null when it fits or the machine has not reported its memory. The per-check figure is a
 * cap each check is held to, so the sum is the most the machine could be asked for.
 */
export function checkMemoryWarning(o: { slots: number; perCheckMb: number | null | undefined; machineMb: number | null | undefined }): string | null {
  if (!o.machineMb || o.machineMb <= 0 || !Number.isFinite(o.slots) || o.slots < 1) return null;
  const per = o.perCheckMb && o.perCheckMb > 0 ? o.perCheckMb : CHECK_PEAK_MB;
  const need = o.slots * per;
  if (need <= o.machineMb) return null;
  const gb = (mb: number) => `${Math.round((mb / 1024) * 10) / 10} GB`;
  const fits = Math.floor(o.machineMb / per);
  const advice = fits >= 1 ? `lower the checks at once to ${fits}, or lower the memory per check` : "lower the memory per check or give the machine more memory";
  return `${o.slots} check${o.slots === 1 ? "" : "s"} at once × ${gb(per)} each is ${gb(need)}, more than the ${gb(o.machineMb)} this machine has: ${advice}. Otherwise the machine can run out of memory before any check's own limit acts, and checks are stopped.`;
}
