// The owner's list of real private details the merge-line scan must keep out of the repo (BOS-979): real IPs, host names,
// NAS/host paths, personal email. Stored encrypted with the master key (like a secret), never in the repo, never returned by
// the API after saving (only a count per kind), never logged. The merge gate hands it to the runner with the check job.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { decryptSecret, encryptSecret, type MasterKey } from "../crypto.js";

const KEY = "private_details";
export const PRIVATE_DETAIL_KINDS = ["ip", "host", "path", "email", "other"] as const;
export type PrivateDetailKind = (typeof PRIVATE_DETAIL_KINDS)[number];
export const MAX_ENTRIES = 200;
export const MAX_ENTRY_LENGTH = 200;

export class PrivateDetailsRejected extends Error {}

type Stored = { ciphertext: string; wrappedKey: string; masterKeyVersion: number; counts: Record<string, number> };

/** One entry per line, "kind: value" or just a value (kind guessed). Blank lines and # comments are dropped. */
export function parsePrivateDetails(text: string): { kind: PrivateDetailKind; value: string }[] {
  const out: { kind: PrivateDetailKind; value: string }[] = [];
  // A per-call local (not state): this note is for the in-memory-state lint, which also matches 2-space indented locals.
  // lost on restart, harmless because it lives for one call
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(ip|host|path|email|other)\s*[:=]\s*(.+)$/i.exec(line);
    const value = (m ? m[2]! : line).trim();
    const kind: PrivateDetailKind = m
      ? (m[1]!.toLowerCase() as PrivateDetailKind)
      : /^[^\s@]+@[^\s@]+$/.test(value) ? "email"
      : /^\d{1,3}(\.\d{1,3}){0,3}(\/\d{1,2})?\.?$/.test(value) ? "ip"
      : value.startsWith("/") ? "path"
      : "other";
    if (value.length < 3) throw new PrivateDetailsRejected(`An entry is too short to be safe to match (${kind}): use at least 3 characters.`);
    if (value.length > MAX_ENTRY_LENGTH) throw new PrivateDetailsRejected(`An entry is longer than ${MAX_ENTRY_LENGTH} characters.`);
    if (/[\t\0]/.test(value)) throw new PrivateDetailsRejected("An entry has a tab or control character in it.");
    const id = `${kind}\t${value.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind, value });
  }
  if (out.length > MAX_ENTRIES) throw new PrivateDetailsRejected(`At most ${MAX_ENTRIES} entries.`);
  return out;
}

export function privateDetailsService(db: Db, master: MasterKey) {
  const read = async (): Promise<Stored | null> => {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY));
    return (row?.value as Stored | undefined) ?? null;
  };
  return {
    /** Only how many entries of each kind: the values are never returned. */
    async summary(): Promise<{ total: number; counts: Record<string, number> }> {
      const s = await read();
      const counts = s?.counts ?? {};
      return { total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
    },

    /** Replaces the whole list. An empty text clears it. */
    async save(text: string): Promise<{ total: number; counts: Record<string, number> }> {
      const entries = parsePrivateDetails(text);
      if (!entries.length) {
        await db.delete(settings).where(eq(settings.key, KEY));
        return { total: 0, counts: {} };
      }
      const counts: Record<string, number> = {};
      for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      const value: Stored = { ...encryptSecret(master, entries.map((e) => `${e.kind}\t${e.value}`).join("\n")), counts };
      await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return { total: entries.length, counts };
    },

    /** For the runner only: the list as "kind<TAB>value" lines, or null when none is set. */
    async forRunner(): Promise<string | null> {
      const s = await read();
      return s ? decryptSecret(master, s) : null;
    },

    /** Whether a list is saved at all, without decrypting it (BOS-1093): tells a read failure from an empty list. */
    async isSet(): Promise<boolean> {
      return (await read()) !== null;
    },
  };
}
