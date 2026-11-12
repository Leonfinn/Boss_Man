// Wake the Release Manager whenever the live commit changes (BOS-284). Most releases go live through
// the blue/green deployer, "Deploy latest" or a hand-apply, with no Release Manager ticket, so nothing
// woke it and its Releases page fell behind. The server watches the live commit it already knows (the
// host deployer's status.json, and the commit this process was built from) and queues a wake on a
// small no-code ticket, so the work is visible and isn't dropped by the ticketless-wake cap (BOS-272).
import { and, asc, desc, eq, inArray, isNull, like, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, decisions, projects, settings, ticketMessages, tickets, wakes } from "../db/schema.js";
import { OWNER_SETUP_FIX_PREFIX, raiseOwnerSetup, withdrawOwnerSetup } from "./decisions.js";
import type { OwnerSetupFacts } from "./owner-setup-check.js";
import type { NotifyInput } from "./notifications.js";
import { isRunnerOnlyStep, mergeCommitOrder, splitSteps, stepKey } from "./runner-image.js";
import { moveTicket } from "./ticket-moves.js";

/** The Release Manager's wake reason. */
export const RELEASE_REASON = "live release";
const SEEN_PREFIX = "live_release:";
const LOG_TITLE_PREFIX = "Release log: record ";
const RELEASES_PROJECT = "Releases";

/** How a new live commit went live, in plain words, for the wake note. */
export type ReleaseHow = "deployed" | "deployed-bluegreen" | "switched-back" | "rolled-back" | "restarted";

const HOW_WORDS: Record<ReleaseHow, string> = {
  deployed: "the host deployer",
  "deployed-bluegreen": "a blue/green switch",
  "switched-back": "a blue/green switch-back",
  "rolled-back": "a rollback",
  restarted: "a restart after a hand-apply",
};


/**
 * What a ticket's setup steps ask the owner to do, minus the runner-update-only ones (BOS-741), each keyed by
 * its normalised text so identical steps from different tickets group. The ordered map keeps the author's order.
 */
function setupStepsOf(steps: string[]) {
  // shortcut: built fresh for each pass and thrown away, so it never outlives a call.
  const unique = new Map<string, string>();
  for (const step of steps) if (!isRunnerOnlyStep(step)) unique.set(stepKey(step), step);
  return unique;
}

/** A live ticket and the owner steps it still needs after the runner-update-only ones are taken out (BOS-741). */
type SetupTicket = { id: string; title: string; steps: Map<string, string>; decisionId: string | null; mergeCommit: string; /** The CEO's lintOverride for these steps (DR-052). */ override: string | null };

const short = (sha: string) => sha.slice(0, 8);
const isSha = (sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);

/** What each company's last pass recorded: the commit before `pending` and the one being reconciled. */
type Seen = { old?: string; new?: string; ticketId?: string | null };

/**
 * How each deployer result names what went live. A switch-back and a rollback both end on the older
 * commit, so `to_commit` is the live one and `from_commit` the one that was live just before.
 */
const TO_LIVE: Record<string, ReleaseHow> = {
  deployed: "deployed",
  rolled_back: "rolled-back",
};

export const releaseLogService = (
  db: Db,
  deps: {
    /** Creates the ticket on the company's board (work.createTicket), returning the full row. */
    createTicket: (projectId: string, input: { title: string; body: string; assigneeAgentId: string; state: "ready"; noCode: true; risk: "trivial" }) => Promise<{ id: string; title: string }>;
    /** Queues the wake on that ticket (scheduler.notify). */
    notify: (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<{ status?: string; statusReason?: string | null } & Record<string, unknown>>;
    /** Marks a folded-in release-log ticket done through the normal ticket path (BOS-1112); without it the row is set done directly. */
    closeTicket?: (ticketId: string) => Promise<unknown>;
    /** Tells the owner when a setup card Boss Man closes itself leaves its notice (BOS-740). */
    notifyOwner?: (n: NotifyInput) => Promise<unknown>;
    /** Runs on every pass for each company, after the live commit is noted: lets after-merge checks that waited for go-live start (BOS-1021). */
    afterLive?: (companyId: string) => Promise<unknown>;
    /** The host facts a go-live setup card is filled from and checked against (DR-052); without it, every host token
     * becomes its plain label and the lint runs without host facts. */
    ownerSetupFacts?: () => Promise<OwnerSetupFacts>;
    log?: (msg: string) => void;
  },
) => {
  const log = deps.log ?? (() => {});
  // shortcut: one pass at a time, so two observations of the same change can't both open a ticket.
  let busy = false;

  /** The company's live Release Manager: the template it was hired from, else its title, else its name. */
  async function releaseManagerOf(companyId: string) {
    const team = await db
      .select({ id: agents.id, name: agents.name, title: agents.title, template: agents.template })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt)))
      .orderBy(asc(agents.createdAt));
    return team.find((a) => a.template === "release-manager") ?? team.find((a) => a.title === "Release Manager") ?? team.find((a) => /^release manager$/i.test(a.name.split(" - ")[0]!.trim())) ?? null;
  }

  /** Where the ticket goes: a project called Releases, else the company's newest open project. */
  async function releasesProjectId(companyId: string) {
    const open = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt)))
      .orderBy(desc(projects.createdAt));
    return (open.find((p) => p.name.trim().toLowerCase() === RELEASES_PROJECT.toLowerCase()) ?? open[0])?.id ?? null;
  }

  async function seenOf(companyId: string): Promise<Seen> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, `${SEEN_PREFIX}${companyId}`));
    return (row?.value as Seen | undefined) ?? {};
  }

  async function saveSeen(companyId: string, value: Seen) {
    await db.insert(settings).values({ key: `${SEEN_PREFIX}${companyId}`, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  /**
   * Records that `commit` is what this company's server runs now (or was built from), and says whether
   * that is a change. No ticket and no wake here: `releaseManagerWakes` does both, on the leader.
   * The first observation only records, so installing this never wakes anyone for the commit already live.
   */
  async function noteLiveCommit(companyId: string, commit: string) {
    const next = commit.toLowerCase();
    if (!isSha(next)) return { changed: false };
    const seen = await seenOf(companyId);
    if (seen.new === next) return { changed: false };
    // Another pass reconciled this commit already (seen.old === next): the record is ahead of what
    // this process was built from, so it never rewinds.
    if (seen.new && seen.old === next) return { changed: false };
    if (!seen.new) {
      await saveSeen(companyId, { old: next, new: next });
      return { changed: false };
    }
    await saveSeen(companyId, { old: seen.new, new: next });
    return { changed: true };
  }

  /** Opens the ticket for this company and change, reusing an open one, and queues the wake on it. */
  async function wakeOne(companyId: string, from: string, to: string, how: ReleaseHow, ticketId?: string | null) {
    const rm = await releaseManagerOf(companyId);
    if (!rm) return false;
    const title = `${LOG_TITLE_PREFIX}${short(to)}`;
    let ticket = ticketId ? await db.select({ id: tickets.id, title: tickets.title }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId))).then((r) => r[0] ?? null) : null;
    // BOS-1112: one open release-log ticket per company. A new live commit is added to it rather than
    // opening another, and any others already open are folded into it. Once it is done, the next commit opens a fresh one.
    const openLogs = await db
      .select({ id: tickets.id, title: tickets.title, body: tickets.body })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), ne(tickets.systemState, "done"), like(tickets.title, `${LOG_TITLE_PREFIX}%`)))
      .orderBy(asc(tickets.createdAt));
    const primary = openLogs[0] ?? null;
    if (!ticket || (primary && ticket.id !== primary.id)) ticket = primary ? { id: primary.id, title: primary.title } : ticket;
    if (primary) {
      const lines: string[] = [];
      for (const other of openLogs.slice(1)) {
        const commits = (other.body ?? "").match(/^New commit: ([0-9a-f]{40})$/gim) ?? [];
        for (const c of commits) lines.push(c);
        await db.delete(wakes).where(and(eq(wakes.ticketId, other.id), eq(wakes.agentId, rm.id), inArray(wakes.status, ["queued", "deferred"])));
        if (deps.closeTicket) await deps.closeTicket(other.id);
        else await moveTicket(db, other.id, "done", { outcome: "completed", internal: true, note: "Folded into the open release-log ticket" });
        await db.insert(ticketMessages).values({ companyId, ticketId: primary.id, author: "system", text: `Folded "${other.title}" into this ticket.` });
      }
      const have = new Set((primary.body ?? "").split("\n"));
      const add = [...lines, `New commit: ${to}`].filter((l, i, all) => !have.has(l) && all.indexOf(l) === i);
      if (add.length) {
        await db.update(tickets).set({ body: `${primary.body ?? ""}\n${add.join("\n")}`.trim(), version: sql`${tickets.version} + 1` }).where(eq(tickets.id, primary.id));
        await db.insert(ticketMessages).values({ companyId, ticketId: primary.id, author: "system", text: `The live commit changed from ${short(from)} to ${short(to)}: it went live by ${HOW_WORDS[how]}. Record ${short(to)} too.` });
      }
    }
    // A wake already waiting for this ticket is the one that will run: don't stack a second.
    // Creating the ticket queues its own "assigned" wake, which is reused rather than doubled.
    const note = `The live commit changed from ${short(from)} to ${short(to)}: it went live by ${HOW_WORDS[how]}. Record it in the Releases/Release log, then finish this ticket.`;
    if (!ticket) {
      const projectId = await releasesProjectId(companyId);
      if (!projectId) return false;
      const body = [
        `The live commit changed from ${short(from)} to ${short(to)}, and it went live by ${HOW_WORDS[how]}.`,
        "",
        `Update the Releases/Release log for ${short(to)}: add the entry, say what shipped since ${short(from)}, and say whether the owner has to do anything.`,
        "",
        `Old commit: ${from}`,
        `New commit: ${to}`,
        `This ticket is the wake, not the work: the detail comes from the release notes and the deployer's history.`,
      ].join("\n");
      ticket = await deps.createTicket(projectId, { title, body, assigneeAgentId: rm.id, state: "ready", noCode: true, risk: "trivial" });
    }
    const waitingAll = await db
      .select({ id: wakes.id, reason: wakes.reason })
      .from(wakes)
      .where(and(eq(wakes.ticketId, ticket.id), eq(wakes.agentId, rm.id), inArray(wakes.status, ["queued", "deferred"])));
    const already = waitingAll.find((w) => w.reason === RELEASE_REASON);
    if (already) {
      // A release wake is already waiting: the "assigned" one it was created with is redundant.
      for (const w of waitingAll) if (w.reason === "assigned") await db.delete(wakes).where(eq(wakes.id, w.id));
      return false;
    }
    const assigned = waitingAll.find((w) => w.reason === "assigned");
    if (assigned) {
      await db.update(wakes).set({ reason: RELEASE_REASON, note }).where(eq(wakes.id, assigned.id));
      return true;
    }
    const w = await deps.notify(rm.id, {
      ticketId: ticket.id,
      reason: RELEASE_REASON,
      priority: 2,
      note,
    });
    if (w?.status === "dropped") {
      log(`release log: the wake for ${short(to)} on ticket ${ticket.id} was dropped (${String(w.statusReason ?? "unknown")})`);
      return false;
    }
    return true;
  }

  /**
   * The owner's setup cards (DR-011), run on the same live-commit change as the Release Manager's wake:
   * once the live commit is `to`, every finished ticket whose merge commit is at or before it and that
   * has setup steps but no card yet gets one. A step-back (a switch-back to an older commit) withdraws
   * the cards for tickets merged after it, so they come back on the next go-live. The merge gate merges
   * one ticket at a time and the deployer reports only finished deploys, so merge time is merge order
   * (DR-011 point 4). A human push whose commit is unknown to Boss Man changes nothing here.
   *
   * BOS-741 (DR-039 follow-up 2): tickets going live in the same release that ask for identical steps
   * (after normalising whitespace) share one card that lists them, so one Done clears it for all; a step
   * that only asks for the runner update raises no card of its own, since the runner-update card for the
   * release covers it, and every ticket it was on is named there. Steps that differ keep their own card.
   */
  async function ownerSetupPass(companyId: string, to: string, how: ReleaseHow) {
    const order = await mergeOrder(companyId);
    const liveAt = order.indexOf(to);
    // A rollback lands back on an older commit, so nothing it went past is running. A deploy or a hand-apply
    // that lands on a commit Boss Man doesn't know (a human push) is newer, so nothing here is withdrawn.
    const steppedBack = how === "rolled-back" || how === "switched-back";
    const withSetup = await ticketsWithSetup(companyId);
    let raised = 0;
    let withdrew = 0;
    // The tickets still live here and what the owner has to do for each, after the runner-update-only steps
    // are taken out: those are covered by the runner-update card for the release, not one card each.
    const live: SetupTicket[] = [];
    // Cards to take back, by their id: a card can cover several tickets (BOS-741), so it is withdrawn
    // once and every ticket that pointed at it is cleared, even when only one of them went back.
    const withdrawing = new Set<string>();
    for (const t of withSetup) {
      const at = order.indexOf(t.mergeCommit);
      // Not live any more: a step-back to before its merge (the live commit is an earlier merge, or not a
      // merge at all, so a rollback went back past it). A ticket whose own merge commit Boss Man can't
      // place is left alone rather than guessed at.
      if (at >= 0 && (steppedBack || (liveAt >= 0 && at > liveAt))) {
        if (t.ownerSetupDecisionId) withdrawing.add(t.ownerSetupDecisionId);
        continue;
      }
      // A ticket whose every step is the runner update comes through with no steps: it is named on the
      // runner-update card instead of getting one of its own (BOS-741).
      const steps = setupStepsOf(t.steps);
      live.push({ id: t.id, title: t.title, steps, decisionId: t.ownerSetupDecisionId, mergeCommit: t.mergeCommit, override: t.override });
    }
    // Take back each affected card once, clearing every ticket that pointed at it (BOS-741). A ticket
    // still live here that shared a withdrawn card now has no card, so the grouping below raises one for
    // it again rather than leaving it looking covered by a card that is gone.
    for (const cardId of withdrawing) {
      const covered = await db.select({ id: tickets.id, title: tickets.title }).from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.ownerSetupDecisionId, cardId)));
      const stillLive = covered.filter((x) => live.some((l) => l.id === x.id));
      const whose = stillLive[0] ?? covered[0];
      if (!whose) continue;
      const gone = await withdrawOwnerSetup(db, cardId, covered.map((x) => x.id), `Switched back: "${whose.title}" isn't running any more. You'll get this card again if it goes live once more.`, deps.notifyOwner ? { notify: deps.notifyOwner } : undefined);
      if (!gone) continue;
      withdrew++;
      for (const t of live) if (covered.some((x) => x.id === t.id)) t.decisionId = null;
    }
    // DR-052: the host facts the card's tokens are filled from and the lint checks against, read once per pass.
    const facts = (await deps.ownerSetupFacts?.().catch((err: Error) => { log(`owner setup host facts: ${err.message}`); return undefined; })) ?? {};
    for (const group of setupGroups(live)) {
      // A CEO override covers only the exact steps it was given with, so it counts only from a ticket whose own
      // steps are the card's (a bigger card shared with other tickets carries steps it never saw).
      const same = (t: SetupTicket) => t.steps.size === group.steps.length && group.steps.every((s) => t.steps.has(stepKey(s)));
      const override = group.tickets.find((t) => t.override && same(t))?.override ?? null;
      const card = await raiseOwnerSetup(db, { companyId, tickets: group.tickets.map((t) => ({ ticketId: t.id, title: t.title })), steps: group.steps, commit: to, facts, override });
      if (!card) continue;
      raised++;
      const ids = group.tickets.filter((t) => t.decisionId !== card.id).map((t) => t.id);
      if (ids.length) await db.update(tickets).set({ ownerSetupDecisionId: card.id }).where(inArray(tickets.id, ids));
    }
    if (raised || withdrew) log(`owner setup for company ${companyId}: raised ${raised}, withdrew ${withdrew} (live ${short(to)})`);
    return { raised, withdrew };
  }

  /**
   * The setup cards to raise for the live tickets that have none yet (BOS-741), and the tickets each one
   * covers. Every ticket whose steps are exactly the same shares one card, whatever the merge order, and a
   * ticket whose steps are all on a bigger card is left to that card (its own step is done there too, so
   * nothing is lost). Steps that differ keep their own card, and a ticket an open card already covers rides
   * on that card rather than raising a second.
   */
  function setupGroups(live: SetupTicket[]) {
    const withSteps = live.filter((t) => t.steps.size);
    const signature = (t: SetupTicket) => [...t.steps.keys()].sort().join("\n");
    const bySignature = new Map<string, SetupTicket[]>();
    for (const t of withSteps) bySignature.set(signature(t), [...(bySignature.get(signature(t)) ?? []), t]);
    // Biggest step sets first, so a ticket is left to a card that covers all of its steps when one is there.
    const cards: { steps: Set<string>; tickets: SetupTicket[] }[] = [];
    for (const sig of [...bySignature.keys()].sort((a, b) => b.split("\n").length - a.split("\n").length || a.localeCompare(b))) {
      const steps = new Set(sig.split("\n"));
      const covering = cards.find((c) => c.steps.size > steps.size && [...steps].every((s) => c.steps.has(s)));
      if (covering) covering.tickets.push(...bySignature.get(sig)!);
      else cards.push({ steps, tickets: [...bySignature.get(sig)!] });
    }
    // Only tickets with no card yet get a card now; a group whose tickets all have one is done, and is
    // dropped before its steps are read (a later go-live with earlier tickets still live would otherwise
    // read an empty group and throw, aborting the whole pass so new tickets raised nothing).
    return cards.flatMap((c) => {
      const fresh = c.tickets.filter((t) => !t.decisionId);
      return fresh.length ? [{ tickets: fresh, steps: [...c.steps.values()] }] : [];
    });
  }

  /**
   * This company's merge commits, oldest merge first, from its done tickets. The merge gate sets a
   * ticket's merge commit when it merges it and merges one at a time, so the order of merges is the
   * order of merge times. It includes tickets whose setup card is already raised, so a switch-back can
   * still place them.
   */
  const mergeOrder = (companyId: string) => mergeCommitOrder(db, companyId);

  /** Whether the CEO has an open card to fix a live ticket's setup steps (DR-052). */
  async function hasOpenSetupFix(companyId: string) {
    const [row] = await db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), like(decisions.dedupeKey, `${OWNER_SETUP_FIX_PREFIX}%`)))
      .limit(1);
    return !!row;
  }

  /** Done tickets in this company that carry setup steps and a merge commit, with their card if raised. */
  async function ticketsWithSetup(companyId: string) {
    const rows = await db
      .select({ id: tickets.id, title: tickets.title, ownerSetup: tickets.ownerSetup, ownerSetupOverride: tickets.ownerSetupOverride, mergeCommit: tickets.mergeCommit, ownerSetupDecisionId: tickets.ownerSetupDecisionId })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done")));
    return rows
      .filter((t) => !!t.mergeCommit && !!t.ownerSetup?.trim())
      .map((t) => ({ id: t.id, title: t.title, mergeCommit: t.mergeCommit!, ownerSetupDecisionId: t.ownerSetupDecisionId, steps: splitSteps(t.ownerSetup!), override: t.ownerSetupOverride }));
  }

  return {
    /** Records the live commit it is given (see noteLiveCommit). Nothing else happens until the leader's pass. */
    async note(companyId: string, commit: string) {
      return noteLiveCommit(companyId, commit);
    },

    /**
     * One pass: for every company whose recorded live commit isn't the one noted at its start, wakes
     * the Release Manager on a ticket for the new commit. A company with no Release Manager is left
     * alone (its record still catches up, so a Release Manager hired later isn't woken for old news).
     */
    async releaseManagerWakes(how: ReleaseHow) {
      if (busy) return 0;
      busy = true;
      try {
        const rows = (await db.select().from(settings)).filter((r) => r.key.startsWith(SEEN_PREFIX));
        let woken = 0;
        for (const row of rows) {
          const companyId = row.key.slice(SEEN_PREFIX.length);
          const seen = (row.value as Seen | undefined) ?? {};
          // Checks that waited for go-live start now, whether or not the commit changed on this pass (BOS-1021).
          await deps.afterLive?.(companyId).catch((err: Error) => log(`go-live checks for company ${companyId}: ${err.message}`));
          // DR-052: while the CEO has a card to fix a live ticket's setup steps, retry the owner's card on every pass
          // (same commit, nothing withdrawn), so fixed steps reach the owner without waiting for the next deploy.
          if (isSha(seen.new) && seen.old === seen.new && (await hasOpenSetupFix(companyId))) {
            await ownerSetupPass(companyId, seen.new, "deployed").catch((err: Error) => log(`owner setup retry for company ${companyId}: ${err.message}`));
          }
          if (!isSha(seen.old) || !isSha(seen.new) || seen.old === seen.new) continue;
          // The record moves on whatever happens below, so a retry (or the next pass) can't double the ticket.
          await saveSeen(companyId, { old: seen.new, new: seen.new });
          // The owner's setup cards (DR-011) go on the same change, and don't need a Release Manager.
          try {
            await ownerSetupPass(companyId, seen.new, how);
          } catch (err) {
            log(`owner setup for company ${companyId}: ${(err as Error).message}`);
          }
          try {
            if (await wakeOne(companyId, seen.old, seen.new, how, seen.ticketId)) woken++;
          } catch (err) {
            log(`release log for company ${companyId}: ${(err as Error).message}`);
          }
        }
        return woken;
      } finally {
        busy = false;
      }
    },
  };
};
export type ReleaseLog = ReturnType<typeof releaseLogService>;
