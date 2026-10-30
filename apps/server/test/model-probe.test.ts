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

const MODELS = [{ value: "default", name: "Default", description: null }, { value: "sonnet", name: "Sonnet", description: "Fast" }];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  const connect = () =>
    built.runners.connect(reg.runnerId, (c) => {
      sent.push(c);
      if (c.type === "models.probe") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { models: MODELS } }));
      return true;
    });
  const grant = async (envName: string) => {
    const { secret } = (await req("POST", "/api/secrets", { name: `k-${envName}`, kind: "generic", value: "x-value" })).json();
    await req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName });
  };
  const lists = async () => (await req("GET", `/api/companies/${company.id}/models`)).json();
  const wait = () => new Promise((r) => setTimeout(r, 150));
  return { ...built, db, close, req, company, sent, connect, grant, lists, wait };
}

describe("model lists without a chat message", () => {
  it("probes when a runner connects with a Claude credential and no recorded list", async () => {
    const c = (ctx = await setup());
    await c.grant("ANTHROPIC_API_KEY");
    c.connect();
    await c.wait();
    expect(c.sent.filter((x) => x.type === "models.probe")).toMatchObject([{ agentKind: "claude" }]);
    expect((await c.lists()).runner.claude.models.map((m: { value: string }) => m.value)).toEqual(["default", "sonnet"]);
  });

  it("doesn't probe without a credential, or when a fresh list exists", async () => {
    const c = (ctx = await setup());
    c.connect();
    await c.wait();
    expect(c.sent.some((x) => x.type === "models.probe")).toBe(false);
    await c.grant("ANTHROPIC_API_KEY");
    await c.wait(); // the grant itself probes once
    c.sent.length = 0;
    c.connect();
    await c.wait();
    expect(c.sent.some((x) => x.type === "models.probe")).toBe(false);
  });

  it("probes OpenCode when a Synthetic key is granted", async () => {
    const c = (ctx = await setup());
    c.connect();
    await c.grant("SYNTHETIC_API_KEY");
    await c.wait();
    expect(c.sent.filter((x) => x.type === "models.probe")).toMatchObject([{ agentKind: "opencode" }]);
    expect((await c.lists()).runner.opencode.models.map((m: { value: string }) => m.value)).toEqual(["default", "sonnet"]);
  });

  it("probes after a credential is saved, and the refresh endpoint probes on demand", async () => {
    const c = (ctx = await setup());
    c.connect();
    await c.grant("CLAUDE_CODE_OAUTH_TOKEN");
    await c.wait();
    expect(c.sent.filter((x) => x.type === "models.probe")).toHaveLength(1);
    const r = (await c.req("POST", `/api/companies/${c.company.id}/models/refresh`)).json();
    expect(r).toEqual({ probed: { claude: { ok: true, count: 2 } } });
    expect(c.sent.filter((x) => x.type === "models.probe")).toHaveLength(2);
  });
});
