// Feature requests (inspired by Productboard; Boss Man's own design and code). Feedback arrives
// as notes; passages of a note are linked to features as insights, each with how much it
// matters to that person. Features are scored on demand (from their insights) and on the
// company's own criteria, then divided by effort. Tickets deliver features.
import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { featureHorizon, demandScore, IMPORTANCE_LABEL, IMPORTANCE_POINTS, priorityScore, suggestFeatures, untrusted, type FeatureStatus, type Horizon, type Importance, type NoteSource } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { scheduleGoalCheck } from "./goal-check.js";
import { agents, companies, deploys, deployTargets, feedbackCustomers, feedbackNotes, feedbackSettings, featureAreas, featureDrivers, features, insights, milestones, objectives, tickets } from "../db/schema.js";

export class FeedbackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type FeedbackSettings = { demandWeight: number; ceoTriage: boolean; portalEnabled: boolean; portalToken: string | null; portalTitle: string | null; portalIntro: string | null; hasLogo: boolean };
const DEFAULTS: Omit<FeedbackSettings, never> = { demandWeight: 3, ceoTriage: false, portalEnabled: false, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false };

type FeaturePatch = {
  title?: string;
  description?: string | null;
  status?: FeatureStatus;
  areaId?: string | null;
  parentId?: string | null;
  effort?: number | null;
  rank?: number | null;
  horizon?: Horizon | null;
  driverScores?: Record<string, number | null>;
  milestoneId?: string | null;
  objectiveId?: string | null;
  portalVisible?: boolean;
  publicSummary?: string | null;
  showPublicly?: boolean;
};

export type NoteInput = {
  title?: string | null;
  text: string;
  source?: NoteSource;
  customerId?: string | null;
  customer?: { name: string; email?: string | null; segment?: string | null } | null;
  untrusted?: boolean;
  createdByAgentId?: string | null;
  portalVoter?: string | null;
};

export function feedbackService(
  db: Db,
  deps: { now?: () => Date; onNote?: (note: typeof feedbackNotes.$inferSelect) => unknown; onReleased?: (feature: typeof features.$inferSelect) => unknown } = {},
) {
  const now = deps.now ?? (() => new Date());

  async function own<T extends { companyId: string }>(rows: Promise<T[]>, companyId: string | undefined, what: string): Promise<T> {
    const [row] = await rows;
    if (!row || (companyId && row.companyId !== companyId)) throw new FeedbackError(404, `No such ${what}.`);
    return row;
  }
  const feature = (id: string, companyId?: string) => own(db.select().from(features).where(eq(features.id, id)), companyId, "feature");
  const note = (id: string, companyId?: string) => own(db.select().from(feedbackNotes).where(eq(feedbackNotes.id, id)), companyId, "note");

  async function settings(companyId: string): Promise<FeedbackSettings> {
    const [row] = await db.select({ demandWeight: feedbackSettings.demandWeight, ceoTriage: feedbackSettings.ceoTriage, portalEnabled: feedbackSettings.portalEnabled, portalToken: feedbackSettings.portalToken, portalTitle: feedbackSettings.portalTitle, portalIntro: feedbackSettings.portalIntro, hasLogo: sql<boolean>`${feedbackSettings.portalLogo} is not null` }).from(feedbackSettings).where(eq(feedbackSettings.companyId, companyId));
    return row ?? { ...DEFAULTS };
  }

  /** Checks that the links a feature points at are in its company, and the hierarchy stays one level. */
  async function checkLinks(companyId: string, patch: FeaturePatch, selfId?: string) {
    if (patch.areaId) await own(db.select().from(featureAreas).where(eq(featureAreas.id, patch.areaId)), companyId, "area");
    if (patch.parentId) {
      if (patch.parentId === selfId) throw new FeedbackError(422, "A feature can't be its own parent.");
      const parent = await feature(patch.parentId, companyId);
      if (parent.parentId) throw new FeedbackError(422, "Subfeatures can't have subfeatures of their own: pick a top-level feature.");
      if (selfId) {
        const [child] = await db.select({ id: features.id }).from(features).where(eq(features.parentId, selfId)).limit(1);
        if (child) throw new FeedbackError(422, "This feature has subfeatures, so it can't become one.");
      }
    }
    if (patch.milestoneId) {
      const [m] = await db.select({ companyId: objectives.companyId }).from(milestones).innerJoin(objectives, eq(objectives.id, milestones.objectiveId)).where(eq(milestones.id, patch.milestoneId));
      if (!m || m.companyId !== companyId) throw new FeedbackError(404, "No such milestone in this company.");
    }
    if (patch.objectiveId) {
      const [o] = await db.select({ companyId: objectives.companyId }).from(objectives).where(eq(objectives.id, patch.objectiveId));
      if (!o || o.companyId !== companyId) throw new FeedbackError(404, "No such objective in this company.");
    }
    if (patch.driverScores) {
      const ids = Object.keys(patch.driverScores);
      if (ids.length) {
        const ds = await db.select({ id: featureDrivers.id }).from(featureDrivers).where(and(eq(featureDrivers.companyId, companyId), inArray(featureDrivers.id, ids)));
        if (ds.length !== ids.length) throw new FeedbackError(422, "Score only this company's criteria.");
      }
    }
  }

  /** Every feature of a company with its demand, priority and delivery, in one pass. */
  async function scored(companyId: string) {
    const s = await settings(companyId);
    const fs = await db.select().from(features).where(eq(features.companyId, companyId)).orderBy(asc(features.createdAt));
    const drivers = await db.select().from(featureDrivers).where(eq(featureDrivers.companyId, companyId)).orderBy(asc(featureDrivers.position), asc(featureDrivers.name));
    const links = fs.length
      ? await db
          .select({ featureId: insights.featureId, importance: insights.importance, customerId: feedbackNotes.customerId, noteId: insights.noteId })
          .from(insights)
          .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
          .where(inArray(insights.featureId, fs.map((f) => f.id)))
      : [];
    const work = fs.length
      ? await db
          .select({ featureId: tickets.featureId, id: tickets.id, title: tickets.title, state: tickets.systemState, outcome: tickets.outcome, assignee: agents.name })
          .from(tickets)
          .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
          .where(and(inArray(tickets.featureId, fs.map((f) => f.id)), isNull(tickets.parentTicketId)))
          .orderBy(asc(tickets.createdAt))
      : [];
    // A feature's demand includes its subfeatures'.
    const childrenOf = new Map<string, string[]>();
    for (const f of fs) if (f.parentId) childrenOf.set(f.parentId, [...(childrenOf.get(f.parentId) ?? []), f.id]);
    const linksOf = (id: string) => links.filter((l) => l.featureId === id);
    const demand = new Map(
      fs.map((f) => {
        const all = [...linksOf(f.id), ...(childrenOf.get(f.id) ?? []).flatMap(linksOf)];
        // Anonymous feedback counts per note, so the same note linked twice still counts once.
        return [f.id, { demand: demandScore(all.map((l) => ({ customerKey: l.customerId ?? `note:${l.noteId}`, importance: l.importance as Importance }))), insights: all.length, customers: new Set(all.map((l) => l.customerId ?? `note:${l.noteId}`)).size }];
      }),
    );
    const maxDemand = Math.max(0, ...[...demand.values()].map((d) => d.demand));
    return {
      settings: s,
      drivers,
      maxDemand,
      features: fs.map((f) => {
        const d = demand.get(f.id)!;
        const scores = f.driverScores as Record<string, number | null>;
        const p = priorityScore({ demand: d.demand, maxDemand, demandWeight: s.demandWeight, drivers: drivers.map((x) => ({ weight: x.weight, value: scores[x.id] ?? null })), effort: f.effort });
        const items = work.filter((x) => x.featureId === f.id).map(({ id, title, state, outcome, assignee }) => ({ id, title, state, outcome, assignee }));
        return { ...f, driverScores: scores, demand: d.demand, insightCount: d.insights, customerCount: d.customers, value: p.value, demandPart: p.demandPart, priority: p.priority, tickets: { total: items.length, done: items.filter((x) => x.state === "done").length, items } };
      }),
    };
  }

  async function customerFor(companyId: string, input: NoteInput) {
    if (input.customerId) return (await own(db.select().from(feedbackCustomers).where(eq(feedbackCustomers.id, input.customerId)), companyId, "customer")).id;
    if (!input.customer?.name.trim()) return null;
    const name = input.customer.name.trim().slice(0, 200);
    const [existing] = await db.select().from(feedbackCustomers).where(and(eq(feedbackCustomers.companyId, companyId), sql`lower(${feedbackCustomers.name}) = lower(${name})`));
    if (existing) {
      const patch = { ...(input.customer.email && !existing.email ? { email: input.customer.email } : {}), ...(input.customer.segment && !existing.segment ? { segment: input.customer.segment } : {}) };
      if (Object.keys(patch).length) await db.update(feedbackCustomers).set(patch).where(eq(feedbackCustomers.id, existing.id));
      return existing.id;
    }
    const [c] = await db.insert(feedbackCustomers).values({ companyId, name, email: input.customer.email ?? null, segment: input.customer.segment ?? null }).onConflictDoNothing().returning();
    if (c) return c.id;
    const [again] = await db.select().from(feedbackCustomers).where(and(eq(feedbackCustomers.companyId, companyId), sql`lower(${feedbackCustomers.name}) = lower(${name})`));
    return again!.id;
  }

  async function createNote(companyId: string, input: NoteInput) {
    const customerId = await customerFor(companyId, input);
    const [n] = await db
      .insert(feedbackNotes)
      .values({
        companyId,
        title: input.title ?? null,
        text: input.text,
        source: input.source ?? "owner",
        customerId,
        untrusted: input.untrusted ?? false,
        createdByAgentId: input.createdByAgentId ?? null,
        portalVoter: input.portalVoter ?? null,
      })
      .returning();
    await deps.onNote?.(n!);
    return n!;
}

  return {
    settings,
    async setSettings(companyId: string, patch: Partial<Pick<FeedbackSettings, "demandWeight" | "ceoTriage" | "portalTitle" | "portalIntro">>) {
      await db.insert(feedbackSettings).values({ companyId, ...DEFAULTS, ...patch }).onConflictDoUpdate({ target: feedbackSettings.companyId, set: patch });
      return settings(companyId);
    },

    // ---- Criteria and areas ----
    drivers: (companyId: string) => db.select().from(featureDrivers).where(eq(featureDrivers.companyId, companyId)).orderBy(asc(featureDrivers.position), asc(featureDrivers.name)),
    async addDriver(companyId: string, input: { name: string; weight: number }) {
      const [{ n }] = (await db.select({ n: count() }).from(featureDrivers).where(eq(featureDrivers.companyId, companyId))) as [{ n: number }];
      if (Number(n) >= 12) throw new FeedbackError(422, "Twelve criteria at most: keep the ones that change decisions.");
      const [d] = await db.insert(featureDrivers).values({ companyId, name: input.name, weight: input.weight, position: Number(n) }).returning();
      return d!;
    },
    async updateDriver(id: string, patch: { name?: string; weight?: number; position?: number }) {
      const [d] = await db.update(featureDrivers).set(patch).where(eq(featureDrivers.id, id)).returning();
      if (!d) throw new FeedbackError(404, "No such criterion.");
      return d;
    },
    async removeDriver(id: string) {
      const [d] = await db.delete(featureDrivers).where(eq(featureDrivers.id, id)).returning();
      if (!d) throw new FeedbackError(404, "No such criterion.");
      // Its scores go with it.
      await db.update(features).set({ driverScores: sql`${features.driverScores} - ${id}` }).where(eq(features.companyId, d.companyId));
    },
    areas: (companyId: string) => db.select().from(featureAreas).where(eq(featureAreas.companyId, companyId)).orderBy(asc(featureAreas.position), asc(featureAreas.name)),
    async addArea(companyId: string, name: string) {
      const [{ n }] = (await db.select({ n: count() }).from(featureAreas).where(eq(featureAreas.companyId, companyId))) as [{ n: number }];
      const [a] = await db.insert(featureAreas).values({ companyId, name, position: Number(n) }).returning();
      return a!;
    },
    async updateArea(id: string, patch: { name?: string; position?: number }) {
      const [a] = await db.update(featureAreas).set(patch).where(eq(featureAreas.id, id)).returning();
      if (!a) throw new FeedbackError(404, "No such area.");
      return a;
    },
    async removeArea(id: string) {
      const [a] = await db.delete(featureAreas).where(eq(featureAreas.id, id)).returning();
      if (!a) throw new FeedbackError(404, "No such area.");
    },

    // ---- Features ----
    scored,
    async createFeature(companyId: string, input: FeaturePatch & { title: string; createdByAgentId?: string | null }) {
      await checkLinks(companyId, input);
      const publicSummary = input.publicSummary?.trim() || null;
      if (input.showPublicly && !publicSummary) throw new FeedbackError(422, "Write a public summary before showing the feature publicly.");
      const [f] = await db
        .insert(features)
        .values({
          companyId,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? "idea",
          areaId: input.areaId ?? null,
          parentId: input.parentId ?? null,
          effort: input.effort ?? null,
          rank: input.rank ?? null,
          horizon: input.horizon ?? null,
          driverScores: input.driverScores ?? {},
          milestoneId: input.milestoneId ?? null,
          objectiveId: input.objectiveId ?? null,
          portalVisible: input.portalVisible ?? false,
          publicSummary,
          showPublicly: input.showPublicly ?? false,
          createdByAgentId: input.createdByAgentId ?? null,
          releasedAt: input.status === "released" ? now() : null,
        })
        .returning();
      if (f!.status === "released") await scheduleGoalCheck(db, f!, now());
      return f!;
    },
    async updateFeature(id: string, patch: FeaturePatch, companyId?: string) {
      const f = await feature(id, companyId);
      await checkLinks(f.companyId, patch, id);
      const publicSummary = patch.publicSummary !== undefined ? patch.publicSummary?.trim() || null : f.publicSummary;
      if ((patch.showPublicly ?? f.showPublicly) && !publicSummary) throw new FeedbackError(422, "Write a public summary before showing the feature publicly.");
      const driverScores = patch.driverScores ? { ...(f.driverScores as Record<string, number | null>), ...patch.driverScores } : undefined;
      if (driverScores) for (const [k, v] of Object.entries(driverScores)) if (v === null) delete driverScores[k];
      const [u] = await db
        .update(features)
        .set({
          ...patch,
          ...(patch.publicSummary !== undefined ? { publicSummary } : {}),
          ...(driverScores ? { driverScores } : {}),
          ...(patch.status === "released" && f.status !== "released" ? { releasedAt: now() } : patch.status && patch.status !== "released" ? { releasedAt: null } : {}),
          updatedAt: now(),
        })
        .where(eq(features.id, id))
        .returning();
      if (patch.status === "released" && f.status !== "released") await scheduleGoalCheck(db, u!, now());
      return u!;
    },
    async removeFeature(id: string) {
      const [f] = await db.delete(features).where(eq(features.id, id)).returning();
      if (!f) throw new FeedbackError(404, "No such feature.");
    },
    /** One feature with its score, the feedback behind it, its subfeatures and its tickets. */
    async featureDetail(id: string) {
      const f = await feature(id);
      const all = await scored(f.companyId);
      const me = all.features.find((x) => x.id === id)!;
      const ids = [id, ...all.features.filter((x) => x.parentId === id).map((x) => x.id)];
      const evidence = await db
        .select({ insight: insights, note: { id: feedbackNotes.id, title: feedbackNotes.title, text: feedbackNotes.text, source: feedbackNotes.source, untrusted: feedbackNotes.untrusted, createdAt: feedbackNotes.createdAt }, customer: { id: feedbackCustomers.id, name: feedbackCustomers.name, segment: feedbackCustomers.segment } })
        .from(insights)
        .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
        .leftJoin(feedbackCustomers, eq(feedbackCustomers.id, feedbackNotes.customerId))
        .where(inArray(insights.featureId, ids))
        .orderBy(desc(insights.createdAt));
      return {
        feature: me,
        drivers: all.drivers,
        settings: { demandWeight: all.settings.demandWeight },
        maxDemand: all.maxDemand,
        subfeatures: all.features.filter((x) => x.parentId === id),
        insights: evidence.map((e) => ({ ...e.insight, fromSubfeature: e.insight.featureId !== id, note: { ...e.note, text: e.note.text.slice(0, 2000) }, customer: e.customer?.id ? e.customer : null })),
        tickets: me.tickets.items,
      };
    },
    /** The roadmap's feature cards: where each sits, its objective, its progress and the milestones it touches. */
    async roadmapFeatures(companyId: string) {
      const all = await scored(companyId);
      const shown = all.features.filter((f) => f.status !== "declined");
      const ids = shown.map((f) => f.id);
      const work = ids.length
        ? await db
            .select({ featureId: tickets.featureId, milestoneId: tickets.milestoneId })
            .from(tickets)
            .where(and(inArray(tickets.featureId, ids), isNull(tickets.parentTicketId)))
        : [];
      const milestoneIds = new Set<string>();
      for (const f of shown) if (f.milestoneId) milestoneIds.add(f.milestoneId);
      for (const w of work) if (w.milestoneId) milestoneIds.add(w.milestoneId);
      const ms = milestoneIds.size ? await db.select({ id: milestones.id, title: milestones.title, targetDate: milestones.targetDate, horizon: milestones.horizon, objectiveId: milestones.objectiveId }).from(milestones).where(inArray(milestones.id, [...milestoneIds])) : [];
      const msById = new Map(ms.map((m) => [m.id, m]));
      const objectiveOf = (f: (typeof shown)[number]) => f.objectiveId ?? (f.milestoneId ? msById.get(f.milestoneId)?.objectiveId : null) ?? null;
      const objectiveIds = new Set(shown.map(objectiveOf).filter((id): id is string => !!id));
      const objs = objectiveIds.size ? await db.select({ id: objectives.id, title: objectives.title, priority: objectives.priority }).from(objectives).where(inArray(objectives.id, [...objectiveIds])) : [];
      const objById = new Map(objs.map((o) => [o.id, o]));
      return shown.map((f) => {
        const linked = new Set<string>();
        if (f.milestoneId) linked.add(f.milestoneId);
        for (const w of work) if (w.featureId === f.id && w.milestoneId) linked.add(w.milestoneId);
        const milestones = [...linked]
          .map((mid) => msById.get(mid))
          .filter((m): m is (typeof ms)[number] => !!m)
          .sort((a, b) => (a.targetDate ?? "9999-12-31").localeCompare(b.targetDate ?? "9999-12-31") || a.title.localeCompare(b.title))
          .map((m) => ({ id: m.id, title: m.title, targetDate: m.targetDate, pinned: m.horizon }));
        const objectiveId = objectiveOf(f) ?? milestones.map((m) => msById.get(m.id)?.objectiveId).find((id): id is string => !!id) ?? null;
        return {
          id: f.id,
          title: f.title,
          status: f.status,
          rank: f.rank,
          horizon: f.horizon,
          column: featureHorizon(f),
          priority: f.priority,
          releasedAt: f.releasedAt,
          objective: objectiveId ? (objById.get(objectiveId) ?? null) : null,
          publicSummary: f.publicSummary,
          showPublicly: f.showPublicly,
          tickets: { total: f.tickets.total, done: f.tickets.done },
          milestones,
        };
      });
    },

    // ---- Customers ----
    customers: (companyId: string, q?: string) =>
      db
        .select()
        .from(feedbackCustomers)
        .where(and(eq(feedbackCustomers.companyId, companyId), q ? or(ilike(feedbackCustomers.name, `%${q.replace(/[%_\\]/g, "\\$&")}%`), ilike(feedbackCustomers.email, `%${q.replace(/[%_\\]/g, "\\$&")}%`)) : undefined))
        .orderBy(asc(feedbackCustomers.name))
        .limit(50),

    // ---- Notes and insights ----
    createNote,
    async notes(companyId: string, opts: { state?: "unprocessed" | "processed" | "archived"; q?: string; before?: Date; limit?: number } = {}) {
      const q = opts.q?.trim();
      const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
      const rows = await db
        .select({ note: feedbackNotes, customer: feedbackCustomers.name, insightCount: sql<number>`(select count(*) from ${insights} where ${insights.noteId} = ${feedbackNotes.id})`.mapWith(Number) })
        .from(feedbackNotes)
        .leftJoin(feedbackCustomers, eq(feedbackCustomers.id, feedbackNotes.customerId))
        .where(
          and(
            eq(feedbackNotes.companyId, companyId),
            opts.state ? eq(feedbackNotes.state, opts.state) : undefined,
            opts.before ? lt(feedbackNotes.createdAt, opts.before) : undefined,
            like ? or(ilike(feedbackNotes.text, like), ilike(feedbackNotes.title, like), ilike(feedbackCustomers.name, like)) : undefined,
          ),
        )
        .orderBy(desc(feedbackNotes.createdAt))
        .limit(Math.min(opts.limit ?? 50, 200));
      return rows.map((r) => ({ ...r.note, customer: r.customer, insightCount: r.insightCount }));
    },
    async unprocessedCount(companyId?: string) {
      const rows = await db
        .select({ companyId: feedbackNotes.companyId, n: count() })
        .from(feedbackNotes)
        .where(and(eq(feedbackNotes.state, "unprocessed"), companyId ? eq(feedbackNotes.companyId, companyId) : undefined))
        .groupBy(feedbackNotes.companyId);
      return Object.fromEntries(rows.map((r) => [r.companyId, Number(r.n)]));
    },
    /** A note with its insights and the features it may be about. */
    async noteDetail(id: string, companyId?: string) {
      const n = await note(id, companyId);
      const [customer] = n.customerId ? await db.select().from(feedbackCustomers).where(eq(feedbackCustomers.id, n.customerId)) : [];
      const linked = await db
        .select({ insight: insights, feature: { id: features.id, title: features.title, status: features.status } })
        .from(insights)
        .innerJoin(features, eq(features.id, insights.featureId))
        .where(eq(insights.noteId, id))
        .orderBy(asc(insights.createdAt));
      const fs = await db.select({ id: features.id, title: features.title, description: features.description, status: features.status }).from(features).where(eq(features.companyId, n.companyId));
      const highlights = fs.length ? await db.select({ featureId: insights.featureId, highlight: insights.highlight }).from(insights).where(inArray(insights.featureId, fs.map((f) => f.id))) : [];
      const linkedIds = new Set(linked.map((l) => l.feature.id));
      const suggestions = suggestFeatures(
        n.text,
        fs.filter((f) => !linkedIds.has(f.id) && f.status !== "declined").map((f) => ({ ...f, highlights: highlights.filter((h) => h.featureId === f.id && h.highlight).map((h) => h.highlight!) })),
      ).map((s) => ({ id: s.feature.id, title: s.feature.title, status: s.feature.status, score: s.score, shared: s.shared }));
      return { note: n, customer: customer ?? null, insights: linked.map((l) => ({ ...l.insight, feature: l.feature })), suggestions };
    },
    async updateNote(id: string, patch: { title?: string | null; state?: "unprocessed" | "processed" | "archived"; customerId?: string | null; customer?: NoteInput["customer"] }, companyId?: string) {
      const n = await note(id, companyId);
      const customerId = patch.customer !== undefined || patch.customerId !== undefined ? await customerFor(n.companyId, { text: "", customerId: patch.customerId, customer: patch.customer }) : undefined;
      const [u] = await db
        .update(feedbackNotes)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.state ? { state: patch.state, processedAt: patch.state === "unprocessed" ? null : now() } : {}),
          ...(customerId !== undefined ? { customerId } : {}),
        })
        .where(eq(feedbackNotes.id, id))
        .returning();
      return u!;
    },
    async removeNote(id: string) {
      const [n] = await db.delete(feedbackNotes).where(eq(feedbackNotes.id, id)).returning();
      if (!n) throw new FeedbackError(404, "No such note.");
    },
    /** Links a note to a feature; linking the same pair again updates the importance and passage. */
    async link(noteId: string, input: { featureId: string; importance: Importance; highlight?: string | null; createdBy: string }, companyId?: string) {
      const n = await note(noteId, companyId);
      await feature(input.featureId, n.companyId);
      const highlight = input.highlight?.trim() ? input.highlight.trim().slice(0, 2000) : null;
      if (highlight && !n.text.includes(highlight)) throw new FeedbackError(422, "The highlighted passage must come from the note.");
      const [i] = await db
        .insert(insights)
        .values({ noteId, featureId: input.featureId, importance: input.importance, highlight, createdBy: input.createdBy })
        .onConflictDoUpdate({ target: [insights.noteId, insights.featureId], set: { importance: input.importance, highlight, createdBy: input.createdBy } })
        .returning();
      await db.update(features).set({ updatedAt: now() }).where(eq(features.id, input.featureId));
      return i!;
    },
    async unlink(insightId: string) {
      const [i] = await db.delete(insights).where(eq(insights.id, insightId)).returning();
      if (!i) throw new FeedbackError(404, "No such insight.");
    },

    /**
     * Moves one feature along with its tasks, called whenever a task of it starts, finishes,
     * reopens or is added. In progress once work starts; released once every task is done and
     * at least one was completed, and, when the company has a production deploy target, once a
     * deploy of one of its tasks to it has succeeded; back to in progress if a released
     * feature's task reopens. Declined is never touched, and a manual status stands until the
     * next task event.
     */
    async syncFeature(featureId: string | null | undefined) {
      if (!featureId) return null;
      const [f] = await db.select().from(features).where(eq(features.id, featureId));
      if (!f || f.status === "declined") return null;
      const [r] = await db
        .select({
          open: sql<number>`count(*) filter (where ${tickets.parentTicketId} is null and ${tickets.systemState} <> 'done')`.mapWith(Number),
          active: sql<number>`count(*) filter (where ${tickets.systemState} in ('in_progress', 'review'))`.mapWith(Number),
          completed: sql<number>`count(*) filter (where ${tickets.parentTicketId} is null and ${tickets.systemState} = 'done' and ${tickets.outcome} is distinct from 'cancelled')`.mapWith(Number),
        })
        .from(tickets)
        .where(eq(tickets.featureId, featureId));
      let released = r!.open === 0 && r!.completed > 0;
      if (released) {
        const [prod] = await db.select({ id: deployTargets.id }).from(deployTargets).where(and(eq(deployTargets.companyId, f.companyId), eq(deployTargets.isProduction, true))).limit(1);
        if (prod) {
          // shortcut: any succeeded production deploy of one of its tasks releases it, not one covering every task; upgrade if per-task coverage matters.
          const [shipped] = await db
            .select({ id: deploys.id })
            .from(deploys)
            .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
            .innerJoin(tickets, eq(tickets.id, deploys.ticketId))
            .where(and(eq(tickets.featureId, featureId), eq(deploys.status, "succeeded"), eq(deployTargets.isProduction, true)))
            .limit(1);
          released = !!shipped;
        }
      }
      const started = r!.active > 0 || r!.completed > 0;
      const next: FeatureStatus | null = released ? "released" : f.status === "released" ? (r!.open > 0 ? "in_progress" : null) : started && ["idea", "considering", "planned"].includes(f.status) ? "in_progress" : null;
      if (!next || next === f.status) return null;
      const [u] = await db
        .update(features)
        .set({ status: next, updatedAt: now(), releasedAt: next === "released" ? now() : null })
        .where(and(eq(features.id, f.id), eq(features.status, f.status)))
        .returning();
      if (u && next === "released") {
        await scheduleGoalCheck(db, u, now());
        await deps.onReleased?.(u);
      }
      return u ?? null;
    },

    /** A ticket's description from a feature: what it is and what people asked for, strongest first. */
    async brief(featureId: string) {
      const f = await feature(featureId);
      const evidence = await db
        .select({ importance: insights.importance, highlight: insights.highlight, text: feedbackNotes.text, untrusted: feedbackNotes.untrusted, customer: feedbackCustomers.name, segment: feedbackCustomers.segment })
        .from(insights)
        .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
        .leftJoin(feedbackCustomers, eq(feedbackCustomers.id, feedbackNotes.customerId))
        .where(eq(insights.featureId, featureId));
      evidence.sort((a, b) => IMPORTANCE_POINTS[b.importance as Importance] - IMPORTANCE_POINTS[a.importance as Importance]);
      const lines = [`Delivers the feature "${f.title}".`];
      if (f.description) lines.push("", f.description);
      if (evidence.length) {
        lines.push("", `What people asked for (${evidence.length}):`);
        for (const e of evidence.slice(0, 10)) {
          const who = e.customer ? `${e.customer}${e.segment ? `, ${e.segment}` : ""}` : "Anonymous";
          const said = (e.highlight ?? e.text).slice(0, 600);
          lines.push(`- ${IMPORTANCE_LABEL[e.importance as Importance]} for ${who}: ${e.untrusted ? untrusted("feedback from outside", said) : `"${said}"`}`);
        }
        if (evidence.length > 10) lines.push(`- and ${evidence.length - 10} more on the feature's page.`);
      }
      return { feature: f, body: lines.join("\n").slice(0, 20_000) };
    },

    // ---- The portal: a page outsiders reach by a secret link ----

    /** Turns the portal on or off and sets its words. Turning it on the first time makes its link. */
    async setPortal(companyId: string, patch: { enabled?: boolean; title?: string | null; intro?: string | null }) {
      const current = await settings(companyId);
      const token = patch.enabled && !current.portalToken ? randomBytes(24).toString("base64url") : current.portalToken;
      const set = {
        ...(patch.enabled !== undefined ? { portalEnabled: patch.enabled } : {}),
        ...(patch.title !== undefined ? { portalTitle: patch.title } : {}),
        ...(patch.intro !== undefined ? { portalIntro: patch.intro } : {}),
        portalToken: token,
      };
      await db.insert(feedbackSettings).values({ companyId, ...DEFAULTS, ...set }).onConflictDoUpdate({ target: feedbackSettings.companyId, set });
      return settings(companyId);
    },
    /** Stores (or, with null, removes) the portal logo. Callers have already checked the bytes. */
    async setPortalLogo(companyId: string, logo: { bytes: Buffer; type: string } | null) {
      const set = { portalLogo: logo?.bytes ?? null, portalLogoType: logo?.type ?? null };
      await db.insert(feedbackSettings).values({ companyId, ...DEFAULTS, ...set }).onConflictDoUpdate({ target: feedbackSettings.companyId, set });
    },
    async portalLogo(companyId: string) {
      const [row] = await db.select({ bytes: feedbackSettings.portalLogo, type: feedbackSettings.portalLogoType }).from(feedbackSettings).where(eq(feedbackSettings.companyId, companyId));
      return row?.bytes && row.type ? { bytes: row.bytes, type: row.type } : null;
    },
    /** A new link; the old one stops working at once. */
    async rotatePortal(companyId: string) {
      const portalToken = randomBytes(24).toString("base64url");
      await db.insert(feedbackSettings).values({ companyId, ...DEFAULTS, portalToken }).onConflictDoUpdate({ target: feedbackSettings.companyId, set: { portalToken } });
      return settings(companyId);
    },
    /** The company behind an enabled portal's token, or null. */
    async portalFor(token: string) {
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
      const [row] = await db
        .select({ companyId: feedbackSettings.companyId, title: feedbackSettings.portalTitle, intro: feedbackSettings.portalIntro, company: companies.name, hasLogo: sql<boolean>`${feedbackSettings.portalLogo} is not null` })
        .from(feedbackSettings)
        .innerJoin(companies, eq(companies.id, feedbackSettings.companyId))
        .where(and(eq(feedbackSettings.portalToken, token), eq(feedbackSettings.portalEnabled, true)));
      return row ?? null;
    },
    /** What a visitor sees: features shown on the portal, by stage, with their own votes. */
    async portalView(companyId: string, voter: string | null) {
      const cutoff = new Date(now().getTime() - 180 * 86_400_000);
      const fs = await db
        .select({ id: features.id, title: features.title, description: features.description, status: features.status, releasedAt: features.releasedAt })
        .from(features)
        .where(and(eq(features.companyId, companyId), eq(features.portalVisible, true), inArray(features.status, ["idea", "considering", "planned", "in_progress", "released"])))
        .orderBy(asc(features.title));
      const mine = voter && fs.length
        ? await db
            .select({ featureId: insights.featureId, importance: insights.importance, comment: feedbackNotes.text, hasComment: sql<boolean>`${feedbackNotes.title} like 'Portal comment:%'` })
            .from(insights)
            .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
            .where(and(eq(feedbackNotes.companyId, companyId), eq(feedbackNotes.portalVoter, voter), inArray(insights.featureId, fs.map((f) => f.id))))
        : [];
      return fs
        .filter((f) => f.status !== "released" || (f.releasedAt && f.releasedAt > cutoff))
        .map((f) => {
          const v = mine.find((m) => m.featureId === f.id);
          return {
            id: f.id,
            title: f.title,
            description: f.description?.slice(0, 1000) ?? null,
            stage: f.status === "released" ? "released" : f.status === "planned" || f.status === "in_progress" ? "planned" : "considering",
            myVote: v ? { importance: v.importance, comment: v.hasComment ? v.comment : null } : null,
          };
        });
    },
    /** A visitor's vote: one per visitor and feature; voting again changes it. */
    async portalVote(companyId: string, voter: string, input: { featureId: string; importance: Importance; comment?: string | null; name?: string | null; email?: string | null }) {
      const [f] = await db.select().from(features).where(and(eq(features.id, input.featureId), eq(features.companyId, companyId), eq(features.portalVisible, true)));
      if (!f || f.status === "declined") throw new FeedbackError(404, "No such feature.");
      const comment = input.comment?.trim() || null;
      const [existing] = await db
        .select({ noteId: feedbackNotes.id })
        .from(insights)
        .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
        .where(and(eq(insights.featureId, f.id), eq(feedbackNotes.portalVoter, voter), eq(feedbackNotes.companyId, companyId)));
      const customer = input.name?.trim() ? { name: input.name.trim(), email: input.email?.trim() || null, segment: "Portal" } : null;
      const text = comment ?? `Voted "${IMPORTANCE_LABEL[input.importance]}" for "${f.title}" on the portal.`;
      // A vote without words needs no reading, so it arrives processed; a comment waits in the inbox.
      const state = comment ? ("unprocessed" as const) : ("processed" as const);
      let noteId = existing?.noteId;
      if (noteId) {
        const customerId = customer ? await customerFor(companyId, { text, customer }) : undefined;
        await db
          .update(feedbackNotes)
          .set({ text, title: comment ? `Portal comment: ${f.title}` : `Portal vote: ${f.title}`, ...(comment ? { state, processedAt: null } : {}), ...(customerId ? { customerId } : {}) })
          .where(eq(feedbackNotes.id, noteId));
      } else {
        const n = await createNote(companyId, { text, title: comment ? `Portal comment: ${f.title}` : `Portal vote: ${f.title}`, source: "portal", untrusted: true, portalVoter: voter, customer });
        noteId = n.id;
        if (!comment) await db.update(feedbackNotes).set({ state, processedAt: now() }).where(eq(feedbackNotes.id, noteId));
      }
      await db
        .insert(insights)
        .values({ noteId, featureId: f.id, importance: input.importance, createdBy: "portal" })
        .onConflictDoUpdate({ target: [insights.noteId, insights.featureId], set: { importance: input.importance } });
      return { importance: input.importance, comment };
    },
    async portalUnvote(companyId: string, voter: string, featureId: string) {
      const rows = await db
        .select({ noteId: feedbackNotes.id })
        .from(insights)
        .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
        .where(and(eq(insights.featureId, featureId), eq(feedbackNotes.portalVoter, voter), eq(feedbackNotes.companyId, companyId)));
      if (rows.length) await db.delete(feedbackNotes).where(inArray(feedbackNotes.id, rows.map((r) => r.noteId)));
    },
    /** A visitor's own idea, for the owner (or CEO) to triage. */
    async portalIdea(companyId: string, voter: string, input: { title: string; text: string; name?: string | null; email?: string | null }) {
      // At most 10 ideas a day from one visitor.
      const [{ n }] = (await db
        .select({ n: count() })
        .from(feedbackNotes)
        .where(and(eq(feedbackNotes.companyId, companyId), eq(feedbackNotes.portalVoter, voter), sql`${feedbackNotes.title} like 'Portal idea:%'`, gt(feedbackNotes.createdAt, new Date(now().getTime() - 86_400_000))))) as [{ n: number }];
      if (Number(n) >= 10) throw new FeedbackError(429, "That's plenty of ideas for one day. Thank you!");
      const customer = input.name?.trim() ? { name: input.name.trim(), email: input.email?.trim() || null, segment: "Portal" } : null;
      await createNote(companyId, { title: `Portal idea: ${input.title}`.slice(0, 200), text: input.text, source: "portal", untrusted: true, portalVoter: voter, customer });
    },

    /** Unprocessed notes, oldest first, for whoever triages them. */
    untriaged: (companyId: string, limit = 20) =>
      db
        .select({ note: feedbackNotes, customer: feedbackCustomers.name })
        .from(feedbackNotes)
        .leftJoin(feedbackCustomers, eq(feedbackCustomers.id, feedbackNotes.customerId))
        .where(and(eq(feedbackNotes.companyId, companyId), eq(feedbackNotes.state, "unprocessed")))
        .orderBy(asc(feedbackNotes.createdAt))
        .limit(limit),
  };
}
