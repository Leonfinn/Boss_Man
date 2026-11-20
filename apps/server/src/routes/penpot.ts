// Settings → Tools → Penpot (BOS-1582), owner only: one form for the four Penpot secrets agents use (docs/16).
//
// Storage is unchanged on purpose: the form reads and writes the same four company grants the owner used to make by hand
// on the Secrets page (PENPOT_URL, PENPOT_TOKEN, PENPOT_EMAIL, PENPOT_PASSWORD), so an install set up that way shows here
// as already configured with nothing to migrate or re-enter, and the runner and skills/penpot keep reading the same env
// names. The network guard opens the host:port in PENPOT_URL by itself (services/launcher.ts allowFor), and hears every
// change to that grant through secretsService.onGrantChange, whichever page made it.
//
// Nothing secret goes back to the browser: the token, email and password come back only as "set" plus their hint. The
// address does come back (it is an address, not a credential), unless it carries a login, which the form never saves.
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { agents, companies } from "../db/schema.js";
import { isLanHost, penpotAddress } from "../services/launcher.js";
import type { secretsService } from "../services/secrets.js";

/** The env names agents and skills/penpot read. Never rename: hand-made grants from before BOS-1582 use them. */
export const PENPOT_ENV = { url: "PENPOT_URL", token: "PENPOT_TOKEN", email: "PENPOT_EMAIL", password: "PENPOT_PASSWORD" } as const;
type Field = keyof typeof PENPOT_ENV;
const FIELDS = Object.keys(PENPOT_ENV) as Field[];

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

/** Why an address can't be used, or null. The guard can only open a plain http(s) host:port that isn't one of Boss Man's own services. */
export function penpotUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Use Penpot's full address, like http://192.168.1.50:9001.";
  }
  if (!["http:", "https:"].includes(u.protocol)) return "Use an http:// or https:// address.";
  if (u.username || u.password) return "Leave the login out of the address: put the access token in its own field.";
  if (!penpotAddress(url)) return "The network guard can't open that address. Use a host name or IPv4 address (not one of Boss Man's own services) with an optional port.";
  return null;
}

/** A field left out or blank keeps its value; null (email and password only) removes it. */
const Keep = z.string().max(20_000).optional();
const PenpotInput = z.object({
  url: z
    .string()
    .trim()
    .max(500)
    .optional()
    .superRefine((u, ctx) => {
      const problem = u ? penpotUrlProblem(u) : null;
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  token: Keep,
  email: Keep.nullable(),
  password: Keep.nullable(),
  /** Who gets the address and token; empty means every agent in the company. */
  agentIds: z.array(Uuid).max(200),
  /** Who gets the export login (email and password); empty means every agent. */
  exportAgentIds: z.array(Uuid).max(200),
});

export function penpotRoutes(owner: FastifyInstance, deps: { db: Db; secretsSvc: ReturnType<typeof secretsService> }) {
  const { db, secretsSvc } = deps;

  /** The company's company-wide Penpot grants by field. A grant tied to a deploy target is not Penpot's. */
  const grantsOf = async (companyId: string) => {
    const all = (await secretsSvc.grantsForCompany(companyId)).filter((g) => !g.deployTargetId);
    return Object.fromEntries(FIELDS.map((f) => [f, all.find((g) => g.envName === PENPOT_ENV[f]) ?? null])) as Record<Field, (typeof all)[number] | null>;
  };

  async function view(companyId: string) {
    const g = await grantsOf(companyId);
    const raw = (await secretsSvc.grantedValue(companyId, PENPOT_ENV.url))?.trim() || null;
    // An address saved by hand with a login in it is not shown, only its hint.
    const shown = raw && !/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(raw) ? raw : null;
    const address = raw ? penpotAddress(raw) : null;
    const field = (f: Field) => ({ set: !!g[f], hint: g[f]?.hint ?? null, secretName: g[f]?.secretName ?? null });
    return {
      configured: !!g.url && !!g.token,
      url: shown,
      urlHint: raw && !shown ? g.url!.hint : null,
      /** The host:port the network guard opens for this company's runner, or null when the address can't be opened. */
      guardAddress: address,
      /** True when the guard keeps a private address for it (a LAN address); false for a public name (BOS-708). */
      guardTrustsPrivate: !!raw && !!address && isLanHost(raw),
      token: field("token"),
      email: field("email"),
      password: field("password"),
      // Each pair's list comes from the grant that holds the secret (token, password), not the address or email: a hand-made
      // pair may differ, the form sends this one list back for both, and reading the wider one would widen the secret (BOS-1592).
      agentIds: (g.token ?? g.url)?.agentIds ?? [],
      exportAgentIds: (g.password ?? g.email)?.agentIds ?? [],
    };
  }

  /** A secret name that's free, or an unused one with the same name to reuse (left behind by a removed Penpot). */
  async function secretSlot(base: string, companyName: string): Promise<{ reuse: string } | { name: string }> {
    const byName = new Map((await secretsSvc.list()).map((s) => [s.name, s.id]));
    const existing = byName.get(base);
    if (existing && !(await secretsSvc.grantsForSecret(existing)).length) return { reuse: existing };
    if (!existing) return { name: base };
    const named = `${base} (${companyName.slice(0, 50)})`;
    for (let i = 1; ; i++) {
      const name = i === 1 ? named : `${named} ${i}`;
      if (!byName.has(name)) return { name };
    }
  }

  /** Saves one field for this company only: a secret shared with another grant gets a copy, so the other keeps its value. */
  async function setValue(companyId: string, companyName: string, f: Field, value: string, current: { id: string; secretId: string } | null) {
    const env = PENPOT_ENV[f];
    if (current) {
      const others = (await secretsSvc.grantsForSecret(current.secretId)).filter((x) => x.id !== current.id);
      if (!others.length) {
        await secretsSvc.rotate(current.secretId, value, { acceptUnusualFormat: true });
        return;
      }
      await secretsSvc.revoke(current.id);
    }
    const slot = await secretSlot(env, companyName);
    const secretId = "reuse" in slot ? slot.reuse : (await secretsSvc.create({ name: slot.name, kind: "generic", value, acceptUnusualFormat: true })).secret.id;
    if ("reuse" in slot) await secretsSvc.rotate(secretId, value, { acceptUnusualFormat: true });
    await secretsSvc.grant(secretId, companyId, env);
  }

  owner.get("/api/companies/:id/penpot", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
    if (!c) return reply.code(404).send({ error: "not_found" });
    return view(id);
  });

  owner.put("/api/companies/:id/penpot", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = PenpotInput.parse(req.body);
    const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, id));
    if (!c) return reply.code(404).send({ error: "not_found" });
    const g = await grantsOf(id);
    const given = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const next = { url: given(b.url), token: given(b.token), email: given(b.email), password: b.password ? b.password : undefined };
    // Every check before anything is written, so a refused save changes nothing.
    const after = (f: Field) => (b[f] === null ? false : !!next[f] || !!g[f]);
    if (!after("url") || !after("token")) return reply.code(400).send({ error: "invalid", message: "Penpot needs its address and an access token." });
    if (after("email") !== after("password")) return reply.code(400).send({ error: "invalid", message: "Give both the export email and password, or neither." });
    const wanted = [...new Set([...b.agentIds, ...b.exportAgentIds])];
    if (wanted.length) {
      const mine = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, id));
      const ids = new Set(mine.map((a) => a.id));
      if (!wanted.every((a) => ids.has(a))) return reply.code(400).send({ error: "invalid_agents", message: "Every agent must belong to this company." });
    }
    for (const f of FIELDS) {
      if (b[f] === null && g[f]) await secretsSvc.revoke(g[f]!.id);
      else if (next[f] !== undefined) await setValue(id, c.name, f, next[f]!, g[f]);
    }
    const now = await grantsOf(id);
    for (const f of FIELDS) {
      const grant = now[f];
      if (grant) await secretsSvc.setGrantAgents(grant.id, f === "url" || f === "token" ? b.agentIds : b.exportAgentIds);
    }
    return view(id);
  });

  // Removes Penpot from this company: its four grants go, so no agent gets them and the guard closes the address. The
  // secrets themselves stay on the Secrets page (another company may use them); the form reuses an unused one next time.
  owner.delete("/api/companies/:id/penpot", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
    if (!c) return reply.code(404).send({ error: "not_found" });
    const g = await grantsOf(id);
    for (const f of FIELDS) if (g[f]) await secretsSvc.revoke(g[f]!.id);
    return view(id);
  });
}
