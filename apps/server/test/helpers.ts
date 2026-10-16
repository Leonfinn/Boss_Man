import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import type { LiveValidator } from "../src/services/secrets.js";

export async function makeApp(opts: { liveValidator?: LiveValidator } = {}) {
  const { db, close } = await openPglite();
  const master = { version: 1, key: randomBytes(32) };
  const built = await buildApp({ db, master, secureCookies: false, liveValidator: opts.liveValidator });
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
