// "No progress while work waits" (BOS-593, N4 of BOS-588, from DR-031's HolidayHours evidence).
// HolidayHours made no progress for two days and nothing told anyone: its wakes were held at the
// all-companies run limit, and the network guard refused its git host. Every alert that exists
// watches one run, one agent or one account; none watches a company as a whole. This one does.
//
// Two triggers, one card per company:
// A. Work has waited for an hour (a wake queued or due, not held by a pause or quiet hours) and no
//    work run in the company has ended cleanly in that hour.
// B. The same failure signature three times in an hour from two or more agents: one cause hitting
//    several agents, which the per-ticket loop guard (loop-guards.ts) can't see.
//
// The card names the likely cause from what Boss Man can see (runner, holds on the waiting wakes,
// errors of the last hour, runs waiting in the check line). A platform-side cause is one the company
// can't fix itself, so a copy also goes to the home company's CEO, who runs the platform.
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, failureSignatures, runners, runs, settings, wakes } from "../db/schema.js";
import type { AlertInput } from "./alert-ladder.js";
import { HELD_AGENT, HELD_ALL_COMPANIES, HELD_COMPANY } from "./fair-share.js";
import { accountOutage } from "./loop-guards.js";
import { HOLD_REASON } from "./maintenance.js";

/** How long work may wait with no clean run, and the window for trigger B. */
export const NO_PROGRESS_AFTER_MS = 60 * 60_000;
/** Trigger B: this many failures with one signature, from at least this many agents, within the window. */
export const SAME_ERROR_FAILURES = 3;
export const SAME_ERROR_AGENTS = 2;
/** After a person answered a card ("Got it") while the company is still stuck, wait this long before another. */
export const NO_PROGRESS_QUIET_MS = 4 * 3_600_000;

/** Wakes held on purpose, which are not work waiting on Boss Man. */
const DELIBERATE_HOLDS = ["company paused", "agent paused", "quiet hours", HOLD_REASON];

/**
 * A run that counts as progress: it ended, and not on an error, a loss, a cut-off or a stop. The CEO's
 * run that only reads cards (origin "decision") doesn't count, or reading this card would hide it.
 * Same test as the card's closer (alert-clearing.ts companyRanOk).
 */
const cleanEndSql = sql`${runs.endedAt} is not null and ${runs.origin} is distinct from 'decision' and coalesce(${runs.outcome}, '') not like 'error:%' and coalesce(${runs.outcome}, '') not like 'lost:%' and coalesce(${runs.outcome}, '') <> 'interrupted' and coalesce(${runs.outcome}, '') <> 'cancelled' and coalesce(${runs.outcome}, '') not like 'stopped%'`;

/** Network failures as the agent's tools report them: what the network guard's refusal looks like from inside a run. */
const NETWORK_ERROR = /(network guard|netguard|connection refused|econnrefused|could not resolve host|enotfound|network is unreachable|no route to host|ehostunreach|failed to connect to|connection timed out|etimedout)/i;
/** A run outcome left by the runner going away (lostRuns, BOS-574, DR-031). */
const RUNNER_LOSS = /^(lost: runner|lost: never started|interrupted$)/i;

export type NoProgressFacts = {
  /** null: the company has no runner registered. */
  runnerConnected: boolean | null;
  /** The company's work runs that haven't ended. */
  liveRuns: number;
  /** How many of those are waiting in the shared check line (check-quick.sh / check-all.sh). */
  liveInCheckLine: number;
  /** Why the waiting wakes are held, as the scheduler wrote it (wakes.status_reason); null when it gave none. */
  holds: Array<string | null>;
  /** Outcomes of the company's work runs that ended badly in the last hour. */
  badEnds: string[];
};

export type NoProgressCause = { text: string; platform: false | "runner" | "network guard" | "check line" | "run limit" };

/** The most common item, for naming the error several runs hit. */
function commonest(xs: string[]): string | null {
  // shortcut: one string per distinct outcome in a sweep; tens at most, fresh every pass, so no cap needed.
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const short = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/**
 * The likely cause, from the facts, most decisive first. Platform-side causes are the ones the
 * company can't fix from inside: its runner, the network guard, the shared check line, and the
 * all-companies run limit filled by other companies. Exported for its own tests.
 */
export function likelyCause(f: NoProgressFacts): NoProgressCause {
  if (f.runnerConnected === null) return { text: "the company has no runner, so nothing can start", platform: "runner" };
  if (!f.runnerConnected) return { text: "its runner is offline, so nothing can start", platform: "runner" };
  const lost = f.badEnds.filter((o) => RUNNER_LOSS.test(o));
  if (lost.length && lost.length * 2 >= f.badEnds.length) return { text: `its runs keep being cut off by the runner (${lost.length} in the last hour, e.g. "${short(lost[0]!)}")`, platform: "runner" };
  const net = f.badEnds.filter((o) => NETWORK_ERROR.test(o));
  if (net.length) return { text: `its runs fail to reach the network (${net.length} in the last hour: "${short(commonest(net)!)}"); the network guard may be refusing a host it needs`, platform: "network guard" };
  if (f.liveRuns > 0 && f.liveInCheckLine === f.liveRuns) return { text: `all ${f.liveRuns} of its running agents are waiting in the shared check line`, platform: "check line" };
  const held = (re: RegExp) => f.holds.filter((h) => h && re.test(h)).length;
  const heldAs = (...reasons: string[]) => f.holds.filter((h) => h != null && reasons.includes(h)).length;
  // The scheduler writes the fair-share reasons verbatim (BOS-582). The bare "at a concurrency limit" is
  // what wakes held before BOS-582 still carry, for any of the three limits. It is counted with the
  // all-companies hold: with nothing of the company's own running, that is the only limit that can be full.
  const allCompanies = heldAs(HELD_ALL_COMPANIES, "at a concurrency limit");
  const ownLimit = heldAs(HELD_COMPANY, HELD_AGENT);
  // Its own runs are 0, so the limit holding it is the all-companies one, kept full by others (DR-031's proof).
  if (allCompanies && f.liveRuns === 0) return { text: `${allCompanies} of its wakes are held "at a concurrency limit" while it has nothing running: other companies' runs are filling the all-companies run limit`, platform: "run limit" };
  const quota = held(/^subscription /);
  if (quota) return { text: `${quota} of its wakes are held because the owner's account is near its usage limit`, platform: false };
  const budget = held(/budget|cost cap|monthly cap/);
  if (budget) return { text: `${budget} of its wakes are held by a budget or cost cap`, platform: false };
  // Held by its own company or agent limit, or by the all-companies one while some of its own runs are
  // going: either way its own unfinished runs are what it waits on, so the company's, not the platform's.
  if (ownLimit || allCompanies) return { text: `its own run limit is full (${f.liveRuns} running) and none of those runs has finished in the last hour`, platform: false };
  const err = commonest(f.badEnds);
  if (err) {
    const account = accountOutage(err);
    return { text: `its runs keep failing (${f.badEnds.length} in the last hour${account ? `, ${account.name}: ${account.window ?? "a login or credit error"}` : ""}): "${short(err)}"`, platform: false };
  }
  const other = commonest(f.holds.filter((h): h is string => !!h));
  if (other) return { text: `its wakes are held: "${short(other)}"`, platform: false };
  if (f.liveRuns) return { text: `${f.liveRuns} run${f.liveRuns === 1 ? " is" : "s are"} going but none has finished in the last hour`, platform: false };
  return { text: "Boss Man can't tell why from its queue: the wakes are queued with no hold recorded", platform: false };
}

/** The platform causes, as the home company's CEO reads them. */
const PLATFORM_LABEL: Record<Exclude<NoProgressCause["platform"], false>, string> = {
  runner: "the runner",
  "network guard": "the network guard",
  "check line": "the check line",
  "run limit": "the all-companies run limit",
};

export function noProgressSweep(
  db: Db,
  opts: {
    alert: (input: AlertInput) => Promise<{ id: string } | null>;
    isConnected: (runnerId: string) => boolean;
    /** Whether a live run is waiting in the shared check line (sweeps.ts busyInCommand). */
    inCheckLine: (runId: string) => Promise<boolean>;
  },
) {
  /** Oldest company: Boss Man's own (self-deploy.ts homeCompany). */
  async function homeCompany() {
    const [c] = await db.select({ id: companies.id }).from(companies).orderBy(companies.createdAt).limit(1);
    return c?.id ?? null;
  }

  async function facts(companyId: string, since: Date, holds: Array<string | null>): Promise<NoProgressFacts> {
    const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
    const live = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.companyId, companyId), isNull(runs.endedAt), sql`${runs.purpose} is distinct from 'chat'`));
    let inLine = 0;
    for (const r of live) if (await opts.inCheckLine(r.id)) inLine++;
    const bad = await db
      .select({ outcome: runs.outcome })
      .from(runs)
      .where(and(eq(runs.companyId, companyId), gte(runs.endedAt, since), sql`${runs.purpose} is distinct from 'chat'`, sql`(${runs.outcome} like 'error:%' or ${runs.outcome} like 'lost:%' or ${runs.outcome} = 'interrupted')`));
    return {
      runnerConnected: runner ? opts.isConnected(runner.id) : null,
      liveRuns: live.length,
      liveInCheckLine: inLine,
      holds,
      badEnds: bad.map((b) => b.outcome ?? "").filter(Boolean),
    };
  }

  /**
   * Whether a card may be raised for the company now: none open, and none a person answered in the
   * last NO_PROGRESS_QUIET_MS (they've seen it; a fresh card each hour would only nag). A card Boss Man
   * closed itself (the company ran cleanly) doesn't hold the next one back. Returns the last card's
   * time, so trigger B only counts failures after it.
   */
  async function mayRaise(companyId: string, t: Date): Promise<{ ok: boolean; after: Date | null }> {
    const [last] = await db
      .select({ status: decisions.status, createdAt: decisions.createdAt, answeredAt: decisions.answeredAt, context: decisions.context })
      .from(decisions)
      .where(and(eq(decisions.companyId, companyId), sql`${decisions.context}->>'noProgressFor' = ${companyId}`))
      .orderBy(desc(decisions.createdAt))
      .limit(1);
    if (!last) return { ok: true, after: null };
    if (last.status === "open") return { ok: false, after: last.createdAt };
    const bySystem = (last.context as { withdrawn?: { by?: string } }).withdrawn?.by === "system";
    if (!bySystem && last.answeredAt && t.getTime() - last.answeredAt.getTime() < NO_PROGRESS_QUIET_MS) return { ok: false, after: last.createdAt };
    return { ok: true, after: last.createdAt };
  }

  async function raise(companyId: string, companyName: string, home: string | null, headline: string, cause: NoProgressCause) {
    const key = `no-progress:${companyId}`;
    // A card a person answered keeps its key; free it so the next raise isn't swallowed by the unique index.
    await db.update(decisions).set({ dedupeKey: null }).where(and(eq(decisions.dedupeKey, key), ne(decisions.status, "open")));
    const question = `${companyName} is making no progress: ${headline}. Likely cause: ${cause.text}.${cause.platform ? ` This is on Boss Man's side (${PLATFORM_LABEL[cause.platform]}), so Boss Man's own CEO has been told too.` : ""} The card closes by itself once a run there finishes cleanly.`;
    // Starts with the CEO: the Scrum Master can't free run slots or fix a runner. It may reach the owner:
    // a company that has stopped usually can't run its CEO either, which is how HolidayHours went two days unseen.
    const raised = await opts.alert({
      companyId,
      kind: "no_progress",
      question,
      from: "ceo",
      why: "a whole company has stopped",
      dedupeKey: key,
      clearWhen: [{ kind: "companyRanOk", companyId }],
      context: { type: "question", noProgressFor: companyId, cause: cause.text, platform: cause.platform || null },
    });
    if (!raised) return 0;
    let n = 1;
    if (cause.platform && home && home !== companyId) {
      const homeKey = `no-progress:${home}:for:${companyId}`;
      await db.update(decisions).set({ dedupeKey: null }).where(and(eq(decisions.dedupeKey, homeKey), ne(decisions.status, "open")));
      const copy = await opts.alert({
        companyId: home,
        kind: "no_progress",
        question: `Another company, ${companyName}, is making no progress because of ${PLATFORM_LABEL[cause.platform]}: ${headline}. Likely cause: ${cause.text}. Its own CEO has the same card; this one closes once a run there finishes cleanly.`,
        from: "ceo",
        why: "a platform-side cause stops another company",
        dedupeKey: homeKey,
        clearWhen: [{ kind: "companyRanOk", companyId }],
        context: { type: "question", noProgressFor: `platform:${companyId}`, cause: cause.text, platform: cause.platform },
      });
      if (copy) n++;
    }
    return n;
  }

  return {
    async run(t: Date): Promise<{ raised: number }> {
      const [paused] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "paused"));
      if (paused?.value === true) return { raised: 0 };
      const since = new Date(t.getTime() - NO_PROGRESS_AFTER_MS);
      const home = await homeCompany();
      const live = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.paused, false));
      if (!live.length) return { raised: 0 };
      const ids = live.map((c) => c.id);

      // Work waiting on Boss Man: queued, or deferred and due (or held by the usage limit), for an agent who can run.
      const waiting = await db
        .select({ companyId: wakes.companyId, statusReason: wakes.statusReason, createdAt: wakes.createdAt })
        .from(wakes)
        .innerJoin(agents, eq(agents.id, wakes.agentId))
        .where(
          and(
            inArray(wakes.companyId, ids),
            eq(agents.paused, false),
            isNull(agents.retiredAt),
            or(eq(wakes.status, "queued"), and(eq(wakes.status, "deferred"), or(isNull(wakes.notBefore), lte(wakes.notBefore, t), sql`${wakes.statusReason} like 'subscription %'`))),
            or(isNull(wakes.statusReason), notInArray(wakes.statusReason, DELIBERATE_HOLDS)),
          ),
        );
      const progressed = new Set(
        (
          await db
            .selectDistinct({ companyId: runs.companyId })
            .from(runs)
            .where(and(inArray(runs.companyId, ids), gte(runs.endedAt, since), sql`${runs.purpose} is distinct from 'chat'`, cleanEndSql))
        ).map((r) => r.companyId),
      );
      const sameError = await db
        .select({ companyId: failureSignatures.companyId, signature: failureSignatures.signature, n: sql<number>`count(*)::int`, agents: sql<number>`count(distinct ${failureSignatures.agentId})::int`, sample: sql<string>`max(${failureSignatures.sample})` })
        .from(failureSignatures)
        .where(and(inArray(failureSignatures.companyId, ids), gt(failureSignatures.createdAt, since)))
        .groupBy(failureSignatures.companyId, failureSignatures.signature);

      let raised = 0;
      for (const c of live) {
        const mine = waiting.filter((w) => w.companyId === c.id);
        const oldest = mine.reduce<Date | null>((m, w) => (!m || w.createdAt < m ? w.createdAt : m), null);
        const stuck = !progressed.has(c.id) && !!oldest && oldest <= since;
        const repeats = sameError.filter((s) => s.companyId === c.id && s.n >= SAME_ERROR_FAILURES && s.agents >= SAME_ERROR_AGENTS);
        if (!stuck && !repeats.length) continue;
        const gate = await mayRaise(c.id, t);
        if (!gate.ok) continue;
        if (stuck) {
          const cause = likelyCause(await facts(c.id, since, mine.map((w) => w.statusReason)));
          const mins = Math.floor((t.getTime() - oldest!.getTime()) / 60_000);
          const waited = mins >= 120 ? `${Math.floor(mins / 60)} hours` : `${mins} minutes`;
          raised += await raise(c.id, c.name, home, `${mine.length} wake${mine.length === 1 ? " has" : "s have"} waited up to ${waited} and no run there has finished cleanly in the last hour`, cause);
          continue;
        }
        // Trigger B counts only failures since the last card, so a card that closed doesn't re-raise on the same three.
        const [hit] = gate.after ? await recountAfter(c.id, gate.after, since) : repeats;
        if (!hit) continue;
        const f = await facts(c.id, since, mine.map((w) => w.statusReason));
        // Name the repeated error first: it is the evidence; the other facts may add a platform cause.
        const cause = likelyCause({ ...f, badEnds: [hit.sample, ...f.badEnds.filter((o) => o !== hit.sample)] });
        const named = cause.text.includes(short(hit.sample)) ? cause : { ...cause, text: `${cause.text}; the repeated error is "${short(hit.sample)}"` };
        raised += await raise(c.id, c.name, home, `the same failure came back ${hit.n} times in the last hour, for ${hit.agents} different agents`, named);
      }
      return { raised };

      async function recountAfter(companyId: string, after: Date, windowStart: Date) {
        const from = after > windowStart ? after : windowStart;
        const rows = await db
          .select({ signature: failureSignatures.signature, n: sql<number>`count(*)::int`, agents: sql<number>`count(distinct ${failureSignatures.agentId})::int`, sample: sql<string>`max(${failureSignatures.sample})` })
          .from(failureSignatures)
          .where(and(eq(failureSignatures.companyId, companyId), gt(failureSignatures.createdAt, from)))
          .groupBy(failureSignatures.signature);
        return rows.filter((r) => r.n >= SAME_ERROR_FAILURES && r.agents >= SAME_ERROR_AGENTS);
      }
    },
  };
}
