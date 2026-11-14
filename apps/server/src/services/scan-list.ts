// The owner's private-details list as the merge-line scan reads it (BOS-979, BOS-1093). A list that can't be read (a
// master-key problem, say) must not stop the line, so the scan runs its secret rules only; but the owner's details then
// go unchecked, so say so: one warning naming the reason (never the values) and one owner notification per failure
// streak, not one per merge. An empty or unset list stays silent.
import type { NotifyLevel } from "@boss-man/shared";

export type ScanListWarning = {
  log?: (msg: string) => void;
  notify?: (input: { level: NotifyLevel; title: string; body: string; link: string }) => Promise<unknown>;
  /** The list is set (only its saved record, never the values): tells "could not be read" from "nothing to read". */
  isSet?: () => Promise<boolean>;
};

export function scanListReader(deps: ScanListWarning & { read: () => Promise<string | null> }) {
  // The streak is in memory on purpose: a restart re-says it once, and it lives only for this server's run.
  // lost on restart, harmless because it only decides whether to repeat the warning
  let failing = false;
  // lost on restart, harmless because it only decides whether the owner was already told
  let told = false;

  /** The list for the runner, or undefined when none can be used. Starts and ends a failure streak. */
  async function forScan(): Promise<string | undefined> {
    let list: string | null;
    try {
      list = await deps.read();
    } catch (err) {
      const reason = (err as Error)?.message || "unknown error";
      const set = deps.isSet ? await deps.isSet().catch(() => true) : true;
      if (!failing) {
        failing = true;
        deps.log?.(`merge-line scan: the owner's private-details list could not be read (${reason}); the scan runs its secret rules only`);
      }
      if (set && !told) {
        told = true;
        await Promise.resolve(
          deps.notify?.({
            level: "note",
            title: "The private-details list couldn't be read",
            body: "Your home details couldn't be checked on merges: the list is saved but the server couldn't read it, so only secret scanning ran. This usually means the server's master key doesn't match the one the list was saved with. Saving the list again in Settings > Server and runner > Private details fixes it. You'll hear again if it breaks after working.",
            link: "#/settings",
          }),
        ).catch(() => {});
      }
      return undefined;
    }
    if (failing) {
      failing = false;
      told = false;
      deps.log?.("merge-line scan: the owner's private-details list can be read again");
    }
    return list ?? undefined;
  }

  return { forScan };
}
