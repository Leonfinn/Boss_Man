// Review routing: which policy applies to a ticket, and who it names once paused, retired, missing or
// conflicted agents are accounted for. The CEO is always the fallback.
import { and, asc, eq, isNull } from "drizzle-orm";
import { MARKED, ruleFor, SENIOR_DEV, SENIOR_DEV_TEMPLATE, type ReviewPolicy, type ReviewSlot, type RiskTier } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, projects } from "../db/schema.js";

type Who = { id: string; name: string };
export type Resolved = { agent: Who | null; /** Why the CEO stands in, for the ticket's activity; null when no stand-in was needed. */ note: string | null };

/** The project's override if it has one, else the company's. */
export async function effectivePolicy(db: Db, t: { companyId: string; projectId: string }): Promise<ReviewPolicy> {
  const [p] = await db.select({ policy: projects.reviewPolicy }).from(projects).where(eq(projects.id, t.projectId));
  if (p?.policy) return p.policy;
  const [c] = await db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, t.companyId));
  return c!.policy;
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

export const resolveReviewer = async (db: Db, t: { companyId: string; projectId: string; risk: RiskTier | null; assigneeAgentId: string | null }) =>
  resolveActor(db, t.companyId, ruleFor(await effectivePolicy(db, t), t.risk).reviewer, t.assigneeAgentId);

/**
 * A review kind's reviewer. "marked" is the agent the owner marked as the company's reviewer of that
 * kind; with none available the CEO stands in, like any other unavailable pick.
 */
export async function resolveKindReviewer(db: Db, companyId: string, kind: ReviewSlot, ref: string, author: string | null): Promise<Resolved> {
  if (ref !== MARKED) return resolveActor(db, companyId, ref, author);
  const pool = await db
    .select({ id: agents.id, name: agents.name, paused: agents.paused })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.reviewKind, kind), isNull(agents.retiredAt)))
    .orderBy(asc(agents.createdAt));
  const ok = pool.find((a) => !a.paused && a.id !== author);
  if (ok) return { agent: { id: ok.id, name: ok.name }, note: null };
  const { agent } = await resolveActor(db, companyId, "ceo", author);
  return { agent, note: pool[0] ? `${pool[0].name} is unavailable, so the CEO reviews it (${kind})` : `No ${kind} reviewer is marked, so the CEO reviews it` };
}

/**
 * Other agents who could take a review of this kind from the one holding it: the rest of the senior
 * developers, or the other agents marked for the kind. A review the policy gives to one named agent
 * (or the CEO) has no stand-in. Nobody paused or retired, and never the author.
 */
export async function otherReviewers(db: Db, companyId: string, kind: ReviewSlot, ref: string, author: string | null, exclude: string[]): Promise<Who[]> {
  if (ref !== SENIOR_DEV && ref !== MARKED) return [];
  const pool = await db
    .select({ id: agents.id, name: agents.name, paused: agents.paused })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt), ref === SENIOR_DEV ? eq(agents.template, SENIOR_DEV_TEMPLATE) : eq(agents.reviewKind, kind)))
    .orderBy(asc(agents.createdAt));
  return pool.filter((a) => !a.paused && a.id !== author && !exclude.includes(a.id)).map(({ id, name }) => ({ id, name }));
}
