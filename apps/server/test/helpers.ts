import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies } from "../src/db/schema.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import type { LiveValidator } from "../src/services/secrets.js";
import type { PortalLimits } from "../src/portal.js";

export async function makeApp(opts: { liveValidator?: LiveValidator; portalLimits?: Partial<PortalLimits>; portalUrl?: string } = {}) {
  const { db, close } = await openPglite();
  const master = { version: 1, key: randomBytes(32) };
  const built = await buildApp({ db, master, secureCookies: false, liveValidator: opts.liveValidator, portalLimits: opts.portalLimits, portalUrl: opts.portalUrl });
  return { ...built, db, master, close: async () => (await built.app.close(), await close()) };
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

/** Sets up the owner and returns a cookie header for authenticated requests. */
export async function signIn(t: TestApp): Promise<{ cookie: string }> {
  const res = await t.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === "bm_session");
  if (!c) throw new Error("no session cookie");
  return { cookie: `bm_session=${c.value}` };
}

/** The owner approves a ticket: the request returns 202 at once, so wait for the landing to finish and fold its outcome into the answer. */
export async function approveAndWait(req: (method: "GET" | "POST", url: string, payload?: unknown) => Promise<{ statusCode: number; json: () => any }>, ticketId: string) {
  const res = await req("POST", `/api/tickets/${ticketId}/review`, { verdict: "approved" });
  if (res.statusCode !== 202) return res;
  for (let i = 0; i < 200; i++) {
    const { landing } = (await req("GET", `/api/tickets/${ticketId}/landing`)).json();
    if (landing?.state === "finished") return { statusCode: 202, json: () => ({ ...res.json(), outcome: landing.outcome, message: landing.text, landing }) };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("landing never finished");
}

/**
 * Names (or un-names) an agent as a security reviewer in its company's Settings > Reviews, at the
 * critical tier only so other tiers' tickets don't gain a security review. The skill add flow's
 * Security Reviewer is any agent named there (BOS-198).
 */
export async function nameSecurityReviewer(db: TestApp["db"], agentId: string, on = true) {
  const [a] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
  const [c] = await db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, a!.companyId));
  const { security: _, ...rest } = c!.policy.critical.kinds ?? {};
  await db.update(companies).set({ reviewPolicy: { ...c!.policy, critical: { ...c!.policy.critical, kinds: on ? { ...rest, security: agentId } : rest } } }).where(eq(companies.id, a!.companyId));
}
