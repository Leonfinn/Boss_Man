// One insert per change, read back by the brief (R83). The actor is the agent, or null for the owner or Boss Man.
import type { Db } from "../db/client.js";
import { activity } from "../db/schema.js";

export const record = (db: Db, row: { companyId: string; kind: string; summary: string; agentId?: string | null; ticketId?: string | null; at?: Date }) =>
  db.insert(activity).values({ ...row, summary: row.summary.replace(/\s+/g, " ").trim().slice(0, 300) });
