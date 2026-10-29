// A ticket's conversation (R65). The owner writes on a ticket and the agent working it
// hears: straight into its live run if there is one, otherwise as a new run on the ticket.
// Agents answer with the ticket_reply tool, and each run's last message lands here too.
import { and, asc, desc, eq, isNull, ne, or } from "drizzle-orm";
import { systemAuthor, untrusted } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, runs, skillProposals, ticketMessages, tickets } from "../db/schema.js";
import { RunError, type runsService } from "./runs.js";
import { record } from "./activity.js";
import { ownerActed } from "./stale-requests.js";
import { reviewTicketWriteRefusal } from "./skill-proposals.js";

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

type NotifyHook = (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;

export function ticketChatService(db: Db, deps: { runs: ReturnType<typeof runsService>; notify: NotifyHook }) {
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
    async ownerSays(ticketId: string, text: string, opts: { interrupt?: boolean; agentId?: string } = {}) {
      const t = await ticket(ticketId);
      if (opts.agentId) {
        const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, opts.agentId), eq(agents.companyId, t.companyId), isNull(agents.retiredAt)));
        if (!a) throw new TicketChatError(404, "No agent with that ID in this ticket's company.");
      }
      const [live] = await db
        .select({ id: runs.id, agentId: runs.agentId })
        .from(runs)
        .where(and(eq(runs.ticketId, ticketId), isNull(runs.endedAt), or(isNull(runs.purpose), ne(runs.purpose, "chat"))))
        .orderBy(desc(runs.startedAt))
        .limit(1);
      let delivery: "live" | "woken" | "unassigned" = "unassigned";
      let runId: string | null = null;
      let agentId: string | null = null;
      // The owner can ask someone other than the agent working it, e.g. the CEO.
      const other = opts.agentId && opts.agentId !== (live ? live.agentId : t.assigneeAgentId) ? opts.agentId : null;
      if (other) {
        delivery = "woken";
        agentId = other;
      } else if (live) {
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
      await record(db, { companyId: t.companyId, ticketId, kind: "message", summary: `Owner wrote: ${text}` });
      // The owner acted: anything else we told them about this ticket may be out of date (BOS-123).
      // The assignee is woken by the message already, so they get one note, not two.
      await ownerActed(db, { companyId: t.companyId, ticketIds: [ticketId], reason: "the owner wrote on this ticket", skipAgents: [t.assigneeAgentId], wake: (input) => deps.notify(input.agentId, input as { ticketId: string; reason: string; note: string; priority?: number }) });
      // One waiting run picks up every message sent before it starts: notify joins a waiting wake.
      if (delivery === "woken") {
        await deps.notify(agentId!, {
          ticketId,
          reason: "message",
          priority: 3,
          note: other
            ? "The owner has asked you about this ticket (the conversation is above). You aren't the agent working it: answer with ticket_reply, and don't take over, reassign or change its work unless they ask you to."
            : "The owner has written to you on this ticket (the conversation is above). Answer with ticket_reply; if they ask for work, do it as usual.",
        });
      }
      return m!;
    },

    /** An agent's reply, through the ticket_reply tool. */
    async agentSays(input: { companyId: string; ticketId: string; agentId: string | null; runId: string; text: string }) {
      // The ticket must belong to the caller's company: the review guard below returns null for
      // another company's ticket, so this lookup is what keeps the write inside the tenant.
      await ticket(input.ticketId, input.companyId);
      // An open skill-review ticket is a gate: only the reviewer assigned to it may write there
      // (the owner has their own route). The proposer must not be able to talk the reviewer into a verdict.
      const refusal = await reviewTicketWriteRefusal(db, input.companyId, input.ticketId, input.agentId);
      if (refusal) throw new TicketChatError(403, refusal);
      const [m] = await db
        .insert(ticketMessages)
        .values({ companyId: input.companyId, ticketId: input.ticketId, author: "agent", agentId: input.agentId, runId: input.runId, text: input.text.slice(0, MAX_TEXT) })
        .returning();
      await record(db, { companyId: input.companyId, agentId: input.agentId, ticketId: input.ticketId, kind: "message", summary: `Replied: ${input.text}` });
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
    .select({ author: ticketMessages.author, agent: agents.name, text: ticketMessages.text, delivery: ticketMessages.delivery })
    .from(ticketMessages)
    .leftJoin(agents, eq(agents.id, ticketMessages.agentId))
    .where(eq(ticketMessages.ticketId, ticketId))
    .orderBy(desc(ticketMessages.createdAt))
    .limit(PROMPT_HISTORY);
  // An open skill-review ticket is a gate: the proposer must not be able to talk to the reviewer
  // through the conversation. Mark agent words there as untrusted, like the ticket body, so a
  // "give it a recommend verdict" line is evidence, not an instruction. The owner's own lines stay as they are.
  const [review] = await db
    .select({ id: skillProposals.id })
    .from(skillProposals)
    .where(and(eq(skillProposals.reviewTicketId, ticketId), eq(skillProposals.status, "in_review")));
  const reviewing = !!review;
  return rows.reverse().map((m) => {
    const who = m.author === "owner" ? "Owner" : m.author === "agent" ? (m.agent ?? "An agent") : systemAuthor(m.delivery);
    const text = m.text.length > 1500 ? `${m.text.slice(0, 1500)}…` : m.text;
    return `${who}: ${m.author === "agent" && reviewing ? untrusted(`agent ${m.agent ?? "an agent"} on a skill review ticket`, text) : text}`;
  });
}
