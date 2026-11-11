// BOS-1074: a branch that merges cleanly (an unpushed branch whose head already contains main) must never wake its
// author with "your branch no longer merges". branchClash used to answer [] for "clean", and the sweep's `if (clash)`
// reads an empty array as a clash, so every idle review woke the author. A real clash is still reported.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { SENIOR_DEV_TEMPLATE, type RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, reviewRequests, runners, tickets, wakes } from "../src/db/schema.js";

const HOUR = 3_600_000;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(answer: { clashes: boolean; files: string[] }) {
  const { db, close: closeDb } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  close = async () => (await built.app.close(), await closeDb());
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const [reviewer] = await db.insert(agents).values({ companyId: company.id, name: "Rod", role: "worker", agentKind: "claude", title: "Senior Developer", template: SENIOR_DEV_TEMPLATE }).returning();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  // A repo URL nobody ever pushed this branch to: the runner answers from the ticket's own copy.
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(
    reg.runnerId,
    (c) => {
      sent.push(c);
      if (c.type === "workspace.clash") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: answer }));
      return true;
    },
    ["clash-check"],
  );
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Unpushed", assigneeAgentId: worker.id })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: "review" }).where(eq(tickets.id, t.id));
  await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: reviewer!.id, round: 1, createdAt: new Date(Date.now() - 4 * HOUR) });
  const authorClashWakes = () => db.select().from(wakes).where(and(eq(wakes.agentId, worker.id), eq(wakes.reason, "review clash")));
  return { built, sent, authorClashWakes };
}

describe("review clash wake (BOS-1074)", () => {
  it("does not wake the author when the runner says the branch merges cleanly", async () => {
    const c = await setup({ clashes: false, files: [] });
    await c.built.sweeps.run();
    expect(c.sent.filter((x) => x.type === "workspace.clash")).toHaveLength(1); // the check really ran
    expect(await c.authorClashWakes()).toHaveLength(0);
  });

  it("still wakes the author on a real clash, with its files", async () => {
    const c = await setup({ clashes: true, files: ["src/a.ts"] });
    await c.built.sweeps.run();
    const w = await c.authorClashWakes();
    expect(w).toHaveLength(1);
    expect(w[0]!.note).toContain("src/a.ts");
  });

  it("still wakes the author on a real clash whose file list is unknown", async () => {
    const c = await setup({ clashes: true, files: [] });
    await c.built.sweeps.run();
    expect(await c.authorClashWakes()).toHaveLength(1);
  });
});
