// Stopping one run: the question asked first and the answer shown after, shared by
// the ticket page, the Run page and Settings → Updates so the wording stays one.
import { api } from "./api";

export const stopRunQuestion = (agent?: string | null): string =>
  `Stop ${agent ?? "this agent"}'s run? It stops mid-step, so anything it has not committed yet can be lost.`;

export const stopRunSaid = (endedHere?: boolean): string =>
  endedHere ? "The runner is offline, so Boss Man marked the run as stopped." : "Stopping the run.";

/** Asks first; returns the note to show, or null when the owner said no. */
export async function stopRun(runId: string, agent?: string | null): Promise<string | null> {
  if (!window.confirm(stopRunQuestion(agent))) return null;
  const r = await api<{ endedHere?: boolean }>(`/api/runs/${runId}/cancel`, { method: "POST", body: {} });
  return stopRunSaid(r?.endedHere);
}
