// The runner's OpenCode session prune makes one VACUUM per database, holding new OpenCode runs while
// it works (BOS-616). Past its cap the runner kills it and lets the runs go (BOS-622); this turns that
// report into one CEO card per runner per day, so a VACUUM that keeps failing is seen by a person.
import type { RunnerEvent } from "@boss-man/shared";
import type { AlertInput } from "./alert-ladder.js";

type Cut = Omit<Extract<RunnerEvent, { type: "runner.opencode_vacuum_cut" }>, "type">;

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function opencodeVacuumAlerts(deps: { alert: (input: AlertInput) => Promise<unknown> }) {
  return {
    async onCut(runner: { id: string; companyId: string }, cut: Cut, at: Date) {
      const which = cut.agentHome ? "a fenced agent's own OpenCode database" : "the runner's OpenCode database";
      const minutes = Math.max(1, Math.round(cut.heldSeconds / 60));
      await deps.alert({
        companyId: runner.companyId,
        kind: "opencode_vacuum_cut",
        from: "ceo",
        why: "a runner housekeeping problem: only the CEO or an infra engineer can look into it",
        question:
          `The runner stopped the one-off compaction (VACUUM) of ${which} (${gb(cut.bytes)}) after ${minutes} min, because it held every new OpenCode run for that long. ` +
          `OpenCode runs are going again, and SQLite undid the half-done compaction, so no data is lost; old sessions are still deleted, but the file doesn't shrink. ` +
          `The runner tries again in a day. If this card comes back, ask an infra engineer to check the runner's disk speed and free space (the runner log says which database), ` +
          `or turn the session clean-up off with BOSSMAN_OPENCODE_SESSION_DAYS=0.`,
        dedupeKey: `opencode-vacuum:${runner.id}:${at.toISOString().slice(0, 10)}`,
      });
    },
  };
}
