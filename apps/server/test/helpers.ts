import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import type { LiveValidator } from "../src/services/secrets.js";
import type { PortalLimits } from "../src/portal.js";

export async function makeApp(opts: { liveValidator?: LiveValidator; portalLimits?: Partial<PortalLimits> } = {}) {
  const { db, close } = await openPglite();
  const master = { version: 1, key: randomBytes(32) };
  const built = await buildApp({ db, master, secureCookies: false, liveValidator: opts.liveValidator, portalLimits: opts.portalLimits });
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
