// CEO continuity (v1.1). A CEO works in chapters. Each chapter is one long agent session that
// opens with a directive frozen for the whole chapter, so the session's prefix (and so prompt
// caching) holds; later wakes resume the session with only what's new. A chapter closes once
// its context is 70% full, after 7 days, or when the owner asks: the CEO's next run resumes
// it one last time to write a handoff, and the run after that starts the next chapter with it.
// The CEO also keeps notes and a journal in files in its own folder, which outlive chapters.
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { CHAPTER_CONTEXT_LIMIT, CHAPTER_MAX_DAYS, chapterDue } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, ceoChapters, companies, decisions, keyResults, milestones, objectives, runs, tickets } from "../db/schema.js";

export const NOTES_FILE = "notes.md";
export const JOURNAL_FILE = "journal.md";
const HANDOFF_MAX = 20_000;

type Agent = typeof agents.$inferSelect;
type Chapter = typeof ceoChapters.$inferSelect;

export type ChapterLaunch = { chapterId: string; prompt: string; freshPrompt?: string; resumeSessionId?: string };

const REASON = { owner: "the owner asked for a new chapter", context: `your context is over ${CHAPTER_CONTEXT_LIMIT * 100}% full`, age: `it's ${CHAPTER_MAX_DAYS} days old` } as const;

export function chaptersService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  /** Identity, mission, objectives and how to work, as they stand when the chapter starts. */
  async function directive(agent: Agent, number: number) {
    const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId));
    const objs = await db.select().from(objectives).where(and(eq(objectives.companyId, agent.companyId), eq(objectives.status, "active"))).orderBy(asc(objectives.priority), asc(objectives.createdAt));
    const ids = objs.map((o) => o.id);
    const krs = ids.length ? await db.select().from(keyResults).where(inArray(keyResults.objectiveId, ids)) : [];
    const ms = ids.length ? await db.select().from(milestones).where(inArray(milestones.objectiveId, ids)).orderBy(asc(milestones.targetDate)) : [];
    const lines = [
      `You are ${agent.name}, the CEO of ${company?.name ?? "this company"}, working through Boss Man. This is chapter ${number} of your work.`,
      "",
      company?.mission ? `Mission: ${company.mission}` : "The owner hasn't written a mission yet; ask them for one with raise_decision if you need it.",
    ];
    if (objs.length) {
      lines.push("", "Objectives, most important first:");
      for (const o of objs) {
        lines.push(`- P${o.priority} ${o.title}`);
        for (const k of krs.filter((k) => k.objectiveId === o.id)) lines.push(`  - Key result: ${k.title}${k.target != null ? ` (${k.current ?? 0} of ${k.target}${k.unit ? ` ${k.unit}` : ""})` : ""} [id ${k.id}]`);
        for (const m of ms.filter((m) => m.objectiveId === o.id)) lines.push(`  - Milestone: ${m.title}${m.targetDate ? `, due ${m.targetDate}` : ""}`);
      }
    } else lines.push("", "There are no objectives yet. Propose some to the owner with raise_decision.");
    lines.push(
      "",
      "How you work:",
      "- You run the company: break objectives into tickets (create_ticket, with a risk tier), assign them, answer the decisions waiting for you (decisions), review finished work (review) and keep the owner informed (notify_owner for news, raise_decision when you need them).",
      "- Feature requests: the feedback tool shows what people ask for, as features ranked by priority. Triage new feedback into features when you're asked to, and pass featureId when a ticket delivers one.",
      "- Rate each ticket's risk honestly. Trivial and low work goes straight ahead; medium work starts with a short plan; high and critical work is planned first and the owner approves it.",
      `- Keep ${NOTES_FILE} in your working folder for lasting facts: decisions made, how things are set up, what the owner prefers. Add a dated entry to ${JOURNAL_FILE} at the end of each wake: what happened and what's next. Read both when a chapter starts. They outlive chapters; your conversation doesn't.`,
      `- This chapter continues across wakes in one conversation. It closes when your context is ${CHAPTER_CONTEXT_LIMIT * 100}% full, after ${CHAPTER_MAX_DAYS} days, or when the owner asks; you'll be asked to write a handoff for your next chapter then.`,
      "- Objectives and the mission above are as they were when this chapter started. If the owner changes them, they'll tell you, or the next chapter will have them.",
    );
    return lines.join("\n");
  }

  /** What Boss Man writes when a chapter ends without the CEO's own handoff. */
  async function fallbackHandoff(companyId: string, reason: string) {
    const open = await db
      .select({ title: tickets.title, state: tickets.systemState })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), inArray(tickets.systemState, ["in_progress", "review", "blocked", "ready"])))
      .orderBy(desc(tickets.lastActivityAt))
      .limit(30);
    const waiting = await db
      .select({ q: decisions.question, tier: decisions.tier })
      .from(decisions)
      .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open")))
      .orderBy(asc(decisions.createdAt))
      .limit(20);
    const why = REASON[reason as keyof typeof REASON] ?? reason;
    const lines = [`The previous chapter ended (${why}) without a handoff, so Boss Man put this together. Read ${NOTES_FILE} and ${JOURNAL_FILE} for more.`];
    if (open.length) lines.push("", "Tickets in play:", ...open.map((t) => `- [${t.state.replace(/_/g, " ")}] ${t.title}`));
    if (waiting.length) lines.push("", "Open decisions:", ...waiting.map((d) => `- (${d.tier === "ceo" ? "yours" : "the owner's"}) ${d.q.slice(0, 200)}`));
    return lines.join("\n");
  }

  const opening = (c: Chapter) =>
    [c.directive, c.handoffIn ? `\nHandoff from your previous chapter:\n${c.handoffIn}` : `\nThis is your first chapter: start ${NOTES_FILE} and ${JOURNAL_FILE}.`, "\n---\n"].join("\n");

  async function end(c: Chapter, reason: string) {
    const handoff = c.handoff ?? (await fallbackHandoff(c.companyId, reason));
    await db
      .update(ceoChapters)
      .set({ endedAt: now(), endReason: c.endReason ?? reason, handoff, handoffBy: c.handoffBy ?? "boss_man", closingRunId: null })
      .where(and(eq(ceoChapters.id, c.id), isNull(ceoChapters.endedAt)));
  }

  async function openChapter(agentId: string) {
    const [c] = await db.select().from(ceoChapters).where(and(eq(ceoChapters.agentId, agentId), isNull(ceoChapters.endedAt)));
    return c ?? null;
  }

  return {
    /**
     * How a CEO's run fits its chapter: continue it, close it with a handoff, or start the next.
     * `wake` is the run's own prompt: why it was woken and what's new.
     */
    async forLaunch(agent: Agent, runId: string, wake: string): Promise<ChapterLaunch> {
      const resumable = agent.agentKind === "claude";
      let c = await openChapter(agent.id);
      if (c) {
        const due = chapterDue(c, now());
        if (due && resumable && c.acpSessionId && !c.handoff && !c.closingRunId) {
          // One last run in this chapter, to write the handoff, then the wake as usual.
          await db.update(ceoChapters).set({ closingRunId: runId, endReason: due }).where(eq(ceoChapters.id, c.id));
          const close = [
            `This chapter is closing because ${REASON[due]}. Before anything else, call the handoff tool with a handoff for your next chapter, which starts with a fresh conversation: what you're in the middle of, what you've promised and to whom, decisions pending and what you'd recommend, risks you're watching, and anything not yet in ${NOTES_FILE}. Update ${NOTES_FILE} and ${JOURNAL_FILE} too. Then deal with this wake:`,
            "",
            wake,
          ].join("\n");
          return { chapterId: c.id, prompt: close, freshPrompt: `${opening(c)}\n${close}`, resumeSessionId: c.acpSessionId };
        }
        if (due || c.closingRunId) {
          await end(c, due ?? "closed");
          c = null;
        }
      }
      if (!c) {
        const [last] = await db.select().from(ceoChapters).where(eq(ceoChapters.agentId, agent.id)).orderBy(desc(ceoChapters.number)).limit(1);
        const number = (last?.number ?? 0) + 1;
        const [created] = await db
          .insert(ceoChapters)
          .values({ companyId: agent.companyId, agentId: agent.id, number, directive: await directive(agent, number), handoffIn: last?.handoff ?? null, startedAt: now() })
          .returning();
        return { chapterId: created!.id, prompt: `${opening(created!)}\n${wake}` };
      }
      if (resumable && c.acpSessionId) return { chapterId: c.id, prompt: wake, freshPrompt: `${opening(c)}\n${wake}`, resumeSessionId: c.acpSessionId };
      // Agents that can't reopen a session get the chapter's opening every time.
      return { chapterId: c.id, prompt: `${opening(c)}\n${wake}` };
    },

    /** A run that never reached the runner doesn't close its chapter; the next one will. */
    async onLaunchFailed(runId: string) {
      await db.update(ceoChapters).set({ closingRunId: null }).where(and(eq(ceoChapters.closingRunId, runId), isNull(ceoChapters.endedAt)));
    },

    /** The run's session becomes the chapter's: the one to resume next time. */
    async onRunStarted(runId: string, acpSessionId: string) {
      const [r] = await db.select({ chapterId: runs.chapterId }).from(runs).where(eq(runs.id, runId));
      if (!r?.chapterId) return;
      await db.update(ceoChapters).set({ acpSessionId }).where(and(eq(ceoChapters.id, r.chapterId), isNull(ceoChapters.endedAt)));
    },

    async onContext(runId: string, used: number, size: number) {
      const [r] = await db.update(runs).set({ contextUsed: used, contextSize: size }).where(eq(runs.id, runId)).returning({ chapterId: runs.chapterId });
      if (r?.chapterId) await db.update(ceoChapters).set({ contextUsed: used, contextSize: size }).where(and(eq(ceoChapters.id, r.chapterId), isNull(ceoChapters.endedAt)));
    },

    /** A closing run that ended closes its chapter, with the CEO's handoff or Boss Man's. */
    async onRunEnded(runId: string) {
      const [c] = await db.select().from(ceoChapters).where(and(eq(ceoChapters.closingRunId, runId), isNull(ceoChapters.endedAt)));
      if (c) await end(c, c.endReason ?? "closed");
    },

    /** The CEO's handoff for its next chapter, from the handoff tool. */
    async writeHandoff(agentId: string, text: string) {
      const c = await openChapter(agentId);
      if (!c) return null;
      const [u] = await db
        .update(ceoChapters)
        .set({ handoff: text.slice(0, HANDOFF_MAX), handoffBy: "ceo" })
        .where(eq(ceoChapters.id, c.id))
        .returning();
      return u!;
    },

    /** The owner asks for a fresh chapter, e.g. after changing the mission or objectives. */
    async requestRoll(companyId: string) {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
      if (!ceo) return null;
      const [u] = await db.update(ceoChapters).set({ rollRequestedAt: now() }).where(and(eq(ceoChapters.agentId, ceo.id), isNull(ceoChapters.endedAt))).returning();
      return u ?? null;
    },

    async list(companyId: string) {
      const rows = await db.select().from(ceoChapters).where(eq(ceoChapters.companyId, companyId)).orderBy(desc(ceoChapters.number)).limit(50);
      const counts = rows.length
        ? await db
            .select({ chapterId: runs.chapterId, n: sql<number>`count(*)`.mapWith(Number) })
            .from(runs)
            .where(inArray(runs.chapterId, rows.map((r) => r.id)))
            .groupBy(runs.chapterId)
        : [];
      return rows.map((c) => ({
        id: c.id,
        number: c.number,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        endReason: c.endReason,
        contextUsed: c.contextUsed,
        contextSize: c.contextSize,
        rollRequestedAt: c.rollRequestedAt,
        closing: !!c.closingRunId,
        directive: c.directive,
        handoffIn: c.handoffIn,
        handoff: c.handoff,
        handoffBy: c.handoffBy,
        runs: counts.find((x) => x.chapterId === c.id)?.n ?? 0,
      }));
    },
  };
}
