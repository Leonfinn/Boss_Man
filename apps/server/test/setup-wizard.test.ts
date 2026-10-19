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

const GITEA = "http://192.168.68.67:3003";

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
    expect((await c.req("GET", "/api/setup-progress")).json()).toEqual({ dismissed: false, step: 0, companyId: null });
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
    expect(await todo()).toEqual(["company", "project", "runner", "credential", "git", "checks", "funding", "ticket"]);

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
    expect(await todo()).toEqual(["runner"]);
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
