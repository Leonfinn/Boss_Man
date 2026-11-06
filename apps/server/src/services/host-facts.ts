// Host facts (BOS-427, extends DR-008 Q2): what each host says about itself, read from the record the host
// deployer writes on every tick (outbox/host.json). Today that is the owner's login account there and the
// ownership (owner, group, mode) of the folders it knows, read with `stat` and never their contents.
//
// The server never runs anything on the host. A missing or half-written file (an older deployer, or a host
// that hasn't ticked yet) reads as "no facts", and the card lint then only checks that a block names a host
// and an account, never that a guess about permissions is right.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HostFacts, Ownership } from "./steps.js";

/** One folder's ownership as the host recorded it. Read with `stat` only: owner and group are names, mode is octal. */
const OwnershipRow = z.object({
  path: z.string().regex(/^\//),
  owner: z.string().min(1),
  group: z.string().min(1),
  mode: z.string().regex(/^[0-7]{3,4}$/),
});

/** The record the host deployer writes: its own name, the owner's login there, and what it knows about its folders. */
const HostRecord = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(64),
  writtenAt: z.string(),
  /** The account the owner logs in as, when the deployer can tell; absent if it can't. Never "root". */
  login: z.string().min(1).max(64).optional(),
  ownership: z.array(OwnershipRow).default([]),
});
export type HostRecord = z.infer<typeof HostRecord>;

/** The recorded hosts a card may name, for the lint (`lintOwnerSteps`). Falls back to an empty list. */
export function hostFactsService(deps: { dir?: string; log?: (msg: string) => void }) {
  /** Read the host's own record; null when there is none (an older deployer) or it is unreadable. */
  async function read(): Promise<HostRecord | null> {
    if (!deps.dir) return null;
    try {
      const raw = await readFile(path.join(deps.dir, "outbox", "host.json"), "utf8");
      return HostRecord.parse(JSON.parse(raw));
    } catch {
      return null; // missing, half-written or from a newer deployer: treated as "no facts"
    }
  }

  /** The facts the card lint uses, in the shape steps.ts expects. */
  async function hosts(): Promise<HostFacts[]> {
    const r = await read();
    if (!r) return [];
    const ownership: Ownership[] = r.ownership;
    return [{ name: r.name, ...(r.login ? { login: r.login } : {}), ownership }];
  }

  return { read, hosts };
}
