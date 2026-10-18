import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(online = true) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  if (online)
    built.runners.connect(reg.runnerId, (c) => {
      sent.push(c);
      if (c.type === "workspace.detect")
        queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { checks: [{ id: "detected-go", label: "Run the tests (detected)", command: "go vet ./... && go test ./...", plain: "Run go vet and the Go tests", needs: ["go"] }], tools: { go: false, node: true } } }));
      return true;
    });
  return { ...built, db, close, req, project, sent };
}

describe("merge check presets (R57)", () => {
  it("asks the runner to look at the repo's default branch, and lists the standard choices", async () => {
    const c = (ctx = await setup());
    expect((await c.req("POST", `/api/projects/${c.project.id}/check-presets`)).json()).toMatchObject({ detected: [], error: "Set the project's git repo first." });
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "https://github.com/Leonfinn/site.git", defaultBranch: "develop" });
    const r = (await c.req("POST", `/api/projects/${c.project.id}/check-presets`)).json();
    expect(c.sent.find((x) => x.type === "workspace.detect")).toMatchObject({ projectId: c.project.id, repoUrl: "https://github.com/Leonfinn/site.git", baseRef: "develop" });
    expect(r).toMatchObject({ error: null, detected: [{ command: "go vet ./... && go test ./..." }], tools: { go: false } });
    expect(r.standard.map((p: { id: string }) => p.id)).toEqual(["node-npm", "node-pnpm", "node-yarn", "python-pytest", "go", "rust", "make"]);
    expect(r.none).toMatchObject({ command: null });
  });

  it("says when the runner isn't connected", async () => {
    const c = (ctx = await setup(false));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "https://github.com/Leonfinn/site.git" });
    expect((await c.req("POST", `/api/projects/${c.project.id}/check-presets`)).json().error).toContain("isn't connected");
  });
});
