// Host facts (BOS-427, extends DR-008 Q2): what each host says about itself, read from the record the host
// deployer writes on every tick (outbox/host.json). Today that is the owner's login account there and the
// ownership (owner, group, mode) of the folders it knows, read with `stat` and never their contents. Each
// folder also names its role (BOS-541: install, deployer, backups, data, secrets), so R6 treats backups as
// private by what the host says they are, not by what their name looks like.
//
// The server never runs anything on the host. A missing or half-written file (an older deployer, or a host
// that hasn't ticked yet) reads as "no facts", and the card lint then only checks that a block names a host
// and an account, never that a guess about permissions is right.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { HostFacts, Ownership } from "./steps.js";
import { FOLDER_ROLES } from "./steps.js";

/** One folder's ownership as the host recorded it. Read with `stat` only: owner and group are names, mode is octal.
 * `roles` says what the host uses the folder for (BOS-541); folded to a single `role` below, which is what R6
 * reads. An older deployer that writes no role still gets a record, just one R6 treats by name as before. */
const OwnershipRow = z.object({
  path: z.string().regex(/^\//),
  owner: z.string().min(1),
  group: z.string().min(1),
  mode: z.string().regex(/^[0-7]{3,4}$/),
  role: z.enum(FOLDER_ROLES).optional(),
  roles: z.array(z.enum(FOLDER_ROLES)).optional(),
});

/** The record the host deployer writes: its own name, the owner's login there, and what it knows about its folders. */
const HostRecord = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(64),
  writtenAt: z.string(),
  /** The account the owner logs in as, when the deployer can tell; absent if it can't. Never "root". */
  login: z.string().min(1).max(64).optional(),
  ownership: z.array(OwnershipRow).default([]),
  // BOS-419 (DR-008, DR-023, DR-024): more allowlisted facts. Every section is optional (an older deployer writes
  // none), and each is parsed loosely: a section in the wrong shape reads as absent, never as "no record at all".
  repo: z.object({ origin: z.string(), originHost: z.string().default(""), embeddedCredentials: z.boolean().default(false), probe: z.string(), probedAt: z.string().default("") }).optional().catch(undefined),
  paths: z.object({ install: z.string(), src: z.string(), deployer: z.string() }).optional().catch(undefined),
  compose: z.object({ files: z.array(z.string()).default([]), bluegreen: z.boolean().default(false), liveColour: z.string().default("") }).optional().catch(undefined),
  network: z.object({ addresses: z.array(z.string()).default([]), ports: z.record(z.string(), z.string()).default({}) }).optional().catch(undefined),
  /** The ntfy add-on's own https address (NTFY_BASE_URL), the one the phone app subscribes at. Absent: not reported. */
  ntfy: z.object({
    baseUrl: z.string().regex(/^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?(\/[A-Za-z0-9._~/-]{0,100})?$/).optional().catch(undefined),
    /** The ntfy container's name on the host, for `docker exec`. */
    container: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional().catch(undefined),
  }).optional().catch(undefined),
  memory: z.object({ totalKb: z.number().int().nonnegative(), availableKb: z.number().int().nonnegative() }).optional().catch(undefined),
  addons: z.record(z.string(), z.string()).optional().catch(undefined),
  checks: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()]))).optional().catch(undefined),
  /** BOS-770: each BOSSMAN_NETGUARD_ALLOW line in .env, in file order, as its host:port entries (Compose uses only the last). */
  netguardEnv: z.object({ envFound: z.boolean().default(true), lines: z.array(z.array(z.string().regex(/^[A-Za-z0-9.-]{1,253}:\d{1,5}$/)).max(100)).max(16) }).optional().catch(undefined),
});
export type HostRecord = z.infer<typeof HostRecord>;

/** One fact on the settings record: its value, where it came from, and a conflict when the host and the owner disagree. */
export type HostFact = {
  value: string;
  /** "host" = the deployer reported it; "owner" = the owner confirmed it because the host can't detect it. */
  source: "host" | "owner";
  /** When the host last reported it, or when the owner confirmed it. */
  at: string;
  /** Set when the owner confirmed a value and the host later reported a different one; the host's value wins. */
  conflict?: { confirmed: string; reported: string };
};
export type HostFactsRecord = { facts: Record<string, HostFact>; hostName: string | null; reportedAt: string | null };

export const HOST_FACTS_KEY = "host_facts";
/** Facts only the owner can give (the host can't see them). Anything else the host reports can't be overridden. */
export const OWNER_FACTS = ["network.publicAddress", "repo.deployKeyAdded"] as const;
/** A report older than this is not used to merge add-on states (the deployer ticks every minute). */
export const HOST_REPORT_FRESH_MS = 30 * 60_000;

const csv = (a: string[]) => a.join(",");
/** The host's record flattened into dotted keys with string values. Only allowlisted fields exist in the record,
 * so only allowlisted keys come out; a value is never longer than a short string. */
export function flattenHostRecord(r: HostRecord): Record<string, string> {
  const o: Record<string, string> = {};
  if (r.repo) {
    o["repo.origin"] = r.repo.origin; o["repo.originHost"] = r.repo.originHost; o["repo.probe"] = r.repo.probe;
    o["repo.embeddedCredentials"] = String(r.repo.embeddedCredentials);
  }
  if (r.paths) { o["paths.install"] = r.paths.install; o["paths.src"] = r.paths.src; o["paths.deployer"] = r.paths.deployer; }
  if (r.compose) { o["compose.files"] = csv(r.compose.files); o["compose.bluegreen"] = String(r.compose.bluegreen); o["compose.liveColour"] = r.compose.liveColour; }
  if (r.network) {
    o["network.addresses"] = csv(r.network.addresses);
    for (const [k, v] of Object.entries(r.network.ports)) o[`network.port.${k}`] = v;
  }
  if (r.ntfy?.baseUrl) o["ntfy.baseUrl"] = r.ntfy.baseUrl;
  if (r.ntfy?.container) o["ntfy.container"] = r.ntfy.container;
  if (r.memory) { o["memory.totalKb"] = String(r.memory.totalKb); o["memory.availableKb"] = String(r.memory.availableKb); }
  for (const [k, v] of Object.entries(r.addons ?? {})) o[`addon.${k}`] = v;
  for (const [check, fields] of Object.entries(r.checks ?? {}))
    for (const [k, v] of Object.entries(fields)) o[`check.${check}.${k}`] = String(v);
  for (const k of Object.keys(o)) if (!/^[A-Za-z0-9_.]{1,80}$/.test(k) || o[k]!.length > 500) delete o[k];
  return o;
}

/** The recorded hosts a card may name, for the lint (`lintOwnerSteps`). Falls back to an empty list. */
export function hostFactsService(deps: { dir?: string; log?: (msg: string) => void; db?: Db; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
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

  /** The facts the card lint uses, in the shape steps.ts expects. A folder with several roles keeps the one that
   * matters most to R6 (backups, data, secrets before install and deployer), so one field says what it is. */
  async function hosts(): Promise<HostFacts[]> {
    const r = await read();
    if (!r) return [];
    const ownership: Ownership[] = r.ownership.map(({ role, roles, ...o }) => {
      const all = [...(roles ?? []), ...(role ? [role] : [])].sort((a, b) => FOLDER_ROLES.indexOf(a) - FOLDER_ROLES.indexOf(b));
      return all.length ? { ...o, role: all[0]! } : o;
    });
    return [{ name: r.name, ...(r.login ? { login: r.login } : {}), ownership }];
  }

  async function load(): Promise<HostFactsRecord> {
    if (!deps.db) return { facts: {}, hostName: null, reportedAt: null };
    const [row] = await deps.db.select({ value: settings.value }).from(settings).where(eq(settings.key, HOST_FACTS_KEY));
    const v = row?.value as Partial<HostFactsRecord> | undefined;
    return { facts: v?.facts ?? {}, hostName: v?.hostName ?? null, reportedAt: v?.reportedAt ?? null };
  }
  async function save(rec: HostFactsRecord): Promise<void> {
    if (!deps.db) return;
    await deps.db.insert(settings).values({ key: HOST_FACTS_KEY, value: rec }).onConflictDoUpdate({ target: settings.key, set: { value: rec } });
  }

  /** Fold the host's latest report into the settings record. Reported facts replace older ones; an owner-confirmed
   * fact stays until the host reports the same key, and a different value there is kept as a conflict (the host's
   * value wins). A fact the host stops reporting is dropped, so a card can't be filled from a stale one. */
  async function sync(): Promise<HostFactsRecord> {
    const prev = await load();
    const r = await read();
    if (!r) return prev; // no report (older deployer, not ticked yet): keep what we have
    const reported = flattenHostRecord(r);
    const at = r.writtenAt;
    const facts: Record<string, HostFact> = {};
    for (const [k, v] of Object.entries(reported)) {
      const old = prev.facts[k];
      const confirmed = old?.source === "owner" ? old.value : old?.conflict?.confirmed;
      facts[k] = confirmed !== undefined && confirmed !== v ? { value: v, source: "host", at, conflict: { confirmed, reported: v } } : { value: v, source: "host", at };
    }
    for (const [k, f] of Object.entries(prev.facts)) if (f.source === "owner" && !(k in reported)) facts[k] = f;
    const rec: HostFactsRecord = { facts, hostName: r.name, reportedAt: at };
    if (JSON.stringify(rec) !== JSON.stringify(prev)) await save(rec);
    return rec;
  }

  /** The owner confirms a fact the host can't detect. Only keys on OWNER_FACTS, or keys the host doesn't report. */
  async function confirm(key: string, value: string): Promise<HostFactsRecord> {
    if (!/^[A-Za-z0-9_.]{1,80}$/.test(key)) throw new Error("That isn't a fact name.");
    value = value.trim();
    if (!value || value.length > 500) throw new Error("A fact needs a value of 1 to 500 characters.");
    const rec = await sync();
    if (rec.facts[key]?.source === "host") throw new Error("The host reports that fact itself, so it can't be confirmed by hand.");
    rec.facts[key] = { value, source: "owner", at: now().toISOString() };
    await save(rec);
    return rec;
  }

  /** A fact's value for a card token, or null when it is missing. */
  async function value(key: string): Promise<string | null> {
    const rec = await sync();
    return rec.facts[key]?.value ?? null;
  }

  /** Every recorded fact's value, for filling `{{host.…}}` tokens. Undefined when the steps use no host token, so
   * a card without one never waits on the settings record. */
  async function valuesFor(steps: readonly string[] | undefined): Promise<Record<string, string> | undefined> {
    if (!steps?.some((s) => s.includes("{{"))) return undefined;
    const rec = await sync();
    return Object.fromEntries(Object.entries(rec.facts).map(([k, f]) => [k, f.value]));
  }

  /** The add-on states the host reported, if the report is fresh enough to trust. */
  async function reportedAddons(): Promise<Record<string, string>> {
    const r = await read();
    if (!r?.addons) return {};
    const age = now().getTime() - Date.parse(r.writtenAt);
    return Number.isFinite(age) && age <= HOST_REPORT_FRESH_MS ? r.addons : {};
  }

  /** The name the host deployer reports for the server itself (BOS-774), for the card lint: a card that names a
   * different host is refused. null when there is no report yet, so the lint can say so rather than guess. */
  async function serverHost(): Promise<string | null> {
    const r = await read();
    return r?.name ?? null;
  }

  /** The BOSSMAN_NETGUARD_ALLOW lines the host last reported from .env (BOS-770), with when; null when it reports none (an older deployer, or no deployer). */
  async function netguardEnv(): Promise<{ envFound: boolean; lines: string[][]; reportedAt: string } | null> {
    const r = await read();
    return r?.netguardEnv ? { ...r.netguardEnv, reportedAt: r.writtenAt } : null;
  }

  return { read, hosts, serverHost, load, sync, confirm, value, valuesFor, reportedAddons, netguardEnv };
}
