import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// BOS-922 ratchet (DR-047 point 6): a ticket's state is written in one place, ticket-moves.ts. Any other
// file that sets systemState in an update(tickets) skips the column, the WIP count and the history line.
// The inserts in createTicket and company import are the only listed exceptions (they are inserts, not updates).
const SRC = join(__dirname, "..", "src");
const ALLOWED = new Set(["services/ticket-moves.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** The text of each `update(tickets)` statement's .set(...) argument, found by matching brackets. */
export function ticketUpdateSets(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\.update\(tickets\)/g)) {
    const at = src.indexOf(".set(", m.index);
    if (at < 0 || at - m.index! > 80) continue;
    let depth = 0;
    let i = at + 4;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    out.push(src.slice(at, i + 1));
  }
  return out;
}

const writesState = (set: string) => /\bsystemState\b/.test(set);

describe("only ticket-moves.ts writes a ticket's state", () => {
  it("the scanner sees a state write and ignores other fields", () => {
    expect(ticketUpdateSets(`await db.update(tickets).set({ systemState: "ready", a: f(1) }).where(x)`).some(writesState)).toBe(true);
    expect(ticketUpdateSets(`await db\n .update(tickets)\n .set({ plan: 1 })\n .where(eq(tickets.systemState, "a"))`).some(writesState)).toBe(false);
  });

  it("no other file sets systemState in an update(tickets)", () => {
    const offenders = files(SRC)
      .filter((f) => !ALLOWED.has(f.slice(SRC.length + 1)))
      .filter((f) => ticketUpdateSets(readFileSync(f, "utf8")).some(writesState))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
