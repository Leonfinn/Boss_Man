// Wake the Release Manager whenever the live commit changes (BOS-284). Most releases go live through
// the blue/green deployer, "Deploy latest" or a hand-apply, with no Release Manager ticket, so nothing
// woke it and its Releases page fell behind. The server watches the live commit it already knows (the
// host deployer's status.json, and the commit this process was built from) and queues a wake on a
// small no-code ticket, so the work is visible and isn't dropped by the ticketless-wake cap (BOS-272).
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, projects, settings, tickets, wakes } from "../db/schema.js";

/** The Release Manager's wake reason. */
export const RELEASE_REASON = "live release";
const SEEN_PREFIX = "live_release:";
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
    /** Creates the ticket on the company's board (work.createTicket). */
    createTicket: (projectId: string, input: { title: string; body: string; assigneeAgentId: string; state: "ready"; noCode: true; risk: "trivial" }) => Promise<{ id: string }>;
    /** Queues the wake on that ticket (scheduler.notify). */
    notify: (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<{ status?: string; statusReason?: string | null } & Record<string, unknown>>;
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
    const title = `Release log: record ${short(to)}`;
    let ticket = ticketId ? await db.select({ id: tickets.id, title: tickets.title }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId))).then((r) => r[0] ?? null) : null;
    if (!ticket) {
      const open = await db
        .select({ id: tickets.id, title: tickets.title })
        .from(tickets)
        .where(and(eq(tickets.companyId, companyId), ne(tickets.systemState, "done")))
        .orderBy(desc(tickets.createdAt));
      ticket = open.find((t) => t.title === title) ?? null;
    }
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
    // A wake already waiting for this ticket is the one that will run: don't stack a second.
    const [waiting] = await db
      .select({ id: wakes.id, reason: wakes.reason })
      .from(wakes)
      .where(and(eq(wakes.ticketId, ticket.id), eq(wakes.agentId, rm.id), inArray(wakes.status, ["queued", "deferred"])))
      .limit(1);
    const note = `The live commit changed from ${short(from)} to ${short(to)}: it went live by ${HOW_WORDS[how]}. Record it in the Releases/Release log, then finish this ticket.`;
    if (waiting) {
      // Creating the ticket queued its own "assigned" wake: make that one carry the release news.
      if (waiting.reason !== "assigned") return false;
      await db.update(wakes).set({ reason: RELEASE_REASON, note }).where(eq(wakes.id, waiting.id));
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
          if (!isSha(seen.old) || !isSha(seen.new) || seen.old === seen.new) continue;
          // The record moves on whatever happens below, so a retry (or the next pass) can't double the ticket.
          await saveSeen(companyId, { old: seen.new, new: seen.new });
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
