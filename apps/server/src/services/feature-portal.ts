// Features go on the feedback portal by default; one held off it — the security guess or someone's
// keep-off mark — must not disappear quietly, so the owner is asked once per feature (BOS-1358). This
// raises that card and records the answer; the answer itself is applied in decisions.ts.
//
// The card is one per feature: each needs its own Keep off / Publish. It sits on the owner's tier only
// and closes itself when the feature is settled elsewhere (someone ticks it on, or marks it keep-off by
// hand), so a later choice never leaves a stale card behind (DR-016, BOS-470).
import { and, eq, inArray, ne } from "drizzle-orm";
import { portalVerdict } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { decisions, featureAreas, featureDrivers, features } from "../db/schema.js";

export const PORTAL_KEEP_OFF = "Keep off the portal";
export const PORTAL_PUBLISH = "Publish";
export const PORTAL_OPTIONS = [PORTAL_KEEP_OFF, PORTAL_PUBLISH];

/** The card's dedupe key: one card per feature, ever (a second raise folds into the one already open). */
export const featurePortalKey = (featureId: string) => `feature-portal-hold:${featureId}`;

/** One feature held off the portal, as the card reads it. */
export type HeldOffFeature = {
  id: string;
  /** The internal title, which only the team sees. */
  title: string;
  /** Why it is off, in plain words: the keep-off reason, or that it reads as security work. */
  reason: string;
  /** Whether a public summary exists, so Publish can actually show it. */
  hasPublicSummary: boolean;
};

/** The reasons the portal rule holds a feature off by a choice or the security guess (not "needs public summary"). */
const HOLD_REASONS = new Set(["sensitive", "security"]);

/** Cards raised in one sweep pass, so a first run over many old held-off features trickles out rather than flooding. */
export const MAX_CARDS_PER_PASS = 10;

/**
 * The features of a company held off the portal for a reason the owner should settle: the security guess
 * or a keep-off mark. A feature only waiting for a public summary is ticked on and is not held off by a
 * choice, so it is left alone. The rule judges the stored feature, so an agent can't slip one past it
 * (BOS-991).
 */
export async function heldOffFeatures(db: Db, companyId: string): Promise<HeldOffFeature[]> {
  const fs = await db.select().from(features).where(and(eq(features.companyId, companyId), ne(features.status, "declined")));
  if (!fs.length) return [];
  const areaIds = [...new Set(fs.map((f) => f.areaId).filter((id): id is string => !!id))];
  const areaName = new Map((areaIds.length ? await db.select({ id: featureAreas.id, name: featureAreas.name }).from(featureAreas).where(inArray(featureAreas.id, areaIds)) : []).map((a) => [a.id, a.name]));
  const drivers = await db.select({ id: featureDrivers.id, name: featureDrivers.name }).from(featureDrivers).where(eq(featureDrivers.companyId, companyId));
  const driverName = new Map(drivers.map((d) => [d.id, d.name]));
  const out: HeldOffFeature[] = [];
  for (const f of fs) {
    const scores = f.driverScores as Record<string, number | null>;
    const criteria = Object.keys(scores)
      .filter((id) => scores[id] !== null)
      .map((id) => driverName.get(id))
      .filter((n): n is string => !!n);
    const verdict = portalVerdict({ title: f.title, description: f.description, area: f.areaId ? (areaName.get(f.areaId) ?? null) : null, criteria, keepOffPortal: f.keepOffPortal, hasPublicSummary: !!f.publicSummary?.trim() });
    if (verdict.reason === "needs public summary" || !HOLD_REASONS.has(String(verdict.reason))) continue;
    const reason = verdict.reason === "sensitive" ? (f.keepOffReason?.trim() ? `kept off by hand: ${f.keepOffReason.trim()}` : "kept off by hand") : "it reads as security work";
    out.push({ id: f.id, title: f.title, reason, hasPublicSummary: !!f.publicSummary?.trim() });
  }
  return out;
}

/** The card's question: the feature, why it is held, and how Publish would work. */
export function portalHoldQuestion(f: HeldOffFeature): string {
  const lines = [`The feature "${f.title}" is held off the feedback portal: ${f.reason}.`, "", "Keep it off, or publish it to the portal?"];
  if (!f.hasPublicSummary) lines.push("", "Publishing needs a public summary first: visitors see that, never the internal title. The CEO or a product manager can write one; until then a feature set to publish stays hidden.");
  return lines.join("\n");
}

/**
 * Raises one owner card for each held-off feature not asked about yet, for every company. Called by the
 * sweep, so a feature created by any route (Features page, CEO or PM tool, feedback triage, import) is
 * covered. Returns how many cards it raised. Safe to call often: a feature already asked about is skipped.
 */
export async function raiseHeldPortalCards(db: Db, at: Date): Promise<{ raised: number }> {
  const companies = [...new Set((await db.select({ companyId: features.companyId }).from(features).where(ne(features.status, "declined"))).map((r) => r.companyId))];
  let raised = 0;
  for (const companyId of companies) {
    if (raised >= MAX_CARDS_PER_PASS) break;
    const held = await heldOffFeatures(db, companyId);
    if (!held.length) continue;
    const keys = held.map((f) => featurePortalKey(f.id));
    // Already asked about (open or answered): never ask twice for the same feature.
    const asked = new Set((await db.select({ dedupeKey: decisions.dedupeKey }).from(decisions).where(inArray(decisions.dedupeKey, keys))).map((d) => d.dedupeKey));
    const todo = held.filter((f) => !asked.has(featurePortalKey(f.id))).slice(0, MAX_CARDS_PER_PASS - raised);
    if (!todo.length) continue;
    const rows = await db
      .insert(decisions)
      .values(
        todo.map((f) => ({
          companyId,
          kind: "question" as const,
          question: portalHoldQuestion(f),
          options: PORTAL_OPTIONS,
          recommendedOption: f.hasPublicSummary ? PORTAL_PUBLISH : PORTAL_KEEP_OFF,
          tier: "owner" as const,
          dedupeKey: featurePortalKey(f.id),
          createdAt: at,
          context: { type: "feature_portal_hold" as const, featureId: f.id, clearWhen: [{ kind: "featurePortalSettled", featureId: f.id }] },
        })),
      )
      .onConflictDoNothing()
      .returning({ id: decisions.id });
    raised += rows.length;
  }
  return { raised };
}

/** Applies the owner's answer to the feature: publish puts it on the portal; keep off marks it keep-off by hand. */
export async function applyPortalAnswer(db: Db, featureId: string, answer: string, at: Date): Promise<{ title: string; published: boolean } | null> {
  const [f] = await db.select({ id: features.id, title: features.title, publicSummary: features.publicSummary }).from(features).where(eq(features.id, featureId));
  if (!f) return null;
  if (answer === PORTAL_PUBLISH) {
    // Publish clears the hand-kept mark and ticks it on; without a summary it stays hidden until one is written.
    await db.update(features).set({ portalVisible: true, keepOffPortal: false, keepOffReason: null, updatedAt: at }).where(eq(features.id, featureId));
    return { title: f.title, published: !!f.publicSummary?.trim() };
  }
  await db.update(features).set({ keepOffPortal: true, portalVisible: false, keepOffReason: "kept off by the owner", updatedAt: at }).where(eq(features.id, featureId));
  return { title: f.title, published: false };
}
