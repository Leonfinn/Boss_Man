// The owner chat (v1.1). The owner writes in plain language; a run answers with board tools
// only, turning the request into tickets, milestones and links between tickets. It runs as
// the company's CEO (its model and funding) but in its own empty folder, with no workspace,
// outside the CEO's chapters, and every tool except Boss Man's board tools is refused.
import path from "node:path";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companies, ownerChatMessages, runs, wakes } from "../db/schema.js";

export const CHAT_REASON = "owner_chat";
const HISTORY = 30;

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function chatService(db: Db, deps: { wake: (input: { agentId: string; reason: string; priority: number }) => Promise<unknown>; workspaceRoot: string }) {
  return {
    async send(companyId: string, text: string) {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
      if (!ceo) throw new ChatError(409, "This company has no CEO to answer.");
      const [m] = await db.insert(ownerChatMessages).values({ companyId, role: "owner", text }).returning();
      // One chat run at a time per company picks up everything sent so far.
      const [waiting] = await db
        .select({ id: wakes.id })
        .from(wakes)
        .where(and(eq(wakes.companyId, companyId), eq(wakes.reason, CHAT_REASON), inArray(wakes.status, ["queued", "deferred"])));
      if (!waiting) await deps.wake({ agentId: ceo.id, reason: CHAT_REASON, priority: 4 });
      return m!;
    },

    async list(companyId: string) {
      const items = await db.select().from(ownerChatMessages).where(eq(ownerChatMessages.companyId, companyId)).orderBy(desc(ownerChatMessages.createdAt)).limit(200);
      const [queued] = await db
        .select({ id: wakes.id, status: wakes.status, reason: wakes.statusReason })
        .from(wakes)
        .where(and(eq(wakes.companyId, companyId), eq(wakes.reason, CHAT_REASON), inArray(wakes.status, ["queued", "deferred"])));
      const [running] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.companyId, companyId), eq(runs.purpose, "chat"), isNull(runs.endedAt)));
      return { items: items.reverse(), state: running ? "answering" : queued ? (queued.status === "deferred" ? `waiting: ${queued.reason ?? "deferred"}` : "queued") : "idle" };
    },

    cwd: (companyId: string) => path.posix.join(deps.workspaceRoot, "chat", companyId),

    /** The run's prompt: the conversation so far and what it's for. */
    async prompt(companyId: string) {
      const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      const recent = (await db.select().from(ownerChatMessages).where(eq(ownerChatMessages.companyId, companyId)).orderBy(desc(ownerChatMessages.createdAt)).limit(HISTORY)).reverse();
      return [
        `You are the board assistant for ${company?.name ?? "this company"} in Boss Man. The owner writes to you in plain language; you turn what they ask into work on the board.`,
        "",
        "Your tools are Boss Man's board tools only: board (projects, objectives and milestones, agents, open tickets), create_ticket, link_tickets (one ticket waits on another) and set_milestone. You can't read or change code, run commands or browse; any other tool will be refused.",
        "- Look at the board first, so you reuse existing tickets and milestones instead of making duplicates.",
        "- Rate each ticket's risk honestly. Assign an agent only if the owner says who, or it's obvious.",
        "- If the request is ambiguous, ask one short question instead of guessing.",
        "- End with a short reply that lists everything you created or changed, each as `#/tickets/<id>` followed by its title, so the owner can open it.",
        "",
        "The conversation so far, oldest first:",
        ...recent.map((m) => `${m.role === "owner" ? "Owner" : m.role === "assistant" ? "You" : "Boss Man"}: ${m.text}`),
      ].join("\n");
    },

    /** Marks the owner's messages that this run answers, once its row exists. */
    async claim(companyId: string, runId: string) {
      await db.update(ownerChatMessages).set({ runId }).where(and(eq(ownerChatMessages.companyId, companyId), eq(ownerChatMessages.role, "owner"), isNull(ownerChatMessages.runId)));
    },

    /** The answering run's final message becomes the assistant's reply. */
    async onAgentMessage(runId: string, text: string) {
      const [r] = await db.select({ companyId: runs.companyId, purpose: runs.purpose }).from(runs).where(eq(runs.id, runId));
      if (r?.purpose !== "chat") return;
      await db.insert(ownerChatMessages).values({ companyId: r.companyId, role: "assistant", text, runId });
    },

    async onRunEnded(runId: string, error: string | null) {
      const [r] = await db.select({ companyId: runs.companyId, purpose: runs.purpose }).from(runs).where(eq(runs.id, runId));
      if (r?.purpose !== "chat" || !error) return;
      await db.insert(ownerChatMessages).values({ companyId: r.companyId, role: "system", text: `The assistant couldn't finish: ${error.slice(0, 500)}`, runId });
    },
  };
}
