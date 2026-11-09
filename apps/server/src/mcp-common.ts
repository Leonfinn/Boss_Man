// Small helpers every MCP tool file shares (BOS-298 step 15): kept here so the tool files split out of
// mcp.ts import them without importing mcp.ts back.

import { eq } from "drizzle-orm";
import { stateNoteLine, ticketRef } from "@boss-man/shared";
import type { Db } from "./db/client.js";
import { agents, companies } from "./db/schema.js";

export type Scope = { companyId: string; agentId: string | null; runId: string };

/** Shows a company's ticket numbers as references (HOL-12). */
export async function refsOf(db: Db, companyId: string) {
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
  return <T extends { number: number | null }>({ number, ...r }: T) => ({ ref: ticketRef(c?.prefix, number), ...r });
}

export const withNote = <T extends { stateNote: string | null; stateNoteAt: Date | null; lastActivityAt: Date; stateNoteStaleAt?: Date | null }>({ stateNote, stateNoteAt, stateNoteStaleAt, ...r }: T) => {
  const note = stateNoteLine({ stateNote, stateNoteAt, stateNoteStaleAt, lastActivityAt: r.lastActivityAt }, new Date());
  return note ? { ...r, stateNote: note } : r;
};

export async function managerIn(db: Db, scope: Scope) {
  const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
  return me?.role === "ceo" || me?.role === "manager";
}

export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** A lossless cap: at most n chars of s from offset; when there's more, says how much and how to get it. */
export const cut = (s: string, n: number, how: (next: number) => string, offset = 0) =>
  s.length <= offset + n ? s.slice(offset) : `${s.slice(offset, offset + n)}\n\n… ${s.length - offset - n} more chars; ${how(offset + n)}`;
export const CAP = 40_000;
