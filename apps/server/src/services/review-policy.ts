// Review routing: which policy applies to a ticket, and who it names once paused, retired, missing or
// conflicted agents are accounted for. The CEO is always the fallback.
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max, ne, or } from "drizzle-orm";
import { MARKED, policyAgentIds, REVIEW_KINDS, ReviewPolicySchema, RISK_TIERS, ruleFor, SENIOR_DEV, SENIOR_DEV_TEMPLATE, type ReviewerRefValue, type ReviewKind, type ReviewPolicy, type ReviewSlot, type RiskTier } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, projects, reviewRequests, runs, tickets } from "../db/schema.js";

type Who = { id: string; name: string };
export type Resolved = { agent: Who | null; /** Why the CEO stands in, for the ticket's activity; null when no stand-in was needed. */ note: string | null };

/** The project's override if it has one, else the company's. */
export async function effectivePolicy(db: Db, t: { companyId: string; projectId: string }): Promise<ReviewPolicy> {
  const [p] = await db.select({ policy: projects.reviewPolicy }).from(projects).where(eq(projects.id, t.projectId));
  if (p?.policy) return p.policy;
  const [c] = await db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, t.companyId));
  return c!.policy;
}

/** Validates a policy, and that every agent it names is an active agent of the company; returns the policy or what is wrong with it. */
export async function checkPolicy(db: Db, companyId: string, body: unknown): Promise<ReviewPolicy | string> {
  const parsed = ReviewPolicySchema.safeParse(body);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  const named = policyAgentIds(parsed.data);
  if (named.length) {
    const ok = new Set((await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt), inArray(agents.id, named)))).map((a) => a.id));
    const bad = named.find((a) => !ok.has(a));
    if (bad) return `Agent ${bad} isn't an active agent of this company.`;
  }
  return parsed.data;
}

/**
 * Turns a policy's reviewer or plan approver ("ceo", "senior-dev" or an agent id) into an agent.
 * `author` is who did the work: nobody reviews their own. An unavailable pick falls back to the CEO.
 */
export async function resolveActor(db: Db, companyId: string, ref: string, author: string | null): Promise<Resolved> {
  const r = await pick(db, companyId, ref, author);
  if (!author || r.agent?.id !== author) return r;
  // The CEO did the work, and every route ended back at the CEO: a senior developer reviews it, else nobody can and the owner does.
  const [senior] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.template, SENIOR_DEV_TEMPLATE), eq(agents.paused, false), isNull(agents.retiredAt)))
    .orderBy(asc(agents.createdAt))
    .limit(1);
  return senior ? { agent: senior, note: `The CEO did this work, so ${senior.name} reviews it` } : { agent: null, note: "The CEO did this work and no other agent can review it, so it waits for the owner" };
}

async function pick(db: Db, companyId: string, ref: string, author: string | null): Promise<Resolved> {
  const [ceo] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const fallback = (name: string | null): Resolved => ({ agent: ceo ?? null, note: name ? `${name} is unavailable, so the CEO reviews it` : null });
  if (ref === "ceo") return { agent: ceo ?? null, note: null };
  const pool = await db
    .select({ id: agents.id, name: agents.name, paused: agents.paused, retired: agents.retiredAt })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ref === SENIOR_DEV ? eq(agents.template, SENIOR_DEV_TEMPLATE) : eq(agents.id, ref), ...(ref === SENIOR_DEV ? [isNull(agents.retiredAt)] : [])))
    .orderBy(asc(agents.createdAt));
  const ok = pool.find((a) => !a.paused && !a.retired && a.id !== author);
  if (ok) return { agent: { id: ok.id, name: ok.name }, note: null };
  // No senior developer hired at all is the default's normal case, not an outage.
  return fallback(pool[0]?.name ?? (ref === SENIOR_DEV ? null : "The chosen agent"));
}

/** Who the ticket's code review goes to under its policy. */
export const resolveReviewer = async (db: Db, t: ReviewTicket & { projectId: string; risk: RiskTier | null }) => resolveKindReviewer(db, t, "code", ruleFor(await effectivePolicy(db, t), t.risk).reviewer);

/**
 * The ticket a review is for; its id finds who worked on it and its earlier rounds.
 * `assigneeAgentId` is the author; nobody reviews their own work.
 */
export type ReviewTicket = { id: string; companyId: string; assigneeAgentId: string | null };

/**
 * A slot's reviewer. A list of agents goes through pickFromList; "marked" is the legacy agent-page
 * mark (still honoured, see MARKED); anything else is one actor, resolved exactly as before.
 */
export async function resolveKindReviewer(db: Db, t: ReviewTicket, kind: ReviewSlot, ref: ReviewerRefValue): Promise<Resolved> {
  if (Array.isArray(ref)) return pickFromList(db, t, kind, ref);
  if (ref !== MARKED) return resolveActor(db, t.companyId, ref, t.assigneeAgentId);
  const pool = await db
    .select({ id: agents.id, name: agents.name, paused: agents.paused })
    .from(agents)
    .where(and(eq(agents.companyId, t.companyId), eq(agents.reviewKind, kind), isNull(agents.retiredAt)))
    .orderBy(asc(agents.createdAt));
  const ok = pool.find((a) => !a.paused && a.id !== t.assigneeAgentId);
  if (ok) return { agent: { id: ok.id, name: ok.name }, note: null };
  const { agent } = await resolveActor(db, t.companyId, "ceo", t.assigneeAgentId);
  return { agent, note: pool[0] ? `${pool[0].name} is unavailable, so the CEO reviews it (${kind})` : `No ${kind} reviewer is marked, so the CEO reviews it` };
}

/**
 * Who did a ticket's work: the assignee, and every agent with a work run on it. Commits are all
 * authored "Boss Man", so git can't tell; and reviewers' runs carry the ticket too, so an agent that
 * holds one of its reviews counts as a reviewer, not a worker.
 */
async function workersOf(db: Db, t: ReviewTicket): Promise<Set<string>> {
  const ran = await db.selectDistinct({ id: runs.agentId }).from(runs).where(and(eq(runs.ticketId, t.id), or(isNull(runs.purpose), ne(runs.purpose, "chat"))));
  const reviewed = new Set((await db.selectDistinct({ id: reviewRequests.reviewerAgentId }).from(reviewRequests).where(eq(reviewRequests.ticketId, t.id))).map((r) => r.id));
  const out = new Set(ran.map((r) => r.id).filter((id): id is string => !!id && !reviewed.has(id)));
  if (t.assigneeAgentId) out.add(t.assigneeAgentId);
  return out;
}

/** The listed agents who can take a review of this ticket, in list order, and why each other one can't. */
async function eligibleOf(db: Db, t: ReviewTicket, ids: string[], extraExclude: string[] = []): Promise<{ ok: Who[]; why: string[] }> {
  const pool = ids.length ? await db.select({ id: agents.id, name: agents.name, paused: agents.paused, retired: agents.retiredAt }).from(agents).where(and(eq(agents.companyId, t.companyId), inArray(agents.id, ids))) : [];
  const workers = await workersOf(db, t);
  const ok: Who[] = [];
  const why: string[] = [];
  for (const id of ids) {
    const a = pool.find((p) => p.id === id);
    if (!a) why.push("a listed agent is no longer in the company");
    else if (a.retired) why.push(`${a.name} is retired`);
    else if (a.paused) why.push(`${a.name} is paused`);
    else if (workers.has(a.id)) why.push(`${a.name} worked on it`);
    else if (!extraExclude.includes(a.id)) ok.push({ id: a.id, name: a.name });
  }
  return { ok, why };
}

/**
 * Orders agents for a new review: fewest pending reviews on tickets now in review first; a tie goes
 * to the one given a review least recently (never is earliest), then to list order. Load is counted
 * across the company, so an agent listed in several cells isn't handed more than its share.
 */
export async function byLoad(db: Db, who: Who[]): Promise<Who[]> {
  if (who.length < 2) return who;
  const ids = who.map((w) => w.id);
  const open = await db
    .select({ id: reviewRequests.reviewerAgentId, n: count() })
    .from(reviewRequests)
    .innerJoin(tickets, eq(tickets.id, reviewRequests.ticketId))
    .where(and(inArray(reviewRequests.reviewerAgentId, ids), eq(reviewRequests.status, "pending"), eq(tickets.systemState, "review")))
    .groupBy(reviewRequests.reviewerAgentId);
  const last = await db.select({ id: reviewRequests.reviewerAgentId, at: max(reviewRequests.createdAt) }).from(reviewRequests).where(inArray(reviewRequests.reviewerAgentId, ids)).groupBy(reviewRequests.reviewerAgentId);
  const n = (id: string) => open.find((o) => o.id === id)?.n ?? 0;
  const at = (id: string) => last.find((l) => l.id === id)?.at?.getTime() ?? 0;
  return who.map((w, i) => ({ w, i })).sort((a, b) => n(a.w.id) - n(b.w.id) || at(a.w.id) - at(b.w.id) || a.i - b.i).map(({ w }) => w);
}

/**
 * One review of this slot for a cell that lists several agents. Never someone who worked on the
 * ticket, nobody paused or retired. The reviewer of the ticket's previous round for this slot keeps it
 * while they can, so round 2 has their context; otherwise the least loaded (byLoad). With nobody
 * eligible it falls back to the CEO, as a single unavailable pick does, and says why.
 */
export async function pickFromList(db: Db, t: ReviewTicket, kind: ReviewSlot, ids: string[]): Promise<Resolved> {
  const { ok, why } = await eligibleOf(db, t, ids);
  const [prev] = await db
    .select({ id: reviewRequests.reviewerAgentId })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.ticketId, t.id), eq(reviewRequests.kind, kind), isNotNull(reviewRequests.reviewerAgentId)))
    .orderBy(desc(reviewRequests.round))
    .limit(1);
  const kept = ok.find((a) => a.id === prev?.id);
  if (kept) return { agent: kept, note: null };
  const [first] = await byLoad(db, ok);
  if (first) return { agent: first, note: null };
  const r = await resolveActor(db, t.companyId, "ceo", t.assigneeAgentId);
  const reason = [...new Set(why)].join("; ") || "nobody is listed";
  return { agent: r.agent, note: `No listed ${kind} reviewer can take it (${reason}), so ${r.agent?.name ?? "the owner"} reviews it` };
}

/**
 * Other agents who could take a review of this kind from the one holding it: the rest of the senior
 * developers, the other listed agents (least loaded first), or the other agents marked for the kind.
 * A review the policy gives to one named agent (or the CEO) has no stand-in. Nobody paused or
 * retired, and never the author.
 */
export async function otherReviewers(db: Db, t: ReviewTicket, kind: ReviewSlot, ref: ReviewerRefValue, exclude: string[]): Promise<Who[]> {
  if (Array.isArray(ref)) return byLoad(db, (await eligibleOf(db, t, ref, exclude)).ok);
  if (ref !== SENIOR_DEV && ref !== MARKED) return [];
  const pool = await db
    .select({ id: agents.id, name: agents.name, paused: agents.paused })
    .from(agents)
    .where(and(eq(agents.companyId, t.companyId), isNull(agents.retiredAt), ref === SENIOR_DEV ? eq(agents.template, SENIOR_DEV_TEMPLATE) : eq(agents.reviewKind, kind)))
    .orderBy(asc(agents.createdAt));
  return pool.filter((a) => !a.paused && a.id !== t.assigneeAgentId && !exclude.includes(a.id)).map(({ id, name }) => ({ id, name }));
}

/**
 * The skill add flow's security reviewers: the agents the company's policy names for security reviews
 * at any tier (projects' overrides aside, as a skill belongs to the company). A cell set to the CEO
 * names nobody here, as the CEO proposes skills; a "senior-dev" cell counts the senior developers
 * (BOS-220). A legacy "marked" cell still counts the agent marked for security. Retired agents and the
 * CEO never count; paused ones are listed.
 */
export async function securityReviewers(db: Db, companyId: string): Promise<Array<Who & { paused: boolean }>> {
  const [c] = await db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, companyId));
  const refs = c ? RISK_TIERS.map((t) => c.policy[t].kinds?.security).filter((r) => r !== undefined) : [];
  const ids = [...new Set(refs.flatMap((r) => (Array.isArray(r) ? r : r === "ceo" || r === SENIOR_DEV || r === MARKED ? [] : [r])))];
  const marked = refs.includes(MARKED);
  const senior = refs.includes(SENIOR_DEV);
  if (!ids.length && !marked && !senior) return [];
  const named = or(...(ids.length ? [inArray(agents.id, ids)] : []), ...(marked ? [eq(agents.reviewKind, "security")] : []), ...(senior ? [eq(agents.template, SENIOR_DEV_TEMPLATE)] : []));
  // Never the CEO, even if a policy names it by id: the CEO proposes skills, so it must not judge them.
  return db.select({ id: agents.id, name: agents.name, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt), ne(agents.role, "ceo"), named)).orderBy(asc(agents.createdAt));
}

/** The legacy agent-page marks, by kind (oldest first, retired agents left out), for normaliseMarked. */
export async function legacyMarks(db: Db, companyId: string): Promise<Partial<Record<ReviewKind, string[]>>> {
  const rows = await db.select({ id: agents.id, kind: agents.reviewKind }).from(agents).where(and(eq(agents.companyId, companyId), isNotNull(agents.reviewKind), isNull(agents.retiredAt))).orderBy(asc(agents.createdAt), asc(agents.id));
  const out: Partial<Record<ReviewKind, string[]>> = {};
  for (const r of rows) if ((REVIEW_KINDS as readonly string[]).includes(r.kind!)) (out[r.kind as ReviewKind] ??= []).push(r.id);
  return out;
}
