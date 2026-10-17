// A ticket's conversation (R65). The owner writes on a ticket and the agent working it
// hears: straight into its live run if there is one, otherwise as a new run on the ticket.
// Agents answer with the ticket_reply tool, and each run's last message lands here too.
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, runs, ticketMessages, tickets, wakes } from "../db/schema.js";
import { RunError, type runsService } from "./runs.js";

/** How many recent messages a run's prompt carries. */
export const PROMPT_HISTORY = 12;
const MAX_TEXT = 8000;

export class TicketChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type WakeHook = (input: { agentId: string; ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;

export function ticketChatService(db: Db, deps: { runs: ReturnType<typeof runsService>; wake: WakeHook }) {
  async function ticket(ticketId: string, companyId?: string) {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!t || (companyId && t.companyId !== companyId)) throw new TicketChatError(404, "No ticket with that ID in your company.");
    return t;
  }

  return {
    async list(ticketId: string) {
      await ticket(ticketId);
      const items = await db
        .select({ id: ticketMessages.id, author: ticketMessages.author, agentId: ticketMessages.agentId, agent: agents.name, runId: ticketMessages.runId, text: ticketMessages.text, delivery: ticketMessages.delivery, createdAt: ticketMessages.createdAt })
        .from(ticketMessages)
        .leftJoin(agents, eq(agents.id, ticketMessages.agentId))
        .where(eq(ticketMessages.ticketId, ticketId))
        .orderBy(asc(ticketMessages.createdAt))
        .limit(500);
      const [live] = await db
        .select({ id: runs.id, agent: agents.name })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .where(and(eq(runs.ticketId, ticketId), isNull(runs.endedAt), or(isNull(runs.purpose), ne(runs.purpose, "chat"))));
      return { items, live: live ?? null };
    },

    /** The owner writes on the ticket; it's stored once it has reached someone (or no one is assigned). */
    async ownerSays(ticketId: string, text: string, opts: { interrupt?: boolean } = {}) {
      const t = await ticket(ticketId);
      const [live] = await db
        .select({ id: runs.id, agentId: runs.agentId })
        .from(runs)
        .where(and(eq(runs.ticketId, ticketId), isNull(runs.endedAt), or(isNull(runs.purpose), ne(runs.purpose, "chat"))))
        .orderBy(desc(runs.startedAt))
        .limit(1);
      let delivery: "live" | "woken" | "unassigned" = "unassigned";
      let runId: string | null = null;
      let agentId: string | null = null;
      if (live) {
        try {
          await deps.runs.message(live.id, { text: `${text}\n\n(Sent on the ticket's conversation. Answer with ticket_reply if a reply is needed before you finish.)`, from: "the owner", interrupt: opts.interrupt ?? false });
          delivery = "live";
          runId = live.id;
          agentId = live.agentId;
        } catch (err) {
          // The runner being offline is the owner's to know about, not a silent loss.
          if (err instanceof RunError) throw new TicketChatError(err.status, err.message);
          throw err;
        }
      } else if (t.assigneeAgentId) {
        delivery = "woken";
        agentId = t.assigneeAgentId;
      }
      // Stored before the wake, so the new run's prompt already carries it.
      const [m] = await db.insert(ticketMessages).values({ companyId: t.companyId, ticketId, author: "owner", agentId, runId, text, delivery }).returning();
      // One waiting run picks up every message sent before it starts.
      const [waiting] =
        delivery === "woken"
          ? await db.select({ id: wakes.id }).from(wakes).where(and(eq(wakes.agentId, agentId!), eq(wakes.ticketId, ticketId), inArray(wakes.status, ["queued", "deferred"])))
          : [];
      if (delivery === "woken" && !waiting) {
        await deps.wake({
          agentId: agentId!,
          ticketId,
          reason: "message",
          priority: 3,
          note: "The owner has written to you on this ticket (the conversation is above). Answer with ticket_reply; if they ask for work, do it as usual.",
        });
      }
      return m!;
    },

    /** An agent's reply, through the ticket_reply tool. */
    async agentSays(input: { companyId: string; ticketId: string; agentId: string | null; runId: string; text: string }) {
      await ticket(input.ticketId, input.companyId);
      const [m] = await db
        .insert(ticketMessages)
        .values({ companyId: input.companyId, ticketId: input.ticketId, author: "agent", agentId: input.agentId, runId: input.runId, text: input.text.slice(0, MAX_TEXT) })
        .returning();
      return m!;
    },

    /** A ticket run's closing message joins the conversation, so the owner sees what it said. */
    async onAgentMessage(runId: string, text: string) {
      if (!text.trim()) return;
      const [r] = await db.select({ companyId: runs.companyId, ticketId: runs.ticketId, agentId: runs.agentId, purpose: runs.purpose }).from(runs).where(eq(runs.id, runId));
      if (!r?.ticketId || r.purpose === "chat") return;
      await db.insert(ticketMessages).values({ companyId: r.companyId, ticketId: r.ticketId, author: "agent", agentId: r.agentId, runId, text: text.slice(0, MAX_TEXT), delivery: "end_of_run" });
    },

  };
}

/** The ticket's recent conversation, oldest first, as lines for a run's prompt. */
export async function conversationLines(db: Db, ticketId: string) {
  const rows = await db
    .select({ author: ticketMessages.author, agent: agents.name, text: ticketMessages.text })
    .from(ticketMessages)
    .leftJoin(agents, eq(agents.id, ticketMessages.agentId))
    .where(eq(ticketMessages.ticketId, ticketId))
    .orderBy(desc(ticketMessages.createdAt))
    .limit(PROMPT_HISTORY);
  return rows.reverse().map((m) => `${m.author === "owner" ? "Owner" : m.author === "agent" ? (m.agent ?? "An agent") : "Boss Man"}: ${m.text.length > 1500 ? `${m.text.slice(0, 1500)}…` : m.text}`);
}
