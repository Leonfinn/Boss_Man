import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, runners as runnersTable, tickets } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const GITEA = "http://192.168.1.50:3003";

async function setup(push = true) {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (url === `${GITEA}/api/v1/version`) return new Response(JSON.stringify({ version: "28.0.0" }), { status: 200 });
    if (url === `${GITEA}/api/v1/repos/leon/site`) return auth === "token gitea-token" ? new Response(JSON.stringify({ full_name: "leon/site", permissions: { admin: false, push, pull: true } }), { status: 200 }) : new Response(JSON.stringify({ message: "token is required" }), { status: 401 });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { ...built, db, close, req };
}

describe("the setup wizard (R56)", () => {
  it("saves where the owner is, so it resumes, and can be dismissed", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", "/api/setup-progress")).json()).toEqual({ dismissed: false, step: 0, companyId: null, firstMerge: null });
    await c.req("PUT", "/api/setup-progress", { step: 3 });
    expect((await c.req("GET", "/api/setup-progress")).json()).toMatchObject({ step: 3, dismissed: false });
    await c.req("PUT", "/api/setup-progress", { dismissed: true });
    expect((await c.req("GET", "/api/setup-progress")).json()).toMatchObject({ step: 3, dismissed: true });
    // The owner account's own setup route is untouched.
    expect((await c.app.inject({ method: "GET", url: "/api/setup" })).statusCode).toBe(200);
  });

  it("works the checklist out from what's set up, and checks the git token against the repo", async () => {
    const c = (ctx = await setup());
    const { company, ceo } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
    const todo = async () => ((await c.req("GET", `/api/companies/${company.id}/setup-checklist`)).json() as Array<{ id: string; done: boolean }>).filter((i) => !i.done).map((i) => i.id);
    // Without a choice, or a repo, a company gets the no-code list (see the test below); "Code" keeps the code items.
    await c.req("PUT", "/api/setup-progress", { work: "code" });
    expect(await todo()).toEqual(["company", "project", "runner", "credential", "git", "checks", "funding", "ticket", "merged"]);

    await c.req("PATCH", `/api/companies/${company.id}`, { mission: "Ship the shop." });
    const project = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
    expect((await c.req("POST", `/api/projects/${project.id}/check-git-token`)).json()).toMatchObject({ ok: false });
    await c.req("PATCH", `/api/projects/${project.id}`, { repoUrl: `${GITEA}/leon/site.git` });
    expect((await c.req("POST", `/api/projects/${project.id}/check-git-token`)).json().message).toContain("no GIT_TOKEN");

    const grant = async (name: string, kind: string, value: string, envName: string) => {
      const { secret } = (await c.req("POST", "/api/secrets", { name, kind, value })).json();
      await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName });
      return secret.id as string;
    };
    await grant("Claude", "claude_oauth_token", "sk-ant-oat01-example-token-value", "CLAUDE_CODE_OAUTH_TOKEN");
    await grant("Gitea", "generic", "gitea-token", "GIT_TOKEN");
    expect((await c.req("POST", `/api/projects/${project.id}/check-git-token`)).json()).toEqual({ ok: true, canPush: true, message: "The token can read and push to the repo." });
    const source = (await c.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
    await c.req("PATCH", `/api/agents/${ceo.id}`, { fundingSourceId: source.id });
    await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Plan the shop" });
    expect(await todo()).toContain("checks");
    await c.req("PATCH", `/api/projects/${project.id}`, { verifyCommand: "pnpm test" });
    // Only the runner is left: it isn't connected.
    expect(await todo()).toEqual(["runner", "merged"]);

    // The first merge: the earliest merged ticket, timed from the owner account's creation, stored once.
    const mergedAt = new Date(Date.now() + (2 * 60 + 40) * 60_000);
    const [t] = await c.db.select({ id: tickets.id, number: tickets.number }).from(tickets).where(eq(tickets.projectId, project.id));
    await c.db.update(tickets).set({ mergedAt, mergeCommit: "abc123" }).where(eq(tickets.id, t!.id));
    const checklist = async () => (await c.req("GET", `/api/companies/${company.id}/setup-checklist`)).json() as Array<{ id: string; done: boolean; label: string }>;
    const item = (await checklist()).find((i) => i.id === "merged")!;
    expect(item.done).toBe(true);
    expect(item.label).toMatch(/^First ticket merged: .+-\d+, 2 h 4\d min after setup started$/);
    const fm = ((await c.req("GET", "/api/setup-progress")).json() as { firstMerge: { ref: string; minutes: number } }).firstMerge;
    expect(fm.minutes).toBeGreaterThanOrEqual(160);
    // Deleting the ticket doesn't change what was recorded.
    await c.db.delete(tickets).where(eq(tickets.id, t!.id));
    expect(((await c.req("GET", "/api/setup-progress")).json() as { firstMerge: unknown }).firstMerge).toEqual(fm);
    expect((await checklist()).find((i) => i.id === "merged")!.done).toBe(true);
  });

  it("BOS-2815: counts a key saved for any listed option as the connect step done, and leaves an existing company's setup token and CEO link alone", async () => {
    const c = (ctx = await setup());
    const { company, ceo } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
    const item = async () => ((await c.req("GET", `/api/companies/${company.id}/setup-checklist`)).json() as Array<{ id: string; done: boolean }>).find((i) => i.id === "credential")!.done;
    expect(await item()).toBe(false);

    // An OpenRouter key, which agents could already run on but the checklist ignored.
    const { secret } = (await c.req("POST", "/api/secrets", { name: "App Co OpenRouter", kind: "generic", value: "sk-or-example-key" })).json();
    await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "OPENROUTER_API_KEY" });
    expect(await item()).toBe(true);

    // An existing company keeps its setup-token source and the CEO on it, whatever else is saved.
    const { secret: token } = (await c.req("POST", "/api/secrets", { name: "Claude", kind: "claude_oauth_token", value: "sk-ant-oat01-example-token-value" })).json();
    await c.req("POST", `/api/secrets/${token.id}/grants`, { companyId: company.id, envName: "CLAUDE_CODE_OAUTH_TOKEN" });
    const source = (await c.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic", secretId: token.id })).json() as { id: string };
    await c.req("PATCH", `/api/agents/${ceo.id}`, { fundingSourceId: source.id });
    const before = (await c.req("GET", "/api/funding-sources")).json() as Array<{ id: string; secretId: string | null }>;
    const ceoRow = (await c.req("GET", "/api/companies")).json() as Array<{ agents: Array<{ id: string; fundingSourceId: string | null }> }>;
    expect(before.find((s) => s.id === source.id)!.secretId).toBe(token.id);
    expect(ceoRow[0]!.agents.find((a) => a.id === ceo.id)!.fundingSourceId).toBe(source.id);
  });

  it("gives a company with no repo a list that can finish: no git token or checks, first task finished", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "Docs Co" })).json() as { company: { id: string } };
    const list = async () => (await c.req("GET", `/api/companies/${company.id}/setup-checklist`)).json() as Array<{ id: string; label: string; done: boolean }>;
    expect((await list()).map((i) => i.id)).toEqual(["company", "project", "runner", "credential", "funding", "ticket", "merged"]);
    expect((await list()).find((i) => i.id === "project")).toMatchObject({ label: "Choose what you work on", done: false });
    const project = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Research" })).json() as { id: string };
    expect((await list()).find((i) => i.id === "project")!.done).toBe(true);
    const t = (await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Summarise the market" })).json() as { id: string };
    expect((await list()).find((i) => i.id === "merged")).toMatchObject({ label: "First task finished", done: false });
    // A finished task counts, merged or not; a cancelled one doesn't.
    await c.db.update(tickets).set({ systemState: "done", outcome: "cancelled" }).where(eq(tickets.id, t.id));
    expect((await list()).find((i) => i.id === "merged")!.done).toBe(false);
    await c.db.update(tickets).set({ systemState: "done", outcome: "completed" }).where(eq(tickets.id, t.id));
    expect((await list()).find((i) => i.id === "merged")!.done).toBe(true);
    // A repo brings the code items back.
    await c.req("PATCH", `/api/projects/${project.id}`, { repoUrl: `${GITEA}/leon/site.git` });
    expect((await list()).map((i) => i.id)).toContain("git");
  });

  it("names what keeps agents from starting, and clears it as each must-have is set (BOS-2814)", async () => {
    const c = (ctx = await setup());
    const { company, ceo } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
    const read = async () => (await c.req("GET", `/api/companies/${company.id}/start-block`)).json() as { items: Array<{ id: string; reason: string }>; noFunding: string[] };
    const first = await read();
    expect(first.items.map((i) => i.id)).toEqual(["claude", "funding", "runner"]);
    expect(first.items.find((i) => i.id === "funding")!.reason).toBe("the CEO has no Claude account to run on yet");
    expect(first.items.find((i) => i.id === "runner")!.reason).toBe("the runner isn't connected");
    expect(first.noFunding).toContain(ceo.id);
    const { secret } = (await c.req("POST", "/api/secrets", { name: "Claude", kind: "claude_oauth_token", value: "sk-ant-oat01-example-token-value" })).json();
    await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "CLAUDE_CODE_OAUTH_TOKEN" });
    const source = (await c.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
    await c.req("PATCH", `/api/agents/${ceo.id}`, { fundingSourceId: source.id });
    const after = await read();
    // Only the runner is left (the account was added first), and the CEO is paid for.
    expect(after.items.map((i) => i.id)).toEqual(["runner"]);
    expect(after.noFunding).not.toContain(ceo.id);
    expect((await c.req("GET", "/api/companies/00000000-0000-4000-8000-000000000000/start-block")).statusCode).toBe(404);
  });

  it("clears the start block in either order, and says nothing once the runner reports connected (BOS-2814)", async () => {
    const c = (ctx = await setup());
    const { company, ceo } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
    const read = async () => (await c.req("GET", `/api/companies/${company.id}/start-block`)).json() as { items: Array<{ id: string }>; noFunding: string[] };
    // Runner first: register it and have its socket open, then the account arrives last.
    const reg = (await c.req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
    const [row] = await c.db.select().from(runnersTable).where(eq(runnersTable.id, reg.runnerId));
    await c.runners.touch(row!, null);
    c.runners.connect(reg.runnerId, () => true);
    expect((await read()).items.map((i) => i.id)).toEqual(["claude", "funding"]);
    const { secret } = (await c.req("POST", "/api/secrets", { name: "Claude", kind: "claude_oauth_token", value: "sk-ant-oat01-example-token-value" })).json();
    await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "CLAUDE_CODE_OAUTH_TOKEN" });
    const source = (await c.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
    await c.req("PATCH", `/api/agents/${ceo.id}`, { fundingSourceId: source.id });
    const done = await read();
    expect(done.items).toEqual([]);
    // Every agent but the paused Wiki Maintainer (it has no funding until the owner starts it) is paid for.
    const [unpaid] = await c.db.select({ name: agents.name }).from(agents).where(eq(agents.id, done.noFunding[0]!));
    expect(done.noFunding).toHaveLength(1);
    expect(unpaid!.name).toBe("Wiki Maintainer");
  });

  it("says when the token can't push", async () => {
    const c = (ctx = await setup(false));
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    const project = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
    await c.req("PATCH", `/api/projects/${project.id}`, { repoUrl: `${GITEA}/leon/site.git` });
    const { secret } = (await c.req("POST", "/api/secrets", { name: "Gitea", kind: "generic", value: "gitea-token" })).json();
    await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "GIT_TOKEN" });
    expect((await c.req("POST", `/api/projects/${project.id}/check-git-token`)).json()).toMatchObject({ ok: true, canPush: false });
  });
});
