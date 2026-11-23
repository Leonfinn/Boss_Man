// Feature requests (inspired by Productboard; Boss Man's own design and code). Feedback arrives
// as notes; passages of a note are linked to features as insights, each with how much it
// matters to that person. Features are scored on demand (from their insights) and on the
// company's own criteria, then divided by effort. Tickets deliver features.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { featureHorizon, demandScore, IMPORTANCE_LABEL, IMPORTANCE_POINTS, portalShows, PORTAL_STATUSES, portalTitle, portalVerdict, priorityScore, suggestFeatures, untrusted, type FeatureStatus, type Horizon, type Importance, type NoteSource } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { scheduleGoalCheck } from "./goal-check.js";
import { agents, companies, deploys, deployTargets, feedbackCustomers, feedbackNotes, feedbackSettings, featureAreas, featureDrivers, features, insights, milestones, objectives, portalConfirmedAddresses, tickets } from "../db/schema.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** One address, one hash, however it was typed. */
export const emailHash = (email: string) => sha256(email.trim().toLowerCase());

export class FeedbackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type FeedbackSettings = { demandWeight: number; ceoTriage: boolean; portalEnabled: boolean; portalToken: string | null; portalTitle: string | null; portalIntro: string | null; portalBackUrl: string | null; portalBackText: string | null; hasLogo: boolean; confirmByEmail: boolean; confirmLinkHours: number; rememberAddressDays: number; portalAtBareAddress: boolean };
const DEFAULTS: Omit<FeedbackSettings, never> = { demandWeight: 3, ceoTriage: false, portalEnabled: false, portalToken: null, portalTitle: null, portalIntro: null, portalBackUrl: null, portalBackText: null, hasLogo: false, confirmByEmail: false, confirmLinkHours: 24, rememberAddressDays: 90, portalAtBareAddress: false };

/** A note that counts: unconfirmed portal posts (BOS-1388) are hidden from everyone and score nothing. */
const counted = isNull(feedbackNotes.confirmTokenHash);

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
  keepOffPortal?: boolean;
  /** Why the feature is kept off the portal, in the author's own words. */
  keepOffReason?: string | null;
  publicSummary?: string | null;
  /** The title visitors see on the portal; null falls back to the summary's first line (BOS-991). */
  publicTitle?: string | null;
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
  /** BOS-1388: save it hidden until the visitor clicks the emailed link; no customer is made and nobody is woken yet. */
  pending?: { tokenHash: string; expiresAt: Date; email: string; name: string | null };
};

/** The link-confirmation a portal write asks for: the visitor's address, and how long the link lives. */
export type PortalConfirm = { email: string; hours: number };

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
  // An unconfirmed portal note doesn't exist for the owner, agents or the API: it 404s like any other missing note.
  const note = (id: string, companyId?: string) => own(db.select().from(feedbackNotes).where(and(eq(feedbackNotes.id, id), counted)), companyId, "note");

  async function settings(companyId: string): Promise<FeedbackSettings> {
    const [row] = await db.select({ demandWeight: feedbackSettings.demandWeight, ceoTriage: feedbackSettings.ceoTriage, portalEnabled: feedbackSettings.portalEnabled, portalToken: feedbackSettings.portalToken, portalTitle: feedbackSettings.portalTitle, portalIntro: feedbackSettings.portalIntro, portalBackUrl: feedbackSettings.portalBackUrl, portalBackText: feedbackSettings.portalBackText, hasLogo: sql<boolean>`${feedbackSettings.portalLogo} is not null`, confirmByEmail: feedbackSettings.confirmByEmail, confirmLinkHours: feedbackSettings.confirmLinkHours, rememberAddressDays: feedbackSettings.rememberAddressDays, portalAtBareAddress: feedbackSettings.portalAtBareAddress }).from(feedbackSettings).where(eq(feedbackSettings.companyId, companyId));
    return row ?? { ...DEFAULTS };
  }

  /** The enabled portal whose settings row matches `where`, with what the page and its calls need; or null. */
  async function portalWhere(where: SQL) {
    const [row] = await db
      .select({ companyId: feedbackSettings.companyId, title: feedbackSettings.portalTitle, intro: feedbackSettings.portalIntro, backUrl: feedbackSettings.portalBackUrl, backText: feedbackSettings.portalBackText, company: companies.name, hasLogo: sql<boolean>`${feedbackSettings.portalLogo} is not null`, confirmByEmail: feedbackSettings.confirmByEmail, confirmLinkHours: feedbackSettings.confirmLinkHours, rememberAddressDays: feedbackSettings.rememberAddressDays })
      .from(feedbackSettings)
      .innerJoin(companies, eq(companies.id, feedbackSettings.companyId))
      .where(and(where, eq(feedbackSettings.portalEnabled, true)));
    return row ?? null;
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

  /** The names the portal rule reads alongside a feature's own title and description: its area and the criteria it is scored on. */
  async function portalFacts(companyId: string, areaId: string | null | undefined, driverScores: Record<string, number | null> | undefined) {
    const area = areaId ? ((await db.select({ name: featureAreas.name }).from(featureAreas).where(eq(featureAreas.id, areaId)))[0]?.name ?? null) : null;
    const ids = Object.keys(driverScores ?? {});
    const criteria = ids.length ? (await db.select({ name: featureDrivers.name }).from(featureDrivers).where(and(eq(featureDrivers.companyId, companyId), inArray(featureDrivers.id, ids)))).map((d) => d.name) : [];
    return { area, criteria };
  }

  /** The features that actually reach visitors: ticked on, not marked keep-off, and with a public summary (that summary
   * replaces the internal description and title, so internal text never reaches visitors). Public text the portal rule
   * calls security work is dropped too, a second wall behind the update_feature guard (BOS-1420): a reader never sees it. */
  async function livePortalFeatures(companyId: string) {
    const rows = await db
      .select({ id: features.id, title: features.title, publicSummary: features.publicSummary, publicTitle: features.publicTitle, status: features.status, releasedAt: features.releasedAt })
      .from(features)
      .where(and(eq(features.companyId, companyId), eq(features.portalVisible, true), eq(features.keepOffPortal, false), inArray(features.status, [...PORTAL_STATUSES])))
      .orderBy(asc(features.title));
    // The rest of the rule is portalShows, shared with the Features page (BOS-1496).
    return rows.filter((f) => portalShows({ portalVisible: true, keepOffPortal: false, status: f.status, publicTitle: f.publicTitle, publicSummary: f.publicSummary }).shown);
  }

  /** Every feature of a company with its demand, priority and delivery, in one pass. */
  async function scored(companyId: string) {
    const s = await settings(companyId);
    const fs = await db.select().from(features).where(eq(features.companyId, companyId)).orderBy(asc(features.createdAt));
    const drivers = await db.select().from(featureDrivers).where(eq(featureDrivers.companyId, companyId)).orderBy(asc(featureDrivers.position), asc(featureDrivers.name));
    const areas = fs.some((f) => f.areaId) ? await db.select({ id: featureAreas.id, name: featureAreas.name }).from(featureAreas).where(eq(featureAreas.companyId, companyId)) : [];
    const areaName = new Map(areas.map((a) => [a.id, a.name]));
    const links = fs.length
      ? await db
          .select({ featureId: insights.featureId, importance: insights.importance, customerId: feedbackNotes.customerId, noteId: insights.noteId })
          .from(insights)
          .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
          .where(and(inArray(insights.featureId, fs.map((f) => f.id)), counted))
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
        // Why the feature is on or off the portal, so the list can show the tick and a small reason (BOS-957).
        const criteria = Object.keys(scores).map((id) => drivers.find((x) => x.id === id)?.name ?? "");
        const portal = portalVerdict({ title: f.title, description: f.description, publicTitle: f.publicTitle, publicSummary: f.publicSummary, area: f.areaId ? (areaName.get(f.areaId) ?? null) : null, criteria, keepOffPortal: f.keepOffPortal, hasPublicSummary: !!f.publicSummary?.trim() });
        const portalShow = portalShows({ portalVisible: f.portalVisible, keepOffPortal: f.keepOffPortal, status: f.status, publicTitle: f.publicTitle, publicSummary: f.publicSummary });
        return { ...f, portalShow, driverScores: scores, demand: d.demand, insightCount: d.insights, customerCount: d.customers, value: p.value, demandPart: p.demandPart, priority: p.priority, portal, tickets: { total: items.length, done: items.filter((x) => x.state === "done").length, items } };
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
    const customerId = input.pending ? null : await customerFor(companyId, input);
    const [n] = await db
      .insert(feedbackNotes)
      .values({
        ...(input.pending ? { confirmTokenHash: input.pending.tokenHash, confirmExpiresAt: input.pending.expiresAt, confirmEmail: input.pending.email, confirmName: input.pending.name } : {}),
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
    if (!input.pending) await deps.onNote?.(n!);
    return n!;
  }

  /** A fresh single-use link token: only its hash is kept. */
  function newConfirm(c: PortalConfirm, name: string | null | undefined) {
    const token = randomBytes(32).toString("base64url");
    return { token, pending: { tokenHash: sha256(token), expiresAt: new Date(now().getTime() + c.hours * 3_600_000), email: c.email.trim(), name: name?.trim() || null } };
  }

  /**
   * A note from outside that must be filed once, whatever retries or overlapping passes there are (BOS-1393):
   * the unique (company, externalId) index decides, so a repeat is a no-op and returns null. It never fires
   * onNote: the caller (the GitHub watcher) wakes whoever triages, once per pass, not once per note.
   */
  async function createExternalNote(companyId: string, input: Pick<NoteInput, "title" | "text" | "source"> & { externalId: string }) {
    const [n] = await db
      .insert(feedbackNotes)
      .values({ companyId, title: input.title ?? null, text: input.text, source: input.source ?? "import", untrusted: true, externalId: input.externalId })
      .onConflictDoNothing()
      .returning();
    return n ?? null;
  }

  return {
    createExternalNote,
    settings,
    async setSettings(companyId: string, patch: Partial<Pick<FeedbackSettings, "demandWeight" | "ceoTriage" | "portalTitle" | "portalIntro" | "portalBackUrl" | "portalBackText">>) {
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
    /** One feature in the company; the MCP tool reads it to check what the portal rule says before publishing (BOS-991). */
    feature,
    portalFacts,
    async createFeature(companyId: string, input: FeaturePatch & { title: string; createdByAgentId?: string | null }) {
      await checkLinks(companyId, input);
      const publicSummary = input.publicSummary?.trim() || null;
      const publicTitle = input.publicTitle?.trim() || null;
      if (input.showPublicly && !publicSummary) throw new FeedbackError(422, "Write a public summary before showing the feature publicly.");
      const keepOffPortal = input.keepOffPortal ?? false;
      // Why someone kept it off, said in their own words; only kept with the mark, and cleared when the mark is.
      const keepOffReason = keepOffPortal ? input.keepOffReason?.trim().slice(0, 500) || null : null;
      // A new feature goes on the portal by default (BOS-957), unless it is marked sensitive or reads as security work.
      // The public-summary gate only holds it back from visitors; the tick stays on, so writing a summary later shows it.
      const facts = await portalFacts(companyId, input.areaId, input.driverScores);
      // Judge what a visitor would see once a public summary is written; internal wording only counts until then (BOS-1419).
      const verdict = portalVerdict({ title: input.title, description: input.description, publicTitle, publicSummary, ...facts, keepOffPortal, hasPublicSummary: !!publicSummary });
      const mayGoOn = !(verdict.reason === "sensitive" || verdict.reason === "security");
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
          portalVisible: input.portalVisible ?? mayGoOn,
          keepOffPortal,
          keepOffReason,
          publicSummary,
          publicTitle,
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
      // Marking a feature "keep off the portal (sensitive)" takes it off at once; clearing the mark leaves the tick alone.
      const portalVisible = patch.keepOffPortal ? false : patch.portalVisible;
      // The reason travels with the mark: set it when the mark goes on, clear it when the mark comes off.
      const keepOffReason = patch.keepOffPortal === true ? (patch.keepOffReason?.trim().slice(0, 500) || f.keepOffReason) : patch.keepOffPortal === false ? null : undefined;
      const [u] = await db
        .update(features)
        .set({
          ...patch,
          ...(keepOffReason !== undefined ? { keepOffReason } : {}),
          ...(portalVisible !== undefined ? { portalVisible } : {}),
          ...(patch.publicSummary !== undefined ? { publicSummary } : {}),
          ...(patch.publicTitle !== undefined ? { publicTitle: patch.publicTitle?.trim() || null } : {}),
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
        .where(and(inArray(insights.featureId, ids), counted))
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

    /**
     * A feature the roadmap commits to — Now, Next or In progress, declined excluded — with no open
     * ticket of its own, so the work the owner expects isn't actually being done (BOS-595). Called by
     * the sweep so a feature can't sit there until the owner asks. `raise` puts one CEO card up, which
     * closes by itself once a ticket is linked (DR-016, BOS-470). Returns how many cards it raised.
     */
    async raiseFeatureNoTicket(companyId: string, raise: (feature: { id: string; title: string; status: FeatureStatus; horizon: Horizon | null }) => Promise<unknown>) {
      const fs = await db.select({ id: features.id, title: features.title, status: features.status, horizon: features.horizon }).from(features).where(eq(features.companyId, companyId));
      let raised = 0;
      for (const f of fs) {
        if (f.status === "declined") continue;
        const column = featureHorizon(f);
        if (column !== "now" && column !== "next") continue;
        // The ticket counts when it is the work of the feature itself: a sub-task's own ticket is done
        // under its parent's, which is already counted here.
        const [open] = await db
          .select({ id: tickets.id })
          .from(tickets)
          .where(and(eq(tickets.featureId, f.id), isNull(tickets.parentTicketId), ne(tickets.systemState, "done")))
          .limit(1);
        if (open) continue;
        await raise(f);
        raised++;
      }
      return raised;
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
            counted,
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
        .where(and(eq(feedbackNotes.state, "unprocessed"), counted, companyId ? eq(feedbackNotes.companyId, companyId) : undefined))
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
        .where(and(eq(insights.featureId, featureId), counted));
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
    async setPortal(companyId: string, patch: { enabled?: boolean; title?: string | null; intro?: string | null; backUrl?: string | null; backText?: string | null; confirmByEmail?: boolean; confirmLinkHours?: number; rememberAddressDays?: number; portalAtBareAddress?: boolean }) {
      const current = await settings(companyId);
      // BOS-1680: only one company's portal can be the one the bare address opens; turning it on here turns it off elsewhere.
      if (patch.portalAtBareAddress) await db.update(feedbackSettings).set({ portalAtBareAddress: false }).where(and(eq(feedbackSettings.portalAtBareAddress, true), ne(feedbackSettings.companyId, companyId)));
      const token = patch.enabled && !current.portalToken ? randomBytes(24).toString("base64url") : current.portalToken;
      const set = {
        ...(patch.enabled !== undefined ? { portalEnabled: patch.enabled } : {}),
        ...(patch.confirmByEmail !== undefined ? { confirmByEmail: patch.confirmByEmail } : {}),
        ...(patch.portalAtBareAddress !== undefined ? { portalAtBareAddress: patch.portalAtBareAddress } : {}),
        ...(patch.confirmLinkHours !== undefined ? { confirmLinkHours: patch.confirmLinkHours } : {}),
        ...(patch.rememberAddressDays !== undefined ? { rememberAddressDays: patch.rememberAddressDays } : {}),
        ...(patch.title !== undefined ? { portalTitle: patch.title } : {}),
        ...(patch.intro !== undefined ? { portalIntro: patch.intro } : {}),
        ...(patch.backUrl !== undefined ? { portalBackUrl: patch.backUrl, portalBackText: patch.backUrl === null ? null : patch.backText ?? current.portalBackText } : {}),
        ...(patch.backUrl === undefined && patch.backText !== undefined ? { portalBackText: patch.backText } : {}),
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
      return portalWhere(eq(feedbackSettings.portalToken, token));
    },
    /** BOS-1680: the enabled portal the owner chose to open at the bare public address (no token in the link), or null. */
    async bareAddressPortal() {
      return portalWhere(eq(feedbackSettings.portalAtBareAddress, true));
    },
    /** What a visitor sees: features shown on the portal, by stage, with their own votes. */
    async portalView(companyId: string, voter: string | null) {
      const cutoff = new Date(now().getTime() - 180 * 86_400_000);
      const fs = await livePortalFeatures(companyId);
      const mine = voter && fs.length
        ? await db
            .select({ featureId: insights.featureId, importance: insights.importance, comment: feedbackNotes.text, hasComment: sql<boolean>`${feedbackNotes.title} like 'Portal comment:%'` })
            .from(insights)
            .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
            .where(and(eq(feedbackNotes.companyId, companyId), eq(feedbackNotes.portalVoter, voter), counted, inArray(insights.featureId, fs.map((f) => f.id))))
        : [];
      return fs
        .filter((f) => f.status !== "released" || (f.releasedAt && f.releasedAt > cutoff))
        .map((f) => {
          const v = mine.find((m) => m.featureId === f.id);
          return {
            id: f.id,
            // The public title (or the summary's first line) stands in for the internal title, as the summary does for
            // the description: anonymous visitors never see internal text (BOS-991).
            title: portalTitle(f.publicTitle, f.publicSummary),
            description: f.publicSummary!.trim().slice(0, 1000),
            stage: f.status === "released" ? "released" : f.status === "planned" || f.status === "in_progress" ? "planned" : "considering",
            releasedAt: f.status === "released" && f.releasedAt ? f.releasedAt.toISOString() : null,
            myVote: v ? { importance: v.importance, comment: v.hasComment ? v.comment : null } : null,
          };
        });
    },
    /** The Atom feed's entries: the 30 newest released portal features, public text only (never the internal title). */
    async portalFeed(companyId: string) {
      return (await livePortalFeatures(companyId))
        .filter((f) => f.status === "released" && f.releasedAt)
        .sort((a, b) => b.releasedAt!.getTime() - a.releasedAt!.getTime())
        .slice(0, 30)
        .map((f) => ({ id: f.id, title: portalTitle(f.publicTitle, f.publicSummary), summary: f.publicSummary!.trim().slice(0, 1000), releasedAt: f.releasedAt! }));
    },
    /** A visitor's vote: one per visitor and feature; voting again changes it. */
    async portalVote(companyId: string, voter: string, input: { featureId: string; importance: Importance; comment?: string | null; name?: string | null; email?: string | null; confirm?: PortalConfirm }) {
      const [f] = await db.select().from(features).where(and(eq(features.id, input.featureId), eq(features.companyId, companyId), eq(features.portalVisible, true)));
      if (!f || f.status === "declined") throw new FeedbackError(404, "No such feature.");
      // A feature kept off by the portal rule isn't public, so it can't be voted on even if someone has its id.
      if (!(await livePortalFeatures(companyId)).some((x) => x.id === f.id)) throw new FeedbackError(404, "No such feature.");
      const comment = input.comment?.trim() || null;
      const [existing] = await db
        .select({ noteId: feedbackNotes.id })
        .from(insights)
        .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
        .where(and(eq(insights.featureId, f.id), eq(feedbackNotes.portalVoter, voter), eq(feedbackNotes.companyId, companyId), counted));
      const customer = input.name?.trim() ? { name: input.name.trim(), email: input.email?.trim() || null, segment: "Portal" } : null;
      const text = comment ?? `Voted "${IMPORTANCE_LABEL[input.importance]}" for "${f.title}" on the portal.`;
      if (input.confirm) {
        // BOS-1388: saved hidden; the existing vote (if any) stays as it is until the emailed link is clicked.
        const c = newConfirm(input.confirm, input.name);
        const n = await createNote(companyId, { text, title: comment ? `Portal comment: ${f.title}` : `Portal vote: ${f.title}`, source: "portal", untrusted: true, portalVoter: voter, pending: c.pending });
        await db.insert(insights).values({ noteId: n.id, featureId: f.id, importance: input.importance, createdBy: "portal" });
        return { importance: input.importance, comment, confirmToken: c.token, featureTitle: f.title };
      }
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
      return { importance: input.importance, comment, confirmToken: null as string | null, featureTitle: f.title };
    },
    async portalUnvote(companyId: string, voter: string, featureId: string) {
      const rows = await db
        .select({ noteId: feedbackNotes.id })
        .from(insights)
        .innerJoin(feedbackNotes, eq(feedbackNotes.id, insights.noteId))
        .where(and(eq(insights.featureId, featureId), eq(feedbackNotes.portalVoter, voter), eq(feedbackNotes.companyId, companyId), counted));
      if (rows.length) await db.delete(feedbackNotes).where(inArray(feedbackNotes.id, rows.map((r) => r.noteId)));
    },
    /** A visitor's own idea, for the owner (or CEO) to triage. */
    async portalIdea(companyId: string, voter: string, input: { title: string; text: string; name?: string | null; email?: string | null; confirm?: PortalConfirm }) {
      // At most 10 ideas a day from one visitor.
      const [{ n }] = (await db
        .select({ n: count() })
        .from(feedbackNotes)
        .where(and(eq(feedbackNotes.companyId, companyId), eq(feedbackNotes.portalVoter, voter), sql`${feedbackNotes.title} like 'Portal idea:%'`, gt(feedbackNotes.createdAt, new Date(now().getTime() - 86_400_000))))) as [{ n: number }];
      if (Number(n) >= 10) throw new FeedbackError(429, "That's plenty of ideas for one day. Thank you!");
      const customer = input.name?.trim() ? { name: input.name.trim(), email: input.email?.trim() || null, segment: "Portal" } : null;
      const title = `Portal idea: ${input.title}`.slice(0, 200);
      if (input.confirm) {
        const c = newConfirm(input.confirm, input.name);
        await createNote(companyId, { title, text: input.text, source: "portal", untrusted: true, portalVoter: voter, pending: c.pending });
        return { confirmToken: c.token, what: input.title };
      }
      await createNote(companyId, { title, text: input.text, source: "portal", untrusted: true, portalVoter: voter, customer });
      return { confirmToken: null as string | null, what: input.title };
    },

    // ---- BOS-1388: confirming by email ----

    /**
     * The visitor clicked the emailed link. Single use: the token's hash is cleared in the same statement that checks it,
     * so a second click (or a guess, or an expired link) finds nothing. Returns the address to remember, or null.
     */
    async confirmPortalNote(token: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const hash = sha256(token);
      const [seen] = await db.select({ email: feedbackNotes.confirmEmail, name: feedbackNotes.confirmName }).from(feedbackNotes).where(and(eq(feedbackNotes.confirmTokenHash, hash), gt(feedbackNotes.confirmExpiresAt, now())));
      if (!seen?.email) return null;
      // The update is the check: of two clicks at once only one finds the hash still there.
      const [n] = await db
        .update(feedbackNotes)
        .set({ confirmTokenHash: null, confirmExpiresAt: null, confirmEmail: null, confirmName: null })
        .where(and(eq(feedbackNotes.confirmTokenHash, hash), gt(feedbackNotes.confirmExpiresAt, now())))
        .returning();
      if (!n) return null;
      // The customer is made only now, and only when a name was given; an anonymous address is kept nowhere but as a hash.
      if (seen.name) {
        const customerId = await customerFor(n.companyId, { text: "", customer: { name: seen.name, email: seen.email, segment: "Portal" } });
        await db.update(feedbackNotes).set({ customerId }).where(eq(feedbackNotes.id, n.id));
      }
      const row = n;
      // A vote replaces the visitor's earlier one for the same feature, as an unconfirmed-free vote always did.
      const mine = await db.select({ featureId: insights.featureId }).from(insights).where(eq(insights.noteId, n.id));
      if (n.portalVoter && mine.length && row.title?.startsWith("Portal ") && !row.title.startsWith("Portal idea:")) {
        const older = await db
          .select({ id: feedbackNotes.id })
          .from(feedbackNotes)
          .innerJoin(insights, eq(insights.noteId, feedbackNotes.id))
          .where(and(eq(feedbackNotes.companyId, n.companyId), eq(feedbackNotes.portalVoter, n.portalVoter), inArray(insights.featureId, mine.map((m) => m.featureId)), ne(feedbackNotes.id, n.id), counted));
        if (older.length) await db.delete(feedbackNotes).where(inArray(feedbackNotes.id, older.map((o) => o.id)));
      }
      // A comment waits in the inbox for triage; a bare vote arrives processed, as portal votes do.
      if (row.title?.startsWith("Portal vote:")) await db.update(feedbackNotes).set({ state: "processed", processedAt: now() }).where(eq(feedbackNotes.id, n.id));
      else await deps.onNote?.(row);
      return { email: seen.email, companyId: n.companyId };
    },
    /** Remembers a confirmed browser: returns the secret for its cookie (only the hash is stored). */
    async rememberAddress(companyId: string, email: string, days: number) {
      const secret = randomBytes(32).toString("base64url");
      await db.insert(portalConfirmedAddresses).values({ companyId, emailHash: emailHash(email), secretHash: sha256(secret), expiresAt: new Date(now().getTime() + days * 86_400_000) });
      return secret;
    },
    /** Whether this cookie (address and secret) is one the server issued for this portal and has not expired. */
    async addressRemembered(companyId: string, email: string, secret: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return false;
      const [row] = await db
        .select({ id: portalConfirmedAddresses.id })
        .from(portalConfirmedAddresses)
        .where(and(eq(portalConfirmedAddresses.companyId, companyId), eq(portalConfirmedAddresses.secretHash, sha256(secret)), eq(portalConfirmedAddresses.emailHash, emailHash(email)), gt(portalConfirmedAddresses.expiresAt, now())));
      return !!row;
    },
    /** Deletes unconfirmed posts whose link has expired, and remembered browsers past their time. */
    async purgeUnconfirmed() {
      const at = now();
      const gone = await db.delete(feedbackNotes).where(and(sql`${feedbackNotes.confirmTokenHash} is not null`, lt(feedbackNotes.confirmExpiresAt, at))).returning({ id: feedbackNotes.id });
      const old = await db.delete(portalConfirmedAddresses).where(lt(portalConfirmedAddresses.expiresAt, at)).returning({ id: portalConfirmedAddresses.id });
      return { notes: gone.length, addresses: old.length };
    },

    /** Unprocessed notes, oldest first, for whoever triages them. */
    untriaged: (companyId: string, limit = 20) =>
      db
        .select({ note: feedbackNotes, customer: feedbackCustomers.name })
        .from(feedbackNotes)
        .leftJoin(feedbackCustomers, eq(feedbackCustomers.id, feedbackNotes.customerId))
        .where(and(eq(feedbackNotes.companyId, companyId), eq(feedbackNotes.state, "unprocessed"), counted))
        .orderBy(asc(feedbackNotes.createdAt))
        .limit(limit),
  };
}
