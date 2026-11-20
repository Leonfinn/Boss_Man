import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, wakes } from "../src/db/schema.js";
import { releasedCommitOf } from "../src/services/go-live-card.js";
import { securityAlertChanged, STALE_REASON } from "../src/services/stale-requests.js";

// BOS-2085 (R54): a security alert opening or closing sends every open go-live card back for a re-check.
const SHA = "1c8d92271c8d92271c8d92271c8d92271c8d9227";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  return { ...built, db, close, company, worker };
}

describe("releasedCommitOf", () => {
  it("takes the first full sha, lower-cased, and ignores short ones", () => {
    expect(releasedCommitOf("Tag 1c8d9227 now", `Release ${SHA.toUpperCase()} please`)).toBe(SHA);
    expect(releasedCommitOf("Tag 1c8d9227 now", undefined)).toBeUndefined();
    expect(releasedCommitOf("a".repeat(41))).toBeUndefined();
  });
});

describe("securityAlertChanged", () => {
  it("re-checks every open go-live card, not other cards, and wakes the author once", async () => {
    const c = (ctx = await setup());
    const raise = (question: string, extra: Record<string, unknown> = {}) =>
      c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question, options: ["Yes", "No"], recommended: "Yes", triedFirst: "Looked", ...extra });
    const live = await raise("Tag the release?", { goLive: true, releasesCommit: SHA });
    const liveToo = await raise("Publish the site?", { goLive: true });
    const plain = await raise("Which colour?");

    const [row] = await c.db.select().from(decisions).where(eq(decisions.id, live.id));
    expect(row!.context).toMatchObject({ goLive: true, releasesCommit: SHA });

    const r = await securityAlertChanged(c.db, { companyId: c.company.id, change: "opened", alert: "Dependabot high alert #7 on example/repo, body-parser", wake: (w) => c.scheduler.notify(w.agentId, w as { ticketId: string; reason: string; note: string }) });
    expect(r.flaggedDecisions.sort()).toEqual([live.id, liveToo.id].sort());
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, live.id));
    expect(after!.staleReason).toMatch(/security alert opened.*body-parser/);
    expect(after!.recheckStage).toBe("author");
    const [other] = await c.db.select().from(decisions).where(eq(decisions.id, plain.id));
    expect(other!.staleAt).toBeNull();
    expect(await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, STALE_REASON)))).toHaveLength(1);

    // A second alert while both are already in re-check flags nothing more.
    const again = await securityAlertChanged(c.db, { companyId: c.company.id, change: "closed", alert: "alert #7" });
    expect(again.flaggedDecisions).toEqual([]);
  });
});
