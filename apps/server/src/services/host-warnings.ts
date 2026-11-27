// A warning on Settings → This host that lasts (BOS-2674). The host reports every minute or so. A failing check or an
// add-on that is not running, seen in two different reports in a row, is no longer a blip: the CEO gets one alert, so the
// owner is never the first to notice. The alert closes by itself once the host stops reporting the problem.
// Nothing here names a container, a path or a host: the keys are whatever the host reported.
import { eq } from "drizzle-orm";
import { isFailingCheck } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { HOST_FACTS_KEY, HOST_REPORT_FRESH_MS, type HostFactsRecord } from "./host-facts.js";

const STREAK_KEY = "host_warning_streaks";
/** Reports in a row that show the same warning before the CEO is told. */
export const WARNING_REPORTS = 2;
export const hostWarningAlertKey = (key: string) => `alert:host-warning:${key}`;
export const hostWarningOwnerKey = (key: string) => `alert:host-warning-owner:${key}`;
/** How long the CEO's card may stay unanswered before the owner gets a notice (BOS-2721). */
export const HOST_WARNING_OWNER_AFTER_MS = 30 * 60_000;

type Streaks = Record<string, { reports: number; since: string }>;
type Streak = { lastReportedAt: string | null; warnings: Streaks };

/** The reported facts that are a warning now: a failing check, or an add-on that is not running. */
export function warningKeys(facts: Record<string, { value: string }>): string[] {
  const out: string[] = [];
  for (const [k, f] of Object.entries(facts)) {
    const v = f.value.trim();
    if (!v) continue;
    if (k.startsWith("addon.") ? v.toLowerCase() !== "running" : isFailingCheck(k, v)) out.push(k);
  }
  return out.sort();
}

async function readStreak(db: Db): Promise<Streak> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, STREAK_KEY));
  const v = row?.value as Partial<Streak> | undefined;
  return { lastReportedAt: typeof v?.lastReportedAt === "string" ? v.lastReportedAt : null, warnings: v?.warnings && typeof v.warnings === "object" ? v.warnings : {} };
}

/** For the closer: null while the host still reports this warning, otherwise why the alert can go. */
export async function hostWarningGoneReason(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, HOST_FACTS_KEY));
  const rec = row?.value as Partial<HostFactsRecord> | undefined;
  if (!rec?.facts) return null;
  return warningKeys(rec.facts).includes(key) ? null : `the host no longer reports "${key}" as a problem`;
}

export type HostWarningDeps = {
  now: () => Date;
  /** The newest folded host facts (hostFacts.sync). */
  facts: () => Promise<HostFactsRecord>;
  homeCompany: () => Promise<string | null>;
  isOpen: (dedupeKey: string) => Promise<boolean>;
  /** The newest card with this dedupe key, open or answered (BOS-2721): when it was raised and what the CEO answered. */
  card?: (dedupeKey: string) => Promise<{ status: string; createdAt: Date; answer: string | null } | null>;
  /** The open ticket that names this warning key, if any, with its assignee and the first work run they started on it (BOS-2737). */
  ticketFor?: (key: string) => Promise<WarningTicket | null>;
  raise: (input: Record<string, unknown>) => Promise<unknown>;
  log?: (m: string) => void;
};

/** `ticket` is the open ticket that names this warning's key in its title or body (the card asks the CEO to put it there). */
export type WarningHandling = {
  /** watching: no card yet. ceo_told: the CEO's card is open and unanswered. ceo_answered: the CEO answered the card. */
  state: "watching" | "ceo_told" | "ceo_answered";
  reports: number;
  since: string;
  /** When the CEO's card was raised (ISO), with the states that have a card. */
  alertedAt?: string;
  /** The CEO's note on the card, with ceo_answered. */
  answer?: string;
  ticket?: WarningTicket;
};

/** The ticket open for a warning: `agent` is its assignee's name (null when unassigned), `startedAt` their first work run on it (ISO). */
export type WarningTicket = { ref: string; title: string; agent?: string | null; startedAt?: string };

export function hostWarningService(db: Db, deps: HostWarningDeps) {
  return {
    /** One pass: count each warning once per host report; raise the CEO's alert when it has lasted. Returns the keys raised. */
    async check(): Promise<string[]> {
      const rec = await deps.facts();
      if (!rec.reportedAt) return [];
      const age = deps.now().getTime() - Date.parse(rec.reportedAt);
      if (!Number.isFinite(age) || age > HOST_REPORT_FRESH_MS) return []; // a silent host is the stale-record warning's business, not a repeat of the old report
      const prev = await readStreak(db);
      const keys = warningKeys(rec.facts);
      const fresh = prev.lastReportedAt !== rec.reportedAt;
      const next: Streaks = {};
      for (const k of keys) {
        const old = prev.warnings[k];
        next[k] = old ? { ...old, reports: old.reports + (fresh ? 1 : 0) } : { reports: 1, since: rec.reportedAt };
      }
      if (fresh || JSON.stringify(next) !== JSON.stringify(prev.warnings)) {
        const value: Streak = { lastReportedAt: rec.reportedAt, warnings: next };
        await db.insert(settings).values({ key: STREAK_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      }
      const raised: string[] = [];
      const lasting = keys.filter((k) => next[k]!.reports >= WARNING_REPORTS);
      if (!lasting.length) return raised;
      const companyId = await deps.homeCompany();
      if (!companyId) return raised;
      for (const k of lasting) {
        if (await deps.isOpen(hostWarningAlertKey(k))) {
          await this.escalate(companyId, k, rec.facts[k]!.value.trim(), raised);
          continue;
        }
        const value = rec.facts[k]!.value.trim();
        const card = await deps.raise({
          companyId,
          kind: "host_warning",
          question: `Settings → This host has shown "${k}" = "${value}" in ${next[k]!.reports} host reports in a row (since ${next[k]!.since}). The owner has not been asked to do anything. Find out what is behind it (host facts, the runner and server status, the open tickets), say on Settings → This host whether it matters, and open a ticket if it needs work (put the exact key "${k}" in the ticket's title or body: the panel links the ticket by it). This card closes by itself when the host stops reporting it.`,
          from: "ceo",
          why: "a host warning has lasted across reports and nobody is handling it yet",
          dedupeKey: hostWarningAlertKey(k),
          clearWhen: [{ kind: "hostWarningGone", key: k }],
          context: { hostWarning: { key: k, value, since: next[k]!.since } },
        });
        if (card) {
          raised.push(k);
          deps.log?.(`host warning: told the CEO about ${k}`);
        }
      }
      return raised;
    },

    /**
     * BOS-2721: the CEO's card has sat open and unanswered for 30 minutes. The ceiling of the card is the CEO, so it
     * never climbs by itself; one info notice goes to the owner's queue instead, and closes with the warning.
     */
    async escalate(companyId: string, k: string, value: string, raised: string[]): Promise<void> {
      const card = await deps.card?.(hostWarningAlertKey(k));
      if (!card || card.status !== "open") return;
      const waited = deps.now().getTime() - card.createdAt.getTime();
      if (waited < HOST_WARNING_OWNER_AFTER_MS) return;
      if (await deps.isOpen(hostWarningOwnerKey(k))) return;
      const sent = await deps.raise({
        companyId,
        kind: "host_warning_owner",
        question: `Settings → This host still shows "${k}" = "${value}", and the CEO has not answered the alert raised ${Math.round(waited / 60_000)} minutes ago. Nothing for you to do unless you want to look: this closes by itself when the host stops reporting it.`,
        from: "owner",
        why: "the CEO has not answered a host warning in 30 minutes, so the owner should know",
        dedupeKey: hostWarningOwnerKey(k),
        clearWhen: [{ kind: "hostWarningGone", key: k }],
        context: { hostWarning: { key: k, value } },
      });
      if (sent) {
        raised.push(`${k} (owner)`);
        deps.log?.(`host warning: ${k} unanswered for 30 minutes, told the owner`);
      }
    },

    /** What the panel says Boss Man is doing about each current warning, by key. */
    async handling(): Promise<Record<string, WarningHandling>> {
      const s = await readStreak(db);
      const out: Record<string, WarningHandling> = {};
      for (const [k, w] of Object.entries(s.warnings)) {
        const ticket = (await deps.ticketFor?.(k).catch(() => null)) ?? undefined;
        const card = (await deps.card?.(hostWarningAlertKey(k)).catch(() => null)) ?? ((await deps.isOpen(hostWarningAlertKey(k))) ? { status: "open", createdAt: null, answer: null } : null);
        const alertedAt = card?.createdAt ? { alertedAt: card.createdAt.toISOString() } : {};
        if (!card) out[k] = { state: "watching", reports: w.reports, since: w.since };
        else if (card.status === "open") out[k] = { state: "ceo_told", reports: w.reports, since: w.since, ...alertedAt };
        else out[k] = { state: "ceo_answered", reports: w.reports, since: w.since, ...alertedAt, ...(card.answer ? { answer: card.answer } : {}) };
        if (ticket) out[k]!.ticket = ticket;
      }
      return out;
    },
  };
}
export type HostWarnings = ReturnType<typeof hostWarningService>;
