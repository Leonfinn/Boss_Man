// Recovery after a runner restart (R42). An interrupted run is picked up by a new run for
// the same agent and ticket. Claude tries to reopen the old session; anything else starts
// fresh. Either way, the prompt lists what Boss Man saw the agent finish, because a
// resumed session can repeat steps it took after its last save (spike S4).
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runnerEvents, runs, wakes } from "../db/schema.js";
import { CHAT_REASON } from "./chat.js";

type WakeHook = (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number; causedByRunId?: string | null; resumeRunId?: string | null }) => Promise<unknown>;

export function recoveryService(db: Db) {
  let wake: WakeHook | null = null;

  /** What the run is known to have finished: completed tool calls, in order, deduplicated. */
  async function finishedSteps(runId: string): Promise<string[]> {
    const rows = await db
      .select({ payload: runnerEvents.payload })
      .from(runnerEvents)
      .where(and(eq(runnerEvents.type, "run.update"), sql`${runnerEvents.payload}->>'runId' = ${runId}`))
      .orderBy(asc(runnerEvents.seq));
    const steps: string[] = [];
    for (const { payload } of rows) {
      const u = (payload as { update?: { kind?: string; status?: string; title?: string | null } }).update;
      if (u?.kind === "tool_call_update" && u.status === "completed" && u.title && steps.at(-1) !== u.title) steps.push(u.title);
    }
    return steps;
  }

  return {
    setWakeHook(hook: WakeHook) {
      wake = hook;
    },

    finishedSteps,

    /** Queues the recovery run for an interrupted run. */
    async onInterrupted(runId: string) {
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run?.agentId || !wake) return null;
      // An interrupted owner chat run is simply asked again; it only ever touched the board.
      if (run.purpose === "chat") return wake({ agentId: run.agentId, reason: CHAT_REASON, note: "", priority: 4, causedByRunId: runId });
      // A deploy's run is not picked up: its deploy failed when the run ended, and only a new approval restarts it (BOS-480).
      const [deploy] = await db.select({ id: wakes.id }).from(wakes).where(and(eq(wakes.runId, runId), isNotNull(wakes.deployId))).limit(1);
      if (deploy) return null;
      const steps = await finishedSteps(runId);
      // A run the server closed because its runner went offline and never reported it (BOS-574).
      const lost = run.outcome?.startsWith("lost:");
      const note = [
        lost ? "Your previous run was cut off when the runner went offline, and this run picks it up." : "Your previous run was interrupted when the runner restarted, and this run picks it up.",
        steps.length
          ? `Boss Man saw you finish these steps before the interruption:\n${steps.slice(-30).map((s, i) => `${i + 1}. ${s}`).join("\n")}`
          : "Boss Man saw no finished steps before the interruption.",
        "Steps after your last save may not have happened, or may have happened without you seeing the result. Before redoing anything with side effects (files, commits, tickets, deploys), check whether it already happened.",
      ].join("\n\n");
      return wake({ agentId: run.agentId, ticketId: run.ticketId, reason: "resume", priority: 3, note, resumeRunId: runId });
    },
  };
}
