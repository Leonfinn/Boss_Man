// The owner chat (v1.1, R70). The owner messages the CEO, or any agent directly, in plain
// language; a run answers with board tools only, turning the request into tickets,
// milestones and links between tickets. It runs as that agent (its model and funding) but in
// its own empty folder, with no workspace, outside the CEO's chapters, and every tool except
// Boss Man's board tools is refused. Each agent has its own conversation and answers one
// message batch at a time.
import path from "node:path";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { agentIdentity } from "@boss-man/shared";
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

type Agent = typeof agents.$inferSelect;

export function chatService(db: Db, deps: { notify: (agentId: string, input: { reason: string; priority: number }) => Promise<unknown>; workspaceRoot: string }) {
  async function agentOf(companyId: string, agentId: string): Promise<Agent> {
    const [a] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    if (!a) throw new ChatError(404, "No such agent in this company.");
    return a;
  }

  /** Who answers a message: the agent named, else the company's PA, else its CEO. A PA that is paused or retired is skipped, so the CEO answers (R87). */
  async function who(companyId: string, agentId?: string | null): Promise<Agent> {
    const team = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const ceo = team.find((a) => a.role === "ceo");
    const pa = team.find((a) => a.duty === "assistant" && !a.paused && !a.retiredAt);
    const named = agentId ? team.find((a) => a.id === agentId) : undefined;
    if (agentId && !named) throw new ChatError(404, "No such agent in this company.");
    const a = named ? (named.duty === "assistant" && !pa ? ceo : named) : (pa ?? ceo);
    if (!a) throw new ChatError(409, "This company has no CEO to answer.");
    return a;
  }

  /** What the agent's chat is doing: answering, waiting to start, or idle. */
  async function state(companyId: string, agentId: string) {
    const [queued] = await db
      .select({ id: wakes.id, status: wakes.status, reason: wakes.statusReason })
      .from(wakes)
      .where(and(eq(wakes.agentId, agentId), eq(wakes.reason, CHAT_REASON), inArray(wakes.status, ["queued", "deferred"])));
    const [running] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.companyId, companyId), eq(runs.agentId, agentId), eq(runs.purpose, "chat"), isNull(runs.endedAt)));
    return running ? "answering" : queued ? (queued.status === "deferred" ? `waiting: ${queued.reason ?? "deferred"}` : "queued") : "idle";
  }

  return {
    async send(companyId: string, text: string, agentId?: string | null) {
      const agent = await who(companyId, agentId);
      const [m] = await db.insert(ownerChatMessages).values({ companyId, agentId: agent.id, role: "owner", text }).returning();
      // One chat run at a time per agent picks up everything sent to it so far: notify joins a waiting wake.
      await deps.notify(agent.id, { reason: CHAT_REASON, priority: 4 });
      return m!;
    },

    async list(companyId: string, agentId?: string | null) {
      const agent = agentId ? await agentOf(companyId, agentId) : await who(companyId);
      const items = await db
        .select()
        .from(ownerChatMessages)
        .where(and(eq(ownerChatMessages.companyId, companyId), eq(ownerChatMessages.agentId, agent.id)))
        .orderBy(desc(ownerChatMessages.createdAt))
        .limit(200);
      return { agentId: agent.id, items: items.reverse(), state: await state(companyId, agent.id) };
    },

    /** Everyone the owner can message, CEO first, each with their last message and what they're doing. */
    async threads(companyId: string) {
      const team = await db.select({ id: agents.id, name: agents.name, role: agents.role, duty: agents.duty, paused: agents.paused, retired: agents.retiredAt }).from(agents).where(eq(agents.companyId, companyId));
      const last = team.length
        ? await db
            .selectDistinctOn([ownerChatMessages.agentId], { agentId: ownerChatMessages.agentId, role: ownerChatMessages.role, text: ownerChatMessages.text, createdAt: ownerChatMessages.createdAt })
            .from(ownerChatMessages)
            .where(and(eq(ownerChatMessages.companyId, companyId), inArray(ownerChatMessages.agentId, team.map((a) => a.id))))
            .orderBy(ownerChatMessages.agentId, desc(ownerChatMessages.createdAt))
        : [];
      const byAgent = new Map(last.map((m) => [m.agentId, m]));
      // An active PA is the owner's first conversation, the CEO next (R87).
      const rank = (a: (typeof team)[number]) => (a.duty === "assistant" && !a.paused && !a.retired ? -1 : { ceo: 0, manager: 1, worker: 2 }[a.role]);
      const rows = await Promise.all(
        team.map(async (a) => {
          const m = byAgent.get(a.id);
          return { ...a, last: m ? { role: m.role, text: m.text.slice(0, 140), createdAt: m.createdAt } : null, state: await state(companyId, a.id) };
        }),
      );
      return rows.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name)).map(({ paused, retired, ...a }) => a);
    },

    cwd: (companyId: string, agentId: string) => path.posix.join(deps.workspaceRoot, "chat", companyId, agentId),

    /** The run's prompt: the conversation so far and what it's for. */
    async prompt(companyId: string, agentId: string) {
      const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      const agent = await agentOf(companyId, agentId);
      const recent = (
        await db
          .select()
          .from(ownerChatMessages)
          .where(and(eq(ownerChatMessages.companyId, companyId), eq(ownerChatMessages.agentId, agentId)))
          .orderBy(desc(ownerChatMessages.createdAt))
          .limit(HISTORY)
      ).reverse();
      const ceo = agent.role === "ceo";
      if (agent.duty === "assistant") return paPrompt(agent, company?.name ?? "this company", recent);
      return [
        ceo
          ? `You are ${agent.name}, the CEO of ${company?.name ?? "this company"}, chatting with the owner in Boss Man. The owner writes to you in plain language; you turn what they ask into work on the board.`
          : `You are ${agentIdentity(agent, company?.name ?? "this company").who}. The owner is messaging you directly in Boss Man's chat. Answer their questions about your work, and turn what they ask for into work on the board.`,
        ...agentIdentity(agent, company?.name ?? "this company").instructions,
        "",
        "In this chat your tools are Boss Man's: board (projects, objectives and milestones, agents, open tickets), tickets (find any ticket, read it in full with what it produced, and read files from its work in the repo), create_ticket, link_tickets (one ticket waits on another), set_milestone, features (the feature requests, by priority), log_feedback (file feedback the owner passes on), wiki (read, write and file the company's pages) skills (the skill library; the CEO can give and take them), propose_hire and update_instructions (the CEO builds the team: a hire waits for the owner's approval unless they've said otherwise), and propose_team (when the owner asks for a team or a project needs one: one decision listing every proposed hire, with skills). You can't read or change code, run commands or browse; Claude's own file and shell tools are off here. Work that needs code happens on tickets, so create a ticket (assigned to the right agent) rather than promising to do it here.",
        "- Use your tools before saying you can't see something: look tickets up with tickets, and pages up with wiki. If you can resolve something yourself, do it now rather than leaving a note that someone should.",
        "- Look at the board first, so you reuse existing tickets and milestones instead of making duplicates.",
        "- Rate each ticket's risk honestly. Assign an agent only if the owner says who, or it's obvious. When a ticket delivers a feature request, pass its featureId.",
        "- When the owner passes on what someone else said (a customer's email, a call), file it with log_feedback as they said it, rather than turning it straight into tickets.",
        "- If the request is ambiguous, ask one short question instead of guessing.",
        "- When your answer is substantial (an analysis, a comparison, research into options), also save it as a wiki page (Product/Analysis, or the folder it belongs in) and link it, so it isn't lost in the chat.",
        "- End with a short reply that lists everything you created or changed, each as `#/tickets/<id>` followed by its title, so the owner can open it.",
        "",
        "The conversation so far, oldest first:",
        ...recent.map((m) => `${m.role === "owner" ? "Owner" : m.role === "assistant" ? "You" : "Boss Man"}: ${m.text}`),
      ].join("\n");
    },

    /** Marks the owner's messages that this run answers, once its row exists. */
    async claim(companyId: string, agentId: string, runId: string) {
      await db
        .update(ownerChatMessages)
        .set({ runId })
        .where(and(eq(ownerChatMessages.companyId, companyId), eq(ownerChatMessages.agentId, agentId), eq(ownerChatMessages.role, "owner"), isNull(ownerChatMessages.runId)));
    },

    /** The answering run's final message becomes the agent's reply. */
    async onAgentMessage(runId: string, text: string) {
      const [r] = await db.select({ companyId: runs.companyId, agentId: runs.agentId, purpose: runs.purpose, duty: agents.duty }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).where(eq(runs.id, runId));
      // The PA speaks only through pa_reply, which is checked; its own closing text never reaches the owner (R87).
      if (r?.purpose !== "chat" || r.duty === "assistant") return;
      await db.insert(ownerChatMessages).values({ companyId: r.companyId, agentId: r.agentId, role: "assistant", text, runId });
    },

    async onRunEnded(runId: string, error: string | null) {
      const [r] = await db.select({ companyId: runs.companyId, agentId: runs.agentId, purpose: runs.purpose }).from(runs).where(eq(runs.id, runId));
      if (r?.purpose !== "chat" || !error) return;
      await db.insert(ownerChatMessages).values({ companyId: r.companyId, agentId: r.agentId, role: "system", text: `The reply couldn't be finished: ${error.slice(0, 500)}`, runId });
    },
  };
}

const speaker = (role: string) => (role === "owner" ? "Owner" : role === "assistant" ? "You" : "Boss Man");

/** The PA's chat prompt (R87): what it may use, and that pa_reply is the only way to answer. */
function paPrompt(agent: Agent, company: string, recent: Array<{ role: string; text: string }>) {
  return [
    `You are ${agentIdentity(agent, company).who}, chatting with the owner in Boss Man.`,
    ...agentIdentity(agent, company).instructions,
    "",
    "Your tools are read-only: tickets (find and read), decisions (what is waiting on someone), list_my_work, board, whats_new and wiki (list and read). You can't create or change anything.",
    "- Look the answer up with your tools first, then answer the owner's LAST message with pa_reply: text, cites (the tickets and decisions your answer rests on, each with its id; empty is fine for a \"nothing found\" answer after you searched tickets or decisions) and confidence (high only when the tools show it plainly). Your closing text is not shown to the owner; pa_reply is the only way you answer.",
    "- Boss Man checks every reply in code. It escalates to the CEO instead of posting when you cite an id no tool showed you, cite nothing without having searched, are unsure, or the question asks for judgement (why, should, plans, priorities, money, risk, deploys, hiring). If you can't answer from what the tools return, call pa_escalate with a short summary of what you found.",
    "",
    "The conversation so far, oldest first:",
    ...recent.map((m) => `${speaker(m.role)}: ${m.text}`),
  ].join("\n");
}
