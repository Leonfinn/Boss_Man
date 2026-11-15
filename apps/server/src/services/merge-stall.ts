// Merge stall alarm (BOS-1515, fix B3 of BOS-1511): the merge train says when it has stopped. On 14 Nov a ticket held to land
// alone kept two free seats empty for over half an hour, and nothing landed for 50 minutes, with nobody told.
//
// Two stalls, each read from the train's own clocks (merge-train.ts facts()), never from notes:
// - empty_seat: a seat has been free for EMPTY_SEAT_MS while a ticket that could take it waits (the restart seed wait excluded);
// - no_landing: nothing has landed for NO_LANDING_MS while tickets are in the train.
// The CEO is woken at once, once per stall (a "waiting" class wake, never dropped), with the live facts and the cause when it is
// known (a ticket held to land alone, with the ticket it clashed with and the files). The owner gets one notification if the
// stall still stands OWNER_AFTER_MS (fix A's 15 minutes) after the CEO was told; it is marked read when the stall clears.
//
// Trains live in memory on the server in charge, so this runs there (the sweep's pass). A restart rebuilds the train and resets
// its clocks: that errs toward fewer alarms, never more. Episodes are kept in settings (merge_stall:<projectId>:<cause>) so a
// stall is told once across passes; one whose project has no train any more is cleared.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ageWords, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, companies, notifications, projects, settings, tickets } from "../db/schema.js";
import { clashWords } from "./merge-line.js";
import { trainFacts, trainProjects, type TrainFacts } from "./merge-train.js";
import { OWNER_AFTER_MS } from "./priority-watch.js";

export const MERGE_STALL_REASON = "merge line stalled";
export const EMPTY_SEAT_MS = 3 * 60_000;
export const NO_LANDING_MS = 45 * 60_000;

export type StallCause = "empty_seat" | "no_landing";

/** Pure: the stalls standing now, each with when it began (its identity: a new start is a new stall, told again). */
export function stalls(f: TrainFacts, now: number): Array<{ cause: StallCause; since: number }> {
  const out: Array<{ cause: StallCause; since: number }> = [];
  if (f.emptySeatSince !== null && !f.seeding && now - f.emptySeatSince >= EMPTY_SEAT_MS) out.push({ cause: "empty_seat", since: f.emptySeatSince });
  if (f.noLandingSince !== null && f.seated.length + f.waiting.length > 0 && now - f.noLandingSince >= NO_LANDING_MS) out.push({ cause: "no_landing", since: f.noLandingSince });
  return out;
}

type Named = { ref: string | null; title: string; companyId: string };
const label = (n: Named | undefined, id: string) => n?.ref ?? (n ? `"${n.title}"` : id.slice(0, 8));

/** The train in words for server_status: refs, held-alone clashes and the stall clocks as ISO times. */
export type MergeTrainStatus = {
  projectId: string;
  project: string;
  seats: number;
  seated: string[];
  waiting: string[];
  heldAlone: Array<{ ticketId: string; ticket: string; clashWith: string[]; files: string[]; since: string | null; passed: number; holdsLine: boolean }>;
  emptySeatSince: string | null;
  lastLandingAt: string | null;
  noLandingSince: string | null;
  seeding: boolean;
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

async function names(db: Db, ids: string[]): Promise<Map<string, Named>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: tickets.id, title: tickets.title, number: tickets.number, companyId: tickets.companyId, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(inArray(tickets.id, ids));
  return new Map(rows.map((r) => [r.id, { ref: ticketRef(r.prefix, r.number), title: r.title, companyId: r.companyId }]));
}

const idsOf = (f: TrainFacts) => [...new Set([...f.seated, ...f.waiting, ...f.heldAlone.flatMap((h) => h.clash?.with ?? [])])];

function inWords(f: TrainFacts, n: Map<string, Named>): MergeTrainStatus["heldAlone"] {
  return f.heldAlone.map((h) => ({
    ticketId: h.ticketId,
    ticket: label(n.get(h.ticketId), h.ticketId),
    clashWith: (h.clash?.with ?? []).map((id) => label(n.get(id), id)),
    files: h.clash?.files ?? [],
    since: iso(h.clash?.at ?? null),
    passed: h.passed,
    holdsLine: h.holdsLine,
  }));
}

/** server_status mergeTrain: each of the company's projects this server has a train for. Read only. */
export async function mergeTrainStatus(db: Db, companyId: string, facts: (projectId: string) => TrainFacts | null = trainFacts): Promise<MergeTrainStatus[]> {
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.companyId, companyId));
  const out: MergeTrainStatus[] = [];
  for (const p of rows) {
    const f = facts(p.id);
    if (!f) continue;
    const n = await names(db, idsOf(f));
    out.push({
      projectId: p.id,
      project: p.name,
      seats: f.seats,
      seated: f.seated.map((id) => label(n.get(id), id)),
      waiting: f.waiting.map((id) => label(n.get(id), id)),
      heldAlone: inWords(f, n),
      emptySeatSince: iso(f.emptySeatSince),
      lastLandingAt: iso(f.lastLandingAt),
      noLandingSince: iso(f.noLandingSince),
      seeding: f.seeding,
    });
  }
  return out;
}

type Episode = { since: number; toldAt: string; ownerTold: boolean; ownerNotificationId: string | null };
const KEY = (projectId: string, cause: StallCause) => `merge_stall:${projectId}:${cause}`;

export function mergeStallService(
  db: Db,
  deps: {
    /** Wakes the company's CEO on the ticket, on a wake that is never dropped. */
    tellCeo: (input: { companyId: string; ticketId: string; note: string }) => Promise<unknown>;
    notify: (input: { companyId: string; level: "note" | "flag" | "page"; title: string; body: string; link: string }) => Promise<{ id: string; level: string } | null>;
    now?: () => Date;
    /** The trains to watch; the live ones by default (tests pass their own, on a fake clock). */
    trains?: () => Array<{ projectId: string; facts: TrainFacts }>;
  },
) {
  const now = deps.now ?? (() => new Date());
  const trains = deps.trains ?? (() => trainProjects().flatMap((projectId) => {
    const facts = trainFacts(projectId);
    return facts ? [{ projectId, facts }] : [];
  }));

  async function clear(key: string, e: Episode | null, at: Date) {
    if (e?.ownerNotificationId) await db.update(notifications).set({ readAt: at }).where(and(eq(notifications.id, e.ownerNotificationId), isNull(notifications.readAt)));
    await db.delete(settings).where(eq(settings.key, key));
  }

  /** The stall in words, from the live facts: seats, who is seated and who waits, the cause, and the running check for a no-landing. */
  async function describe(cause: StallCause, f: TrainFacts, since: number, n: Map<string, Named>, at: number): Promise<string> {
    const who = (ids: string[]) => (ids.length ? ids.map((id) => label(n.get(id), id)).join(", ") : "none");
    const facts = `${f.seats} seat${f.seats === 1 ? "" : "s"}; seated: ${who(f.seated)}; waiting: ${who(f.waiting)}`;
    const heldText = (h: TrainFacts["heldAlone"][number]) =>
      `${label(n.get(h.ticketId), h.ticketId)} is held to land on main alone${h.clash ? `: it clashed with ${clashWords(h.clash.with.map((id) => label(n.get(id), id)), h.clash.files)}` : ""}${h.holdsLine ? `, and ${h.passed} ticket${h.passed === 1 ? " has" : "s have"} passed it, so it holds the line until the train ahead lands` : ""}`;
    const held = f.heldAlone.map(heldText);
    if (cause === "empty_seat") {
      const blocking = f.heldAlone.filter((h) => h.holdsLine).map(heldText);
      const why = blocking.length ? blocking.join("; ") : "no reason known: likely a fault, check server_status mergeTrain";
      return `Merge line stalled: a merge-train seat has been empty for ${ageWords(at - since)} while tickets wait (${facts}). Cause: ${why}.`;
    }
    const running = f.seated.length
      ? await db.select({ ticketId: checkJobs.ticketId, startedAt: checkJobs.startedAt }).from(checkJobs).where(and(inArray(checkJobs.ticketId, f.seated), eq(checkJobs.kind, "merge"), eq(checkJobs.state, "running")))
      : [];
    const checks = running.length ? `Running now: ${running.map((r) => `${label(n.get(r.ticketId!), r.ticketId!)}'s merge check, for ${r.startedAt ? ageWords(at - r.startedAt.getTime()) : "an unknown time"}`).join("; ")} (a long check, not a stall, if it is still working).` : "No merge check is running.";
    const why = held.length ? ` ${held.join("; ")}.` : "";
    return `Merge line stalled: nothing has landed for ${ageWords(at - since)} while tickets are in the merge train (${facts}). ${checks}${why}`;
  }

  return {
    /** One pass (the sweep calls it every minute). Errors in one project don't stop the others. */
    async run(): Promise<{ told: number; ownerTold: number; cleared: number }> {
      const t = now();
      const at = t.getTime();
      const out = { told: 0, ownerTold: 0, cleared: 0 };
      const live = trains();
      const standing = new Map<string, { projectId: string; facts: TrainFacts; cause: StallCause; since: number }>();
      for (const { projectId, facts } of live) for (const s of stalls(facts, at)) standing.set(KEY(projectId, s.cause), { projectId, facts, ...s });
      // Episodes that no longer stand (cleared, a new start, or no train any more) go, with the owner's notification.
      const kept = await db.select({ key: settings.key, value: settings.value }).from(settings).where(sql`${settings.key} like 'merge_stall:%'`);
      const episodes = new Map<string, Episode>();
      for (const row of kept) {
        const e = row.value as Episode | null;
        const s = standing.get(row.key);
        if (s && e && e.since === s.since) {
          episodes.set(row.key, e);
          continue;
        }
        await clear(row.key, e, t).catch(() => undefined);
        out.cleared++;
      }
      for (const [key, s] of standing) {
        try {
          const n = await names(db, idsOf(s.facts));
          // The CEO is woken on a ticket: the one holding the line, else the first waiting, else the head.
          const on = s.facts.heldAlone.find((h) => h.holdsLine)?.ticketId ?? s.facts.waiting[0] ?? s.facts.seated[0];
          const companyId = on ? n.get(on)?.companyId : undefined;
          if (!on || !companyId) continue;
          let e = episodes.get(key) ?? null;
          if (!e) {
            const note = `${await describe(s.cause, s.facts, s.since, n, at)} Get the line moving (send back or move the ticket in the way), or say why it is right to wait.`;
            await deps.tellCeo({ companyId, ticketId: on, note }).catch(() => undefined);
            e = { since: s.since, toldAt: t.toISOString(), ownerTold: false, ownerNotificationId: null };
            out.told++;
          } else if (!e.ownerTold && at - new Date(e.toldAt).getTime() >= OWNER_AFTER_MS) {
            const body = `${await describe(s.cause, s.facts, s.since, n, at)} The CEO was told ${ageWords(at - new Date(e.toldAt).getTime())} ago and it has not moved.`;
            const sent = await deps.notify({ companyId, level: "flag", title: s.cause === "empty_seat" ? "The merge line has an empty seat it isn't using" : "Nothing has merged for a long time", body, link: `#/merge-queue/${companyId}` }).catch(() => null);
            e = { ...e, ownerTold: true, ownerNotificationId: sent?.id ?? null };
            out.ownerTold++;
          } else continue;
          await db.insert(settings).values({ key, value: e }).onConflictDoUpdate({ target: settings.key, set: { value: e } });
        } catch {
          // An alarm must never stop the line, nor the other projects' alarms.
        }
      }
      return out;
    },
  };
}
