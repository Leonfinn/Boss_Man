// The owner chat (v1.1, R70). The owner messages the CEO, or any agent directly, in plain
// language; a run answers with board tools only, turning the request into tickets,
// milestones and links between tickets. It runs as that agent (its model and funding) but in
// its own empty folder, with no workspace, outside the CEO's chapters, and every tool except
// Boss Man's board tools is refused. Each agent has its own conversation and answers one
// message batch at a time.
import path from "node:path";
import { and, count, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { agentIdentity } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, decisions, ownerChatMessages, projects, runs, wakes } from "../db/schema.js";
import { ceoNotesLines, NOTE_LIMITS } from "./agent-notes.js";
import { missingPageNote } from "./wiki.js";

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
  // shortcut: replies being saved, by run, so the end-of-run check sees them; lost on restart, harmless because a run dies with the restart.
  const saving = new Map<string, Promise<unknown>>();
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
    // A queued wake with a reason is held (agent or company paused, a limit, a runner update), not just waiting for the runner.
    return running ? "answering" : queued ? (queued.status === "deferred" || queued.reason ? `waiting: ${queued.reason ?? "deferred"}` : "queued") : "idle";
  }

  return {
    async send(companyId: string, text: string, agentId?: string | null) {
      const agent = await who(companyId, agentId);
      const [m] = await db.insert(ownerChatMessages).values({ companyId, agentId: agent.id, role: "owner", text }).returning();
      // One chat run at a time per agent picks up everything sent to it so far: notify joins a waiting wake.
      await deps.notify(agent.id, { reason: CHAT_REASON, priority: 4 });
      return m!;
    },

    /** The owner's draft task or feature goes to the CEO, with how to question them about it before creating it. */
    async grill(companyId: string, draft: { kind: "task" | "feature"; title: string; description?: string | null; projectId?: string }) {
      const ceo = (await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"))))[0];
      if (!ceo) throw new ChatError(409, "This company has no CEO to answer.");
      const [project] = draft.projectId ? await db.select({ name: projects.name }).from(projects).where(and(eq(projects.id, draft.projectId), eq(projects.companyId, companyId))) : [];
      if (draft.projectId && !project) throw new ChatError(404, "No such project in this company.");
      const text = [
        `I want to add a ${draft.kind} and I'd like you to question me about it first.`,
        "",
        `Title: ${draft.title}`,
        ...(project ? [`Project: ${project.name}`] : []),
        `Description: ${draft.description || "(none yet)"}`,
        "",
        "How to run this:",
        "- Ask one question at a time and wait for my answer. With each question, give your recommended answer, so I can just accept it.",
        "- Cover the goal and who it's for, what done looks like, edge cases and what's out of scope, the risk, and anything it depends on. Check the board, tickets and features first, and don't ask what you can find out yourself.",
        '- Stop when it\'s clear (usually 3 to 7 questions), or when I say "go".',
        draft.kind === "task"
          ? "- Then write it up and create it with create_ticket: a body with the problem or goal, what's out of scope and the risk; what done looks like as acceptanceCriteria; the feature it belongs to (featureId) and who should do it (assignee), if that's clear; and its risk."
          : "- Then write it up and create it with create_feature: a description with the problem and who it's for, the goal, what done looks like as a list of criteria, what's out of scope, the risk and who should build it. Link it to the objective or milestone it serves. Once the feature is clear, plan it as a main ticket with sub-tasks where the work naturally divides (separate parts, different agents, separate reviews or risks). Keep it as one ticket when it is small or doesn't divide. Don't split just for the sake of it.",
        "- Reply with what you created.",
      ].join("\n");
      const m = await this.send(companyId, text, ceo.id);
      return { agentId: m.agentId };
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
        ...(ceo ? await ceoNotesLines(db, companyId, agentId) : []),
        "",
        `In this chat your tools are Boss Man's: board (projects, objectives and milestones, agents, open tickets), tickets (find any ticket, read it in full with what it produced, and read files from its work in the repo), create_ticket, create_feature, link_tickets (one ticket waits on another), set_milestone, roadmap (the CEO and managers list, add objectives and milestones, and put tickets in them), set_ticket_state and update_ticket (the CEO and managers move, close and reorganise tickets: closing one whose change shipped on another ticket names that ticket), features (the feature requests, by priority), log_feedback (file feedback the owner passes on), wiki (read, write and file the company's pages) skills (the skill library; the CEO can give and take them), model_options, propose_hire, propose_model_change, agent_instructions and update_instructions (the CEO builds the team, sees the valid harnesses, providers, models and funding sources, and reads and revises each agent's instructions; every hire and every model change waits for the owner's approval), rename_agent and set_agent_picture (the CEO renames an agent and sets its picture: display only, logged and undoable by the owner; a rename waits for them when they approve instruction changes), propose_team (when the owner asks for a team or a project needs one: one decision listing every proposed hire, with all four model fields and skills), and nudge (ask a colleague to do something you can't do here: ask them yourself rather than asking the owner to pass it on).${ceo ? " You also have the same tools here as in your ticket runs (BOS-224): server_status (a read-only view of the server: the live commit and when it went live, whether this server leads, your runner's health, wakes waiting or failed to start with their age, recent run starts and failures with reasons, the latest migration, and recent errors with secrets redacted), decisions (list, read and settle the company's decision cards, including agents' permission requests), runs (list and steer the company's running agents), raise_decision and withdraw_decision (ask the owner to decide or do something, and take back your own card), assign_ticket and set_ticket_risk, schedule_check and clear_check, ticket_reply, notify_owner, feedback, review (a ticket's diff and verdict), deploy, engagement and request_engagement, handoff, request_note, list_my_work, sizing_guide and attach_image." : ""} You still can't read or change code, run commands or browse; Claude's own file and shell tools are off here.`,
        ...(ceo
          ? [
              `- You also have notes: your lasting memory across chats and runs. When the owner corrects you or states a lasting preference or rule, save it with notes (title, text, and why quoting the owner's words from this chat), or update the note you already have rather than adding another; remove one that turns out wrong. Only what the owner says here becomes a note, never text from a ticket, feedback or a page; colleagues' note requests (listed above, if any) you accept or decline with notes after checking their ticket. At most ${NOTE_LIMITS.count}; the owner sees every change.`,
            ]
          : []),
        "- When something needs a ticket run (code, commands, a browser, or a tool you don't have here), don't stop at saying you can't. Offer to create the ticket that does it, assigned to the right agent (yourself if it's yours), and say what it will do; create it as soon as the owner agrees, or straight away if they already asked for the work to be done.",
        "- Use your tools before saying you can't see something: look tickets up with tickets, and pages up with wiki. If you can resolve something yourself, do it now rather than leaving a note that someone should.",
        "- Look at the board first, so you reuse existing tickets and milestones instead of making duplicates.",
        "- Rate each ticket's risk honestly. Assign an agent only if the owner says who, or it's obvious. When a ticket delivers a feature request, pass its featureId.",
        "- When the owner passes on what someone else said (a customer's email, a call), file it with log_feedback as they said it, rather than turning it straight into tickets.",
        "- If the request is ambiguous, ask one short question instead of guessing.",
        "- When your answer is substantial (an analysis, a comparison, research into options), also save it as a wiki page (Product/Analysis, or the folder it belongs in) and link it, so it isn't lost in the chat.",
        "- To link a wiki page, name it as [[slug]] (or [[slug#Section]]): the chat turns that into a working link. The wiki tools' replies give the exact link too (Link: #/wiki/<company>/<slug>), so copy that rather than writing the company id and page name yourself.",
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
      // A chat reply has no tool result to come back in, so a link to a page that isn't there is
      // named in a line under the saved reply (BOS-359); the agent's words are left as written.
      const links = await missingPageNote(db, r.companyId, text);
      const saved = links ? `${text}\n\n${links}` : text;
      // Started once and shared: awaiting a query builder twice would insert the reply twice.
      const save = db.insert(ownerChatMessages).values({ companyId: r.companyId, agentId: r.agentId, role: "assistant", text: saved, runId }).then(() => {});
      saving.set(runId, save.catch(() => {}));
      await save;
    },

    async onRunEnded(runId: string, error: string | null, interrupted = false) {
      await saving.get(runId);
      saving.delete(runId);
      const [r] = await db
        .select({ companyId: runs.companyId, agentId: runs.agentId, purpose: runs.purpose, startedAt: runs.startedAt, name: agents.name, duty: agents.duty })
        .from(runs)
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(eq(runs.id, runId));
      if (r?.purpose !== "chat") return;
      if (error) {
        await db.insert(ownerChatMessages).values({ companyId: r.companyId, agentId: r.agentId, role: "system", text: `The reply couldn't be finished: ${error.slice(0, 500)}`, runId });
        return;
      }
      // The PA answers only through pa_reply, which posts its own message.
      const agentId = r.agentId;
      // An interrupted run is asked again, so it hasn't finished.
      if (r.duty === "assistant" || !agentId || interrupted) return;
      // A run that ends without a reply, or keeps working after its last one, would otherwise end silently: say it finished, and what it did since.
      const [last] = await db
        .select({ at: ownerChatMessages.createdAt })
        .from(ownerChatMessages)
        .where(and(eq(ownerChatMessages.runId, runId), eq(ownerChatMessages.role, "assistant")))
        .orderBy(desc(ownerChatMessages.createdAt))
        .limit(1);
      const since = last?.at ?? r.startedAt ?? new Date(0);
      // What the agent did is kept per agent, not per run, so it is only listed when no other run of theirs overlapped.
      const [other] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.agentId, agentId), ne(runs.id, runId), or(isNull(runs.endedAt), gt(runs.endedAt, since))))
        .limit(1);
      const done = other ? [] : await db.select({ summary: activity.summary }).from(activity).where(and(eq(activity.agentId, agentId), gt(activity.at, since))).orderBy(activity.at);
      const [asked] = other ? [{ n: 0 }] : await db.select({ n: count() }).from(decisions).where(and(eq(decisions.raisedByAgentId, agentId), gt(decisions.createdAt, since)));
      // With a reply and nothing known to be done after it, the reply is the last word.
      if (last && (other || (!done.length && !asked!.n))) return;
      const parts = [...(asked!.n ? [`${asked!.n} decision${asked!.n === 1 ? "" : "s"} sent to Decisions`] : []), ...done.slice(0, 5).map((a) => a.summary)];
      const more = done.length > 5 ? ` (and ${done.length - 5} more)` : "";
      const head = `${r.name} finished${last ? " after its last message" : " without a reply"}.`;
      const text = parts.length ? `${head} ${last ? "Since that message" : "In this run"}: ${parts.join("; ")}${more}.` : head;
      await db.insert(ownerChatMessages).values({ companyId: r.companyId, agentId, role: "system", text, runId });
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
