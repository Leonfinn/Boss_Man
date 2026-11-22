// Engagements (R23–R26): the only way one company asks another for work, and the only
// channel between them. Request → (counter) → agree → owner approval if the provider
// requires it → work on the provider's own tickets → deliver → sign-off or revision.
// The requester sees the status and the thread, never the provider's tickets.
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { olderThan, pageLimit, type Page } from "./list-page.js";
import { findCredential, untrusted, UNTRUSTED_NOTE, usdToMicros } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { closeCardBySystem } from "./card-validity.js";
import { agents, companies, costEvents, decisions, engagementMessages, engagements, projects, ticketDependencies } from "../db/schema.js";

export class EngagementError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Actor = { companyId: string; agentId: string | null; runId?: string | null };

export type Terms = { scope?: string; deliverables?: string; acceptanceCriteria?: string[]; budgetCapUsd?: number };

export type EngagementAction =
  | { action: "accept" }
  | { action: "reject"; message?: string }
  | ({ action: "counter"; message: string } & Terms)
  | { action: "accept_counter" }
  | { action: "withdraw"; message?: string }
  | { action: "message"; message: string }
  | { action: "deliver"; summary: string; refs?: string[] }
  | { action: "sign_off"; message?: string }
  | { action: "request_revision"; message: string };

type Engagement = typeof engagements.$inferSelect;
type WakeHook = (input: { agentId: string; reason: string; note: string; priority?: number; causedByRunId?: string | null }) => Promise<unknown>;

const OPEN: Engagement["status"][] = ["requested", "countered", "accepted", "in_progress", "delivered"];

/** Who may take each action, and from which statuses. */
const RULES: Record<EngagementAction["action"], { side: "requester" | "provider" | "either"; from: Engagement["status"][] }> = {
  accept: { side: "provider", from: ["requested"] },
  reject: { side: "provider", from: ["requested", "countered"] },
  counter: { side: "provider", from: ["requested"] },
  accept_counter: { side: "requester", from: ["countered"] },
  withdraw: { side: "requester", from: ["requested", "countered", "accepted", "in_progress"] },
  message: { side: "either", from: OPEN },
  deliver: { side: "provider", from: ["accepted", "in_progress"] },
  sign_off: { side: "requester", from: ["delivered"] },
  request_revision: { side: "requester", from: ["delivered"] },
};

/** Refuses text that looks like it carries a credential (R24). */
function guard(...texts: Array<string | undefined | null>) {
  for (const t of texts) {
    const what = t ? findCredential(t) : null;
    if (what) throw new EngagementError(422, `That looks like it contains ${what}. Engagements never carry credentials: ask the owner to grant the secret to the other company instead.`);
  }
}

const THREAD_SHOWN = 20;

export function engagementsService(db: Db, deps: { release: (ticketId: string) => Promise<unknown>; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  let wake: WakeHook | null = null;

  async function load(id: string) {
    const [e] = await db.select().from(engagements).where(eq(engagements.id, id));
    if (!e) throw new EngagementError(404, "No such engagement.");
    return e;
  }

  async function companyName(id: string) {
    const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, id));
    return c?.name ?? "another company";
  }

  async function post(e: Engagement, fromCompanyId: string, kind: string, body: string) {
    await db.insert(engagementMessages).values({ engagementId: e.id, fromCompanyId, kind, body, createdAt: now() });
  }

  async function wakeCeo(companyId: string, e: Engagement, note: string, causedByRunId?: string | null) {
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
    // The provider didn't write the title; it's the requester's text (R51).
    const title = companyId === e.providerCompanyId ? `\n${untrusted(await companyName(e.requesterCompanyId), `Title: ${e.title}`)}\n` : ` "${e.title}": `;
    if (ceo && wake) await wake({ agentId: ceo.id, reason: "engagement", note: `Engagement ${e.id}${title}${note}`, causedByRunId });
  }

  /** Another company's words, marked as untrusted for the agent reading them (R51). */
  const from = async (companyId: string, text: string) => untrusted(await companyName(companyId), text);

  async function setStatus(e: Engagement, status: Engagement["status"], extra: Partial<Engagement> = {}) {
    const [row] = await db.update(engagements).set({ status, ...extra }).where(eq(engagements.id, e.id)).returning();
    return row!;
  }

  /** The owner's approval row dies with the engagement: closed by Boss Man, never answered (DR-061 Q4). */
  async function closeApprovalCards(e: Engagement) {
    const open = await db.select({ id: decisions.id, companyId: decisions.companyId, question: decisions.question }).from(decisions).where(and(eq(decisions.kind, "engagement"), eq(decisions.status, "open"), eq(decisions.companyId, e.providerCompanyId), sql`${decisions.context}->>'engagementId' = ${e.id}`));
    for (const d of open) await closeCardBySystem(db, d, `the engagement "${e.title}" is ${e.status.replace("_", " ")}`, { release: deps.release, now });
  }

  async function startWork(e: Engagement, causedByRunId?: string | null) {
    const accepted = await setStatus(e, "accepted");
    await wakeCeo(
      e.providerCompanyId,
      accepted,
      `the deal is agreed. Plan the work as tickets in your own company and pass engagementId "${e.id}" to create_ticket so the cost is charged back. Deliver with the engagement tool when it meets the acceptance criteria.`,
      causedByRunId,
    );
    return accepted;
  }

  /** Both sides agree. The owner approves first if the provider company requires it. */
  async function agree(e: Engagement, actor: Actor) {
    const [provider] = await db.select().from(companies).where(eq(companies.id, e.providerCompanyId));
    if (!provider?.ownerApprovesEngagements) return { engagement: await startWork(e, actor.runId), note: "Agreed. Work can start." };
    const open = await db
      .select({ context: decisions.context })
      .from(decisions)
      .where(and(eq(decisions.kind, "engagement"), eq(decisions.status, "open"), eq(decisions.companyId, e.providerCompanyId)));
    if (!open.some((d) => (d.context as { engagementId?: string }).engagementId === e.id)) {
      const cap = e.budgetCapMicros != null ? `, capped at $${(e.budgetCapMicros / 1e6).toFixed(2)}` : ", with no cost cap";
      await db.insert(decisions).values({
        companyId: e.providerCompanyId,
        kind: "engagement",
        question: `${provider.name} has agreed to do "${e.title}" for ${await companyName(e.requesterCompanyId)}${cap}. Approve the work?`,
        options: ["Approve", "Reject"],
        recommendedOption: "Approve",
        raisedByAgentId: actor.agentId,
        context: { type: "engagement", engagementId: e.id },
      });
    }
    await post(e, e.providerCompanyId, "awaiting_approval", "Agreed; waiting for the owner to approve.");
    return { engagement: e, note: "Agreed. The owner approves before work starts; you'll be woken when they do." };
  }

  return {
    setWakeHook(hook: WakeHook) {
      wake = hook;
    },

    async request(
      actor: Actor,
      input: { providerCompanyId: string; title: string; scope: string; deliverables?: string; acceptanceCriteria: string[]; budgetCapUsd?: number; requesterProjectId?: string | null },
    ) {
      if (input.providerCompanyId === actor.companyId) throw new EngagementError(422, "A company can't engage itself; create a ticket instead.");
      guard(input.title, input.scope, input.deliverables, ...input.acceptanceCriteria);
      if (input.requesterProjectId) {
        const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.requesterProjectId), eq(projects.companyId, actor.companyId)));
        if (!p) throw new EngagementError(422, "That project isn't in the requesting company.");
      }
      const [e] = await db
        .insert(engagements)
        .values({
          requesterCompanyId: actor.companyId,
          requesterProjectId: input.requesterProjectId ?? null,
          providerCompanyId: input.providerCompanyId,
          title: input.title,
          scope: input.scope,
          deliverables: input.deliverables ?? null,
          acceptanceCriteria: input.acceptanceCriteria,
          budgetCapMicros: input.budgetCapUsd != null ? usdToMicros(input.budgetCapUsd) : null,
          createdAt: now(),
        })
        .returning();
      await post(e!, actor.companyId, "requested", input.scope);
      const fromName = await companyName(actor.companyId);
      await wakeCeo(
        input.providerCompanyId,
        e!,
        `${fromName} asks for this work.\n${untrusted(fromName, `Scope: ${input.scope}\nAcceptance criteria: ${input.acceptanceCriteria.join("; ")}`)}${input.budgetCapUsd != null ? `\nCost cap: $${input.budgetCapUsd}` : ""}\nUse the engagement tool to accept, reject, or counter with changed terms.`,
        actor.runId,
      );
      return e!;
    },

    /** One step in the lifecycle, taken by the requester's or the provider's side. */
    async act(id: string, actor: Actor, a: EngagementAction) {
      let e = await load(id);
      const side = actor.companyId === e.requesterCompanyId ? "requester" : actor.companyId === e.providerCompanyId ? "provider" : null;
      if (!side) throw new EngagementError(404, "No such engagement.");
      const rule = RULES[a.action];
      if (rule.side !== "either" && rule.side !== side) throw new EngagementError(403, `Only the ${rule.side} can ${a.action.replace("_", " ")}.`);
      if (!rule.from.includes(e.status)) throw new EngagementError(409, `Can't ${a.action.replace("_", " ")} an engagement that is ${e.status.replace("_", " ")}.`);
      const other = side === "requester" ? e.providerCompanyId : e.requesterCompanyId;

      switch (a.action) {
        case "accept":
          await post(e, actor.companyId, "accepted", "Accepted.");
          return agree(e, actor);
        case "reject":
          guard(a.message);
          e = await setStatus(e, "rejected");
          await closeApprovalCards(e);
          await post(e, actor.companyId, "rejected", a.message ?? "Declined.");
          await wakeCeo(other, e, `${await companyName(actor.companyId)} declined.\n${await from(actor.companyId, a.message ?? "No reason given.")}\nFind another way, or drop the dependency on it.`, actor.runId);
          return { engagement: e, note: "Declined." };
        case "counter": {
          guard(a.message, a.scope, a.deliverables, ...(a.acceptanceCriteria ?? []));
          const terms: Terms = { scope: a.scope, deliverables: a.deliverables, acceptanceCriteria: a.acceptanceCriteria, budgetCapUsd: a.budgetCapUsd };
          e = await setStatus(e, "countered", { counterTerms: terms });
          await post(e, actor.companyId, "countered", a.message);
          await wakeCeo(other, e, `${await companyName(actor.companyId)} proposes changes.\n${await from(actor.companyId, `${a.message}\nProposed terms: ${JSON.stringify(terms)}`)}\nUse the engagement tool to accept_counter, or withdraw.`, actor.runId);
          return { engagement: e, note: "Counter-proposal sent." };
        }
        case "accept_counter": {
          const t = (e.counterTerms ?? {}) as Terms;
          e = await setStatus(e, "requested", {
            counterTerms: null,
            ...(t.scope ? { scope: t.scope } : {}),
            ...(t.deliverables ? { deliverables: t.deliverables } : {}),
            ...(t.acceptanceCriteria ? { acceptanceCriteria: t.acceptanceCriteria } : {}),
            ...(t.budgetCapUsd != null ? { budgetCapMicros: usdToMicros(t.budgetCapUsd) } : {}),
          });
          await post(e, actor.companyId, "accepted", "Accepted the proposed changes.");
          return agree(e, actor);
        }
        case "withdraw":
          guard(a.message);
          e = await setStatus(e, "rejected");
          await closeApprovalCards(e);
          await post(e, actor.companyId, "withdrawn", a.message ?? "Withdrawn.");
          await wakeCeo(other, e, "the requester withdrew it. Stop any work on it.", actor.runId);
          return { engagement: e, note: "Withdrawn." };
        case "message":
          guard(a.message);
          await post(e, actor.companyId, "message", a.message);
          await wakeCeo(other, e, `new message from ${await companyName(actor.companyId)}:\n${await from(actor.companyId, a.message)}`, actor.runId);
          return { engagement: e, note: "Sent." };
        case "deliver": {
          guard(a.summary, ...(a.refs ?? []));
          e = await setStatus(e, "delivered", { delivery: { summary: a.summary, refs: a.refs ?? [], at: now().toISOString() } });
          await post(e, actor.companyId, "delivered", [a.summary, ...(a.refs ?? []).map((r) => `- ${r}`)].join("\n"));
          await wakeCeo(
            other,
            e,
            `${await companyName(actor.companyId)} has delivered:\n${await from(actor.companyId, [a.summary, ...(a.refs ?? []).map((r) => `- ${r}`)].join("\n"))}\nCheck it against your acceptance criteria (${(e.acceptanceCriteria as string[]).join("; ")}), then sign_off or request_revision.`,
            actor.runId,
          );
          return { engagement: e, note: "Delivered. The requester signs off or asks for a revision." };
        }
        case "sign_off": {
          guard(a.message);
          e = await setStatus(e, "signed_off");
          await post(e, actor.companyId, "signed_off", a.message ?? "Signed off.");
          // The requester's tickets that waited on this can move.
          const blocked = await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerEngagementId, e.id));
          for (const b of blocked) await deps.release(b.id);
          return { engagement: e, note: "Signed off." };
        }
        case "request_revision":
          guard(a.message);
          e = await setStatus(e, "in_progress");
          await post(e, actor.companyId, "revision_requested", a.message);
          await wakeCeo(other, e, `${await companyName(actor.companyId)} asks for a revision:\n${await from(actor.companyId, a.message)}`, actor.runId);
          return { engagement: e, note: "Revision requested." };
      }
    },

    /** The owner's answer to an approval row. */
    async approve(id: string, approved: boolean) {
      const e = await load(id);
      if (!["requested", "countered"].includes(e.status)) return e;
      if (approved) {
        await post(e, e.providerCompanyId, "approved", "The owner approved the work.");
        return startWork(e);
      }
      const rejected = await setStatus(e, "rejected");
      await post(e, e.providerCompanyId, "rejected", "The owner declined this work.");
      await wakeCeo(e.requesterCompanyId, rejected, "the owner declined it. Find another way, or drop the dependency on it.");
      return rejected;
    },

    /** A provider ticket that does work for the engagement; the first one moves it to in progress. */
    async linkTicket(engagementId: string, providerCompanyId: string) {
      const e = await load(engagementId);
      if (e.providerCompanyId !== providerCompanyId) throw new EngagementError(422, "Only the providing company's tickets can do an engagement's work.");
      if (!["accepted", "in_progress"].includes(e.status)) throw new EngagementError(409, `The engagement is ${e.status.replace("_", " ")}; work starts once it is accepted.`);
      if (e.status === "accepted") await setStatus(e, "in_progress");
      return e;
    },

    /** Status, terms and thread: everything either side may see. */
    async view(id: string, companyId?: string, all = false) {
      const e = await load(id);
      if (companyId && companyId !== e.requesterCompanyId && companyId !== e.providerCompanyId) throw new EngagementError(404, "No such engagement.");
      const thread = await db
        .select({ from: companies.name, fromCompanyId: engagementMessages.fromCompanyId, kind: engagementMessages.kind, body: engagementMessages.body, at: engagementMessages.createdAt })
        .from(engagementMessages)
        .innerJoin(companies, eq(companies.id, engagementMessages.fromCompanyId))
        .where(eq(engagementMessages.engagementId, id))
        .orderBy(asc(engagementMessages.createdAt));
      // For an agent of one side, everything the other side wrote is untrusted (R51).
      const theirs = companyId ? (companyId === e.requesterCompanyId ? e.providerCompanyId : e.requesterCompanyId) : null;
      const theirName = theirs ? await companyName(theirs) : null;
      const mark = (text: string, authorCompanyId: string) => (theirs && authorCompanyId === theirs ? untrusted(theirName!, text) : text);
      return {
        ...(theirs ? { notice: UNTRUSTED_NOTE } : {}),
        id: e.id,
        title: mark(e.title, e.requesterCompanyId),
        status: e.status,
        requester: await companyName(e.requesterCompanyId),
        provider: await companyName(e.providerCompanyId),
        scope: mark(e.scope, e.requesterCompanyId),
        deliverables: e.deliverables ? mark(e.deliverables, e.requesterCompanyId) : null,
        acceptanceCriteria: e.acceptanceCriteria,
        budgetCapUsd: e.budgetCapMicros != null ? e.budgetCapMicros / 1e6 : null,
        // What the requester has been charged so far (R26).
        spentUsd:
          Number(
            (
              await db
                .select({ micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
                .from(costEvents)
                .where(and(eq(costEvents.engagementId, e.id), isNotNull(costEvents.chargedCompanyId)))
            )[0]?.micros ?? 0,
          ) / 1e6,
        counterTerms: e.counterTerms && theirs === e.providerCompanyId ? untrusted(theirName!, JSON.stringify(e.counterTerms)) : e.counterTerms,
        delivery: e.delivery && theirs === e.providerCompanyId ? untrusted(theirName!, JSON.stringify(e.delivery)) : e.delivery,
        ...(!all && thread.length > THREAD_SHOWN ? { earlierNotShown: `${thread.length - THREAD_SHOWN} earlier messages not shown; pass all: true to see the whole thread.` } : {}),
        thread: (all ? thread : thread.slice(-THREAD_SHOWN)).map((m) => ({ ...m, body: mark(m.body, m.fromCompanyId) })),
      };
    },

    /** Newest first, one page at a time (BOS-2165): the page polls it and the MCP list puts it in an agent's context. */
    async list(companyId?: string, page: Page & { status?: Engagement["status"] | "open" } = {}) {
      const statusFilter = !page.status ? undefined : page.status === "open" ? inArray(engagements.status, OPEN) : eq(engagements.status, page.status);
      const rows = await db
        .select()
        .from(engagements)
        .where(and(statusFilter, companyId ? or(eq(engagements.requesterCompanyId, companyId), eq(engagements.providerCompanyId, companyId)) : undefined, page.before ? olderThan(engagements, engagements, page.before) : undefined))
        .orderBy(desc(engagements.createdAt), desc(engagements.id))
        .limit(pageLimit(page.limit));
      const ids = [...new Set(rows.flatMap((r) => [r.requesterCompanyId, r.providerCompanyId]))];
      const names = new Map(ids.length ? (await db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, ids))).map((c) => [c.id, c.name]) : []);
      return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, requester: names.get(r.requesterCompanyId), provider: names.get(r.providerCompanyId), budgetCapUsd: r.budgetCapMicros != null ? r.budgetCapMicros / 1e6 : null }));
    },
  };
}
