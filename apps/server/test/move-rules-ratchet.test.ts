// DR-061 ratchet, Q1 ("has this blocker finished?"): new code must not read the dependency and ticket state
// data for "finished" by itself. A file that joins ticket_dependencies to its blocker ticket must either use the
// canonical answer (ticketBlockerFinished, openBlockers or the SQL twin ticketBlockerOpenSql from
// services/ticket-links.ts) or be one of the known copies below. The allowlist may only shrink: when you fold a
// copy onto the canonical answer, delete its line here (the test fails if the count drops, so you can't forget).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
const CANONICAL = "services/ticket-links.ts";

/** A join from the dependency row to its blocker ticket, in query-builder or raw SQL form. */
const JOIN_RE = /(?:left|inner)Join\(tickets, eq\(tickets\.id, ticketDependencies\.blockerTicketId\)\)|join tickets \w+ on \w+\.id = \w+\.blocker_ticket_id/g;
const CANONICAL_RE = /ticketBlockerFinished|openBlockers|ticketBlockerOpenSql|ticketInForce/;

/** Joins that do not decide "finished" (display, ordering, a fingerprint, a note about what finished) or that already use the canonical answer. */
const KNOWN_JOINS: Record<string, number> = {
  "mcp-tickets.ts": 1, // reads only the blockers' numbers for a title warning
  "services/brief.ts": 1, // uses ticketBlockerFinished
  "services/decisions.ts": 3, // unblockedNote text; dependent-chain ordering SQL (order only)
  "services/planning.ts": 0,
  "services/priority-watch.ts": 1, // uses ticketBlockerFinished
  "services/scheduler.ts": 4, // stoppedTree uses ticketBlockerFinished; the watch report lines, fingerprint and parked-note time only describe
  "services/sweeps.ts": 2, // release sweep: one uses ticketBlockerOpenSql, one reads the finish time
  "services/watchdog.ts": 1, // uses ticketBlockerFinished
  "services/agent-wip.ts": 1, // uses ticketBlockerOpenSql
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("move rules ratchet: Q5 is this change live", () => {
  it("there is one merge order (allMergeOrder) and callers ask commitIsLive: no done-only mergeCommitOrder, no raw imageContains outside the go-live and runner-image modules", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f).split("\\").join("/");
      const text = readFileSync(f, "utf8");
      if (/mergeCommitOrder/.test(text)) offenders.push(`${rel}: mergeCommitOrder`);
      if (!["services/go-live-wait.ts", "services/runner-image.ts"].includes(rel) && /\bimageContains\(/.test(text)) offenders.push(`${rel}: imageContains`);
    }
    expect(offenders, "ask commitIsLive(db, companyId, commit, side) in services/go-live-wait.ts").toEqual([]);
  });
});

describe("move rules ratchet: Q1 has this blocker finished", () => {
  const found = new Map<string, { joins: number; canonical: boolean }>();
  for (const f of files(SRC)) {
    const rel = relative(SRC, f).split("\\").join("/");
    if (rel === CANONICAL) continue;
    const text = readFileSync(f, "utf8");
    const joins = text.match(JOIN_RE)?.length ?? 0;
    if (joins) found.set(rel, { joins, canonical: CANONICAL_RE.test(text) });
  }

  it("no file joins the blocker ticket without being on the known list", () => {
    const unknown = [...found.keys()].filter((k) => !(k in KNOWN_JOINS));
    expect(unknown, `read "finished" through openBlockers / ticketBlockerFinished (services/ticket-links.ts), or justify the join here`).toEqual([]);
  });

  it("known files do not gain joins, and the list shrinks as copies are removed", () => {
    for (const [file, allowed] of Object.entries(KNOWN_JOINS)) {
      expect(found.get(file)?.joins ?? 0, file).toBe(allowed);
    }
  });

  it("every file that joins the blocker ticket uses the canonical answer or is a display-only copy", () => {
    const displayOnly = new Set(["mcp-tickets.ts"]);
    const bad = [...found].filter(([k, v]) => !v.canonical && !displayOnly.has(k)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  // Q3 ("is this agent busy?", DR-061 / BOS-1534): the busy rule lives in services/agent-wip.ts.
  it("Q3: nobody re-spells the busy rule or reads the hold by truthiness", () => {
    const wipFile = "services/agent-wip.ts";
    const rel = (f: string) => relative(SRC, f).split("\\").join("/");
    const all = files(SRC).map((f) => ({ rel: rel(f), text: readFileSync(f, "utf8") }));
    // No private "busy agents" function: ask agentBusy / busyAgentIds (the queued-wake spelling is used elsewhere for wake handling, so it is not matched).
    const privateBusy = all.filter((f) => f.rel !== wipFile && /(?:async function|const) busyAgents\s*(?:=\s*(?:async\s*)?\(\)\s*=>\s*\{|\()/.test(f.text)).map((f) => f.rel);
    expect(privateBusy, "ask agentBusy / busyAgentIds (services/agent-wip.ts)").toEqual([]);
    // The old name for "the ticket to carry on with" included tickets nobody can work on.
    expect(all.filter((f) => /\boldestInProgress\b/.test(f.text)).map((f) => f.rel)).toEqual([]);
    // Start gates ask holdBlocksStarts; a drain past its deadline must not freeze the sweeps.
    const gates = ["services/sweeps.ts", "services/scheduler.ts", "services/watchdog.ts"];
    const truthy = all.filter((f) => gates.includes(f.rel) && /\(await getHold\(db\)\)\s*(\)|return|\|\|)|if \(await getHold\(db\)\)/.test(f.text)).map((f) => f.rel);
    expect(truthy).toEqual([]);
  });

  it("no one re-spells the finished test outside the canonical module", () => {
    // The old spelling: a blocker ticket "not done" with an until-merged exception, written out by hand in SQL.
    const re = /system_state <> 'done' and not \(\w+\.until = 'merged'/;
    const offenders = files(SRC)
      .filter((f) => relative(SRC, f).split("\\").join("/") !== CANONICAL)
      .filter((f) => re.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
