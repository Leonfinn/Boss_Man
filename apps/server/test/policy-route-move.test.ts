import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: { app: Awaited<ReturnType<typeof buildApp>>["app"]; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  ctx = { app: built.app, close };
  return built;
}

/** Every route the policy block owns, with its method. Moving the block must not change any of them. */
const POLICY_ROUTES: Array<[string, string]> = [
  ["GET", "/api/companies/:id/review-policy"],
  ["PUT", "/api/companies/:id/review-policy"],
  ["GET", "/api/projects/:id/review-policy"],
  ["PUT", "/api/projects/:id/review-policy"],
  ["DELETE", "/api/projects/:id/review-policy"],
  ["GET", "/api/companies/:id/standing-rules"],
  ["PUT", "/api/companies/:id/standing-rules"],
  ["POST", "/api/companies/:id/standing-rules/append"],
  ["POST", "/api/companies/:id/standing-rules/undo"],
  ["GET", "/api/policy-rules"],
  ["POST", "/api/policy-rules"],
  ["PATCH", "/api/policy-rules/:id"],
  ["DELETE", "/api/policy-rules/:id"],
  ["POST", "/api/policy-rules/order"],
  ["POST", "/api/policy-rules/test"],
  ["POST", "/api/companies/:id/rule-requests"],
  ["DELETE", "/api/grants/:id"],
  ["PUT", "/api/grants/:id/agents"],
];

describe("policy routes (moved out of app.ts)", () => {
  it("registers every policy route with the same method and path", async () => {
    const { app } = await setup();
    for (const [method, url] of POLICY_ROUTES) {
      expect(app.hasRoute({ method: method as "GET", url }), `${method} ${url}`).toBe(true);
    }
  });

  it("still registers routes the policy move must not disturb", async () => {
    const { app } = await setup();
    // The secrets block that sat between the moved blocks, and route groups registered around them.
    // The risk-tier help lives in routes/settings-limits.ts (main moved it first), so it must still answer here.
    expect(app.hasRoute({ method: "GET", url: "/api/risk-tiers" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/secrets" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/secrets/:id/grants" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/companies/:id/runner" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/companies/:id/export" })).toBe(true);
  });

  it("answers 401 without the owner's session", async () => {
    const { app } = await setup();
    const companyId = randomUUID();
    for (const [method, url] of [
      ["GET", "/api/policy-rules"],
      ["POST", "/api/policy-rules"],
      ["GET", "/api/risk-tiers"],
      ["GET", `/api/companies/${companyId}/review-policy`],
      ["PUT", `/api/companies/${companyId}/review-policy`],
      ["GET", `/api/companies/${companyId}/standing-rules`],
    ]) {
      const res = await app.inject({ method: method as "GET", url, ...(method === "GET" ? {} : { payload: {} }) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json()).toMatchObject({ error: "not_signed_in" });
    }
  });
});
