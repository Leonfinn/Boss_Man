// The CEO's PA (R87): a cheap agent that answers the owner's routine questions in chat. A small
// model's own confidence can't be trusted, so every guard lives here, in code: what it may cite,
// which questions it may answer at all, and what happens when it shouldn't. Anything it can't
// stand behind goes to the CEO, and the owner is told so.
import { formatDate } from "@boss-man/shared";
import { and, asc, desc, eq, gt, inArray, isNull, like, lte, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, decisions, ownerChatMessages, paAnswers, runs, tickets } from "../db/schema.js";
import { CHAT_REASON } from "./chat.js";

/** Questions about judgement or money, which the CEO answers. */
export const JUDGEMENT = [/\bwhy\b/, /\bshould/, /\brecommend/, /\bwhat('s| is)? next\b/, /\bplan/, /\bprioriti[sz]/, /\bapprov/, /\bbudget/, /\bcost/, /\bmoney\b/, /\bspen[dt]/, /\bhir(e|ing)\b/, /\bfir(e|ing)\b/, /\bdeploy/, /\brisk/, /\bmerg(e|ing)/];
export const REASK_MS = 10 * 60_000;
export const HOLDING = "Passing this to the CEO.";
export const ASK_CEO = "[Ask the CEO]";
/** BOS-1392: how much of the owner's recent conversation an escalation brief carries. */
export const BATCH_MESSAGES = 5;
export const BATCH_CHARS = 4000;

export type Cite = { kind: "ticket" | "decision" | "run"; id: string };
const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// shortcut: module-level and lost on restart, harmless because a PA run dies with the restart; entries are dropped in onRunEnded (which the server-ended path also fires).
/** The ids each PA run has been shown by a read tool; a reply may cite only these. */
const fetched = new Map<string, Set<string>>();
export function remember(runId: string, text: string) {
  const ids = fetched.get(runId) ?? new Set<string>();
  for (const m of text.matchAll(UUID)) ids.add(m[0]);
  fetched.set(runId, ids);
}

// shortcut: same as `fetched`: in memory, pruned in onRunEnded, lost on restart harmlessly.
/** Runs that called a ticket or decision tool, so an empty cite list can mean "nothing found". */
const searched = new Set<string>();
/** For tests: how many runs the cite guard still remembers. */
export const citeStateSize = () => fetched.size + searched.size;
export const markSearched = (runId: string) => void searched.add(runId);

type Msg = typeof ownerChatMessages.$inferSelect;

export function paService(
  db: Db,
  deps: { notify: (agentId: string, input: { reason: string; priority: number }) => Promise<unknown>; now?: () => Date; auditRate?: number; random?: () => number; timeZone?: () => Promise<string | undefined> },
) {
  const now = deps.now ?? (() => new Date());

  /**
   * The owner's last message that this run was asked, and whether it has an outcome yet. `earlier` is every other message the
   * run claimed that has no outcome yet (BOS-1392): two sent before the run started are answered by one run, and each needs a row.
   */
  async function question(runId: string) {
    const claimed = await db.select().from(ownerChatMessages).where(and(eq(ownerChatMessages.runId, runId), eq(ownerChatMessages.role, "owner"))).orderBy(desc(ownerChatMessages.createdAt));
    const msg = claimed[0];
    const rows = claimed.length ? await db.select({ id: paAnswers.chatMessageId }).from(paAnswers).where(inArray(paAnswers.chatMessageId, claimed.map((m) => m.id))) : [];
    const answered = new Set(rows.map((r) => r.id));
    return { msg, done: msg && answered.has(msg.id) ? { id: msg.id } : undefined, earlier: claimed.slice(1).filter((m) => !answered.has(m.id)) };
  }

  const clock = async (d: Date) => formatDate("en-GB", d, { timeZone: (await deps.timeZone?.()) ?? "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  /** The owner's messages in this thread since the last posted answer or CEO reply, oldest first, within the caps (BOS-1392). */
  async function batch(msg: Msg) {
    const thread = msg.agentId ? eq(ownerChatMessages.agentId, msg.agentId) : isNull(ownerChatMessages.agentId);
    const [boundary] = await db
      .select({ at: ownerChatMessages.createdAt })
      .from(ownerChatMessages)
      .where(and(eq(ownerChatMessages.companyId, msg.companyId), thread, eq(ownerChatMessages.role, "assistant"), ne(ownerChatMessages.text, HOLDING), lte(ownerChatMessages.createdAt, msg.createdAt)))
      .orderBy(desc(ownerChatMessages.createdAt))
      .limit(1);
    const rows = await db
      .select()
      .from(ownerChatMessages)
      .where(and(eq(ownerChatMessages.companyId, msg.companyId), thread, eq(ownerChatMessages.role, "owner"), lte(ownerChatMessages.createdAt, msg.createdAt), ...(boundary ? [gt(ownerChatMessages.createdAt, boundary.at)] : [])))
      .orderBy(desc(ownerChatMessages.createdAt));
    // Newest first until the caps are spent; the latest always gets in, cut to the budget.
    const kept: Msg[] = [];
    let budget = BATCH_CHARS;
    for (const m of [msg, ...rows.filter((r) => r.id !== msg.id)]) {
      if (kept.length >= BATCH_MESSAGES || budget <= 0) break;
      kept.push({ ...m, text: m.text.slice(0, budget) });
      budget -= m.text.length;
    }
    return kept.reverse();
  }

  /** Records the outcome, tells the owner it's with the CEO, and wakes the CEO with a brief. */
  async function escalate(msg: Msg, why: string, found: string, cites: Cite[], earlier: Msg[] = []) {
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, msg.companyId), eq(agents.role, "ceo")));
    const thread = msg.agentId ? eq(ownerChatMessages.agentId, msg.agentId) : isNull(ownerChatMessages.agentId);
    // An earlier escalation from this thread that the CEO hasn't answered yet: this is a follow-up to it, whatever the PA's own label says.
    const [open] = await db
      .select({ at: ownerChatMessages.createdAt })
      .from(paAnswers)
      .innerJoin(ownerChatMessages, eq(ownerChatMessages.id, paAnswers.chatMessageId))
      .where(and(eq(paAnswers.companyId, msg.companyId), thread, like(paAnswers.outcome, "escalated:%"), isNull(paAnswers.ceoRepliedAt), ne(paAnswers.chatMessageId, msg.id), lte(ownerChatMessages.createdAt, msg.createdAt)))
      .orderBy(asc(ownerChatMessages.createdAt))
      .limit(1);
    const owners = await batch(msg);
    const asked = owners.length > 1 ? ["The owner's messages, oldest first:", ...(await Promise.all(owners.map(async (m) => `- ${await clock(m.createdAt)}${m.id === msg.id ? " (latest)" : ""}: ${m.text}`)))] : [`The owner asked: ${msg.text}`];
    const brief = [
      "Your PA is passing this on from the owner.",
      ...(open ? [`Follow-up to the owner's message at ${await clock(open.at)} that you haven't answered yet; read them together: this may be the answer to that question or more detail on it.`] : []),
      ...asked,
      `What the PA found: ${found || "nothing it could stand behind"}${cites.length ? ` (cites: ${cites.map((c) => `${c.kind} ${c.id}`).join(", ")})` : ""}`,
      `Why it escalated: ${open && /no explicit question/i.test(why) ? "the PA saw no question in it, but it follows one you haven't answered" : why}`,
      "Answer the owner directly; your reply is shown in their chat with the PA too.",
    ].join("\n");
    const [copy] = ceo ? await db.insert(ownerChatMessages).values({ companyId: msg.companyId, agentId: ceo.id, role: "owner", text: brief }).returning({ id: ownerChatMessages.id }) : [];
    for (const m of [...earlier, msg]) await db.insert(paAnswers).values({ companyId: msg.companyId, chatMessageId: m.id, question: m.text, cites, outcome: `escalated:${why}`, ceoMessageId: copy?.id ?? null });
    await db.insert(ownerChatMessages).values({ companyId: msg.companyId, agentId: msg.agentId, role: "assistant", text: HOLDING });
    if (ceo) await deps.notify(ceo.id, { reason: CHAT_REASON, priority: 4 });
  }

  /** Why this reply must not be posted, or null when every guard passes. */
  async function refusal(runId: string, msg: Msg, cites: Cite[], confidence: string) {
    if (confidence !== "high") return "low confidence";
    if (JUDGEMENT.some((p) => p.test(msg.text.toLowerCase()))) return "a judgement question";
    const recent = await db
      .select({ text: ownerChatMessages.text })
      .from(ownerChatMessages)
      .where(and(eq(ownerChatMessages.companyId, msg.companyId), (msg.agentId ? eq(ownerChatMessages.agentId, msg.agentId) : isNull(ownerChatMessages.agentId)), eq(ownerChatMessages.role, "owner"), ne(ownerChatMessages.id, msg.id), gt(ownerChatMessages.createdAt, new Date(msg.createdAt.getTime() - REASK_MS)), lte(ownerChatMessages.createdAt, msg.createdAt)));
    if (recent.some((r) => normal(r.text) === normal(msg.text))) return "the owner asked again";
    if (!cites.length && !searched.has(runId)) return "no cites";
    const shown = fetched.get(runId);
    if (cites.some((c) => !shown?.has(c.id))) return "it cited ids no tool showed it";
    for (const c of cites) {
      const table = { ticket: tickets, decision: decisions, run: runs }[c.kind];
      const [row] = await db.select().from(table).where(and(eq(table.id, c.id), eq(table.companyId, msg.companyId)));
      if (!row) return `unknown ${c.kind} ${c.id}`;
      if (c.kind === "ticket" && ["high", "critical"].includes((row as typeof tickets.$inferSelect).risk ?? "")) return "it cited a high-risk ticket";
    }
    return null;
  }

  return {
    /** pa_reply: posts the answer with its label, or escalates. */
    async reply(runId: string, input: { text: string; cites: Cite[]; confidence: "high" | "low" }) {
      const { msg, done, earlier } = await question(runId);
      if (!msg) return { posted: false, note: "There's no owner message waiting for an answer." };
      if (done) return { posted: false, note: "That question already has an outcome." };
      const why = await refusal(runId, msg, input.cites, input.confidence);
      if (why) {
        await escalate(msg, why, input.text, input.cites, earlier);
        return { posted: false, note: `Not posted: ${why}. The question went to the CEO and the owner was told. Do not answer it yourself.` };
      }
      const [me] = await db.select({ model: agents.model }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).where(eq(runs.id, runId));
      const zone = (await deps.timeZone?.()) ?? "UTC";
      const at = formatDate("en-GB", now(), { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      const ticketIds = input.cites.filter((c) => c.kind === "ticket").map((c) => c.id);
      const titles = ticketIds.length ? await db.select({ id: tickets.id, title: tickets.title }).from(tickets).where(inArray(tickets.id, ticketIds)) : [];
      // A ticket shows as its title (the web page links it); brackets and parentheses would break the link.
      const ids = input.cites.map((c) => (c.kind === "ticket" ? `[${(titles.find((t) => t.id === c.id)?.title ?? "ticket").replace(/[[\]()]/g, " ").trim().slice(0, 40)}](#/tickets/${c.id})` : `${c.kind} ${c.id.slice(0, 8)}`)).join(", ");
      const label = `— Answered by your PA (${me?.model ?? "default model"}) from ${ids || "a board search"} as of ${at}${zone === "UTC" ? " UTC" : ""} · ${ASK_CEO}`;
      const posted = `${input.text}\n\n${label}`;
      await db.insert(ownerChatMessages).values({ companyId: msg.companyId, agentId: msg.agentId, role: "assistant", text: posted, runId });
      await db.insert(paAnswers).values({ companyId: msg.companyId, chatMessageId: msg.id, question: msg.text, reply: input.text, cites: input.cites, outcome: "posted", sampled: (deps.random ?? Math.random)() < (deps.auditRate ?? 0.1) });
      // The same reply answers the messages sent before it in this run: each gets its own outcome, but only the newest is sampled.
      for (const m of earlier) await db.insert(paAnswers).values({ companyId: m.companyId, chatMessageId: m.id, question: m.text, reply: input.text, cites: input.cites, outcome: "posted", sampled: false });
      return { posted: true, note: "Posted to the owner." };
    },

    /** pa_escalate: the PA hands the question over itself. */
    async escalate(runId: string, summary: string) {
      const { msg, done, earlier } = await question(runId);
      if (!msg || done) return { ok: false };
      await escalate(msg, "the PA asked the CEO", summary, [], earlier);
      return { ok: true };
    },

    /** The CEO marks a posted or escalated answer right or wrong. */
    async verdict(companyId: string, answerId: string, verdict: "correct" | "wrong", note?: string) {
      const rows = await db.update(paAnswers).set({ verdict, verdictNote: note ?? null }).where(and(eq(paAnswers.id, answerId), eq(paAnswers.companyId, companyId))).returning({ id: paAnswers.id });
      return rows.length > 0;
    },

    /** The CEO's chat answer to an escalated question is shown in the owner's chat with the PA. */
    async onAgentMessage(runId: string, text: string) {
      const copies = await db.select({ id: ownerChatMessages.id }).from(ownerChatMessages).where(eq(ownerChatMessages.runId, runId));
      if (!copies.length) return;
      const open = await db
        .select({ id: paAnswers.id, paThread: ownerChatMessages.agentId, companyId: paAnswers.companyId })
        .from(paAnswers)
        .innerJoin(ownerChatMessages, eq(ownerChatMessages.id, paAnswers.chatMessageId))
        .where(and(inArray(paAnswers.ceoMessageId, copies.map((c) => c.id)), isNull(paAnswers.ceoRepliedAt)));
      for (const thread of new Set(open.map((o) => o.paThread))) await db.insert(ownerChatMessages).values({ companyId: open[0]!.companyId, agentId: thread, role: "assistant", text: `From the CEO:\n\n${text}` });
      if (open.length) await db.update(paAnswers).set({ ceoRepliedAt: now() }).where(inArray(paAnswers.id, open.map((o) => o.id)));
    },

    /** A PA run that ends without an outcome fails open: the question goes to the CEO. */
    async onRunEnded(runId: string, error: string | null) {
      fetched.delete(runId);
      searched.delete(runId);
      const [r] = await db.select({ duty: agents.duty }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).where(eq(runs.id, runId));
      if (r?.duty !== "assistant") return;
      const { msg, done, earlier } = await question(runId);
      if (msg && !done) await escalate(msg, error ? `the PA's run failed: ${error.slice(0, 200)}` : "the PA ended without answering", "", [], earlier);
    },
  };
}
