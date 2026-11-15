// The brief an agent gets at every wake (R84): built by code from live tables, no model call.
// Every section is capped, and says how many more there are.
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { DEVICE_UNITS, isRenderableProfile, runLabel, staleNoteWhy, tallestReading, untrusted } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { getHold } from "./maintenance.js";
import { heldReadyTickets } from "./agent-wip.js";
import { activity, agents, decisions, deviceProfiles, engagements, paAnswers, runs, settings, ticketDependencies, tickets } from "../db/schema.js";
import { runOriginQuery } from "./runs.js";
import { MERGE_LINE_KIND } from "./merge-line.js";
import { CHECK_REUSED_KIND } from "./check-request.js";
import { getStandingRules, standingRulesSection } from "./standing-rules.js";

const MORE = (n: number) => `- +${n} more: use whats_new or tickets`;
const one = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const capped = (lines: string[], max: number) => (lines.length > max ? [...lines.slice(0, max), MORE(lines.length - max)] : lines);
const section = (title: string, lines: string[]) => (lines.length ? ["", `## ${title}`, ...lines] : []);

type BriefInput = {
  companyId: string;
  agentId: string | null;
  role: string;
  /** The agent's cursor (R83); null means the last day. */
  since: Date | null;
  now: Date;
  /** For the owner's page: no untrusted framing. */
  plain?: boolean;
};

export async function buildBrief(db: Db, { companyId, agentId, role, since, now, plain }: BriefInput): Promise<string> {
  const age = (d: Date) => {
    const m = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));
    return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  };
  const noteOf = (t: { stateNote: string | null; stateNoteAt: Date | null; stateNoteStaleAt?: Date | null; stateNoteStaleReason?: string | null }) => {
    if (!t.stateNote || !t.stateNoteAt) return "";
    const stale = t.stateNoteStaleAt != null && t.stateNoteStaleAt > t.stateNoteAt;
    // Say what the owner did, not a general warning (BOS-1192).
    return ` Note (${age(t.stateNoteAt)} ago): ${one(t.stateNote, 100)}${stale ? ` (${staleNoteWhy(t.stateNoteStaleReason, age(t.stateNoteStaleAt!))})` : ""}`;
  };
  /** The owner's recorded screens (BOS-641): a layout ticket that names one is checked at its
   * measured figures, in a rendering test, not by reading the CSS. Just the facts, one line each.
   * Skipped when the agent has no open ticket, since only a ticket can be a layout ticket. */
  const deviceLines = async (hasTicket: boolean) => {
    if (!hasTicket) return [];
    const rows = await db.select().from(deviceProfiles).orderBy(desc(deviceProfiles.reportedAt));
    // The owner's phone type (BOS-1484), once an ntfy server is set up: so nobody guesses Android or iPhone.
    const [notif] = await db.select().from(settings).where(eq(settings.key, "notifications"));
    const nv = notif?.value as { ntfy?: unknown; phoneType?: string | null } | undefined;
    const phoneLine = nv?.ntfy ? [`- Owner's phone for ntfy pushes: ${nv.phoneType === "android" ? "Android" : nv.phoneType === "iphone" ? "iPhone" : nv.phoneType === "both" ? "both Android and iPhone" : "phone type unknown: ask the owner"}`] : [];
    return [...phoneLine, ...rows
      .map((r) => ({ label: r.label, browser: r.browser, readings: r.readings }))
      .filter((p) => isRenderableProfile(p) && p.readings.every((x) => DEVICE_UNITS.every((k) => typeof x.units?.[k] === "number")))
      .map((p) => {
        const t = tallestReading(p);
        return `- ${one(p.label, 40)} (${one(p.browser, 20)}): ${t.width}×${t.height} CSS px, ratio ${t.pixelRatio}, ${t.coarsePointer ? "touch" : "mouse"}, ${t.displayMode}; 100vh ${t.units.vh}, 100dvh ${t.units.dvh}, 100svh ${t.units.svh}, 100lvh ${t.units.lvh}, visual ${t.units.visual} px`;
      })];
  };

  const from = since ?? new Date(now.getTime() - 24 * 3_600_000);
  const notMe = agentId ? sql`${activity.agentId} is distinct from ${agentId}` : undefined;

  const changeLine = (c: { at: Date; agent: string | null; summary: string; title: string | null }) =>
    `- ${age(c.at)} ${c.agent ?? "owner"}${c.title ? `, "${one(c.title, 40)}"` : ""}: ${one(c.summary, 100)}`;
  const changes = (relevant: string[] | null) =>
    relevant && !relevant.length
      ? Promise.resolve([])
      : db
          .select({ at: activity.at, agent: agents.name, summary: activity.summary, title: tickets.title })
          .from(activity)
          .leftJoin(agents, eq(agents.id, activity.agentId))
          .leftJoin(tickets, eq(tickets.id, activity.ticketId))
          // The merge-line timeline (BOS-769) is a record for measuring jams, not news: the "state" rows already say it moved.
          .where(and(eq(activity.companyId, companyId), gt(activity.at, from), notInArray(activity.kind, [MERGE_LINE_KIND, CHECK_REUSED_KIND]), notMe, relevant ? inArray(activity.ticketId, relevant) : undefined))
          .orderBy(desc(activity.at));

  /** Other agents' live runs that aren't owner chat: what each is doing, in the same words the dashboard uses (BOS-118). */
  const flightLines = async () => {
    const rows = await db
      .select({ agent: agents.name, ticket: tickets.title, state: tickets.systemState, ref: sql<string | null>`(select case when t."number" is null then null else coalesce(nullif(c."ticket_prefix", ''), 'T') || '-' || t."number"::text end from "tickets" t left join "companies" c on c."id" = t."company_id" where t."id" = "runs"."ticket_id")`, ...runOriginQuery("runs") })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .where(and(eq(runs.companyId, companyId), isNull(runs.endedAt), sql`${runs.purpose} is distinct from 'chat'`, agentId ? ne(runs.agentId, agentId) : undefined))
      .orderBy(asc(runs.startedAt));
    return rows.map((r) => {
      if (r.ticket) return `- ${r.agent}: "${one(r.ticket, 40)}" (${r.state})`;
      return `- ${r.agent}: ${one(runLabel(r).text, 160)}`;
    });
  };

  let body: string[];
  if (role === "ceo") {
    const counts = await db.select({ state: tickets.systemState, n: sql<number>`count(*)::int` }).from(tickets).where(eq(tickets.companyId, companyId)).groupBy(tickets.systemState);
    const n = (s: string) => counts.find((c) => c.state === s)?.n ?? 0;
    const needs = await db
      .select({ t: tickets, who: agents.name })
      .from(tickets)
      .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
      .where(
        and(
          eq(tickets.companyId, companyId),
          or(inArray(tickets.systemState, ["review", "blocked"]), and(inArray(tickets.systemState, ["ready", "in_progress"]), lt(tickets.lastActivityAt, new Date(now.getTime() - 24 * 3_600_000)))),
        ),
      )
      .orderBy(asc(tickets.lastActivityAt));
    const open = await db.select().from(decisions).where(and(eq(decisions.companyId, companyId), eq(decisions.tier, "ceo"), eq(decisions.status, "open"))).orderBy(asc(decisions.createdAt));
    const needLines = [
      ...open.map((d) => `- Decision: "${one(d.question, 120)}" (recommended: ${one(d.recommendedOption, 80)})`),
      ...needs
        .sort((a, b) => Number(b.t.systemState === "review") - Number(a.t.systemState === "review"))
        .map(({ t, who }) => `- ${t.systemState === "review" ? "In review" : t.systemState === "blocked" ? "Blocked" : `Silent ${age(t.lastActivityAt)}`}: "${one(t.title, 60)}" (${who ?? "unassigned"}).${noteOf(t)}`),
    ];
    const done = await db.select().from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done"))).orderBy(desc(tickets.lastActivityAt)).limit(10);
    const unassigned = await db.select().from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "ready"), isNull(tickets.assigneeAgentId), eq(tickets.assignedToOwner, false))).orderBy(asc(tickets.createdAt));
    const recent = await changes(null);
    // A sample of what the PA told the owner, for the CEO to mark right or wrong (R87).
    const audit = await db.select().from(paAnswers).where(and(eq(paAnswers.companyId, companyId), eq(paAnswers.sampled, true), isNull(paAnswers.verdict))).orderBy(asc(paAnswers.createdAt));
    const hold = await getHold(db);
    // Ready work the company limit is refusing, so agents sitting idle are not a mystery (BOS-1479).
    const companyRefused = (await heldReadyTickets(db, companyId)).filter((h) => h.scope === "company").length;
    body = [
      ...(hold ? [`UPDATE PENDING: Boss Man is waiting for runs to finish so it can update the runners (${hold.reason}, since ${hold.since.slice(0, 16).replace("T", " ")} UTC). No new run starts anywhere until it is done: do not delegate new work or open new tickets for now, finish what is in flight, and leave the rest for after.`, ""] : []),
      `Tickets: ${["backlog", "ready", "in_progress", "blocked", "review", "done"].map((s) => `${s} ${n(s)}`).join(", ")}.`,
      ...(companyRefused ? [`At company limit: ${companyRefused} Ready ticket${companyRefused === 1 ? "" : "s"} refused. Agents may sit idle until one in-progress ticket finishes or the owner raises the limit in Settings.`] : []),
      ...section("Needs you", capped(needLines, 8)),
      ...section("PA answers to check", capped(audit.map((a) => `- ${a.id}: asked "${one(a.question, 100)}"; the PA said "${one(a.reply ?? "", 200)}" citing ${(a.cites as Array<{ kind: string; id: string }>).map((c) => `${c.kind} ${c.id}`).join(", ")}. Mark it with pa_verdict.`), 3)),
      ...section("In flight", capped(await flightLines(), 8)),
      ...section("Last done", [...done.map((t) => `- "${one(t.title, 60)}" (${t.outcome ?? "done"}, ${age(t.lastActivityAt)} ago).${noteOf(t)}`), ...(n("done") > done.length ? [MORE(n("done") - done.length)] : [])]),
      ...section("Ready but unassigned", capped(unassigned.map((t) => `- "${one(t.title, 60)}" (${t.id})`), 5)),
      ...section("Changes since the last brief", capped(recent.map(changeLine), 25)),
    ];
  } else {
    const mine = agentId ? await db.select().from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.assigneeAgentId, agentId), ne(tickets.systemState, "done"))).orderBy(desc(tickets.lastActivityAt)) : [];
    const ids = mine.map((t) => t.id);
    const deps = ids.length
      ? await db
          .select({ blocked: ticketDependencies.blockedTicketId, blocker: ticketDependencies.blockerTicketId, ticket: tickets.title, ticketState: tickets.systemState, eng: engagements.title, engStatus: engagements.status, dec: decisions.question, decId: decisions.id, decStatus: decisions.status })
          .from(ticketDependencies)
          .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
          .leftJoin(engagements, eq(engagements.id, ticketDependencies.blockerEngagementId))
          .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
          .where(or(inArray(ticketDependencies.blockedTicketId, ids), inArray(ticketDependencies.blockerTicketId, ids)))
      : [];
    const waitsOn = (id: string) =>
      deps
        .filter((d) => d.blocked === id)
        .flatMap((d) => (d.blocker ? (d.ticketState !== "done" ? [`"${one(d.ticket ?? "", 60)}"`] : []) : d.eng ? (d.engStatus !== "signed_off" ? [`engagement "${one(d.eng, 60)}"`] : []) : d.decStatus === "open" ? [`decision "${one(d.dec ?? "", 60)}"`] : []));
    const myLines = mine.map((t) => {
      const w = waitsOn(t.id);
      return `- "${one(t.title, 60)}" (${t.id}), ${t.systemState}, v${t.version}${w.length ? `, blocked by ${w.join(", ")}` : ""}.${noteOf(t)}`;
    });
    const decIds = deps.flatMap((d) => (d.decId && d.blocked && ids.includes(d.blocked) ? [d.decId] : []));
    const asked = agentId
      ? await db
          .select()
          .from(decisions)
          .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), or(eq(decisions.raisedByAgentId, agentId), decIds.length ? inArray(decisions.id, decIds) : undefined)))
          .orderBy(asc(decisions.createdAt))
      : [];
    // My tickets, what they wait on and what waits on them; a decision counts through the ticket it blocks.
    const relevant = [...new Set([...ids, ...deps.flatMap((d) => [d.blocked, d.blocker])])].filter((x): x is string => !!x);
    body = [
      ...section("My open tickets", capped(myLines, 5)),
      ...section("Your devices (layout tickets: check at these, not a guessed size)", capped(await deviceLines(mine.length > 0), 4)),
      ...section("Open decisions on my tickets", capped(asked.map((d) => `- "${one(d.question, 120)}" (recommended: ${one(d.recommendedOption, 80)})`), 3)),
      ...section("Changed since my last run", capped((await changes(relevant)).map(changeLine), 10)),
      ...section("In flight elsewhere", capped(await flightLines(), 8)),
    ];
  }
  const head = `Company brief as of ${now.toISOString().slice(0, 16).replace("T", " ")} UTC. This supersedes any earlier brief in this conversation.`;
  const rules = standingRulesSection(await getStandingRules(db, companyId));
  const text = [...rules, ...(body.length ? body : ["", "Nothing open and nothing changed."])].join("\n").trim();
  return `${head}\n\n${plain ? text : untrusted("brief: notes written by agents and the owner", text)}`;
}
