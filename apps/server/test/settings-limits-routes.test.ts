// BOS-1051: the settings, WIP-limit, run-limit and risk-tier routes moved out of app.ts into
// routes/settings-limits.ts. They are still owner routes registered on the owner scope, so each one
// answers 401 without a session, exactly as before the move.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" } as never);
  return { ...built, close };
}

const MOVED = [
  { method: "GET", url: "/api/risk-tiers" },
  { method: "GET", url: "/api/run-limits" },
  { method: "PUT", url: "/api/run-limits" },
  { method: "GET", url: "/api/wip-limits" },
  { method: "PUT", url: "/api/wip-limits" },
  { method: "GET", url: "/api/settings/check-queue" },
  { method: "PUT", url: "/api/settings/check-queue" },
  { method: "GET", url: "/api/settings/check-merged-result" },
  { method: "PUT", url: "/api/settings/check-merged-result" },
  // BOS-1070: the owner's "Wait for GitHub CI" switch.
  { method: "GET", url: "/api/settings/wait-for-ci" },
  { method: "PUT", url: "/api/settings/wait-for-ci" },
] as const;

describe("the moved settings and limits routes are still owner only (BOS-1051)", () => {
  it("answers 401 without a session for every moved route", async () => {
    const c = (ctx = await setup());
    for (const { method, url } of MOVED) {
      const res = await c.app.inject({ method, url, ...(method === "PUT" ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json(), `${method} ${url}`).toEqual({ error: "not_signed_in" });
    }
  });
});
