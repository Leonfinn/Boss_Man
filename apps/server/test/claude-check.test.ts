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
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = { cookie }) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string; token: string };
  const sent: RunnerCommand[] = [];
  if (online)
    built.runners.connect(reg.runnerId, (c) => {
      sent.push(c);
      if (c.type === "credential.check") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { ok: true, message: "Claude Code answered using the setup-token." } }));
      return true;
    });
  const grantToken = async () => {
    const secret = (await req("POST", "/api/secrets", { name: "Max", kind: "claude_oauth_token", value: "sk-ant-oat01-abcdefghijklmnop" })).json().secret.id as string;
    await req("POST", `/api/secrets/${secret}/grants`, { companyId: company.id, envName: "CLAUDE_CODE_OAUTH_TOKEN" });
  };
  return { ...built, close, req, company, reg, sent, grantToken };
}

describe("setup-token check through the runner (R58)", () => {
  it("asks the runner to check, and never puts the token in the command", async () => {
    const c = (ctx = await setup());
    expect((await c.req("POST", `/api/companies/${c.company.id}/check-claude`)).json()).toEqual({ ok: false, message: "The company has no Claude setup-token yet." });
    expect(c.sent).toEqual([]);
    await c.grantToken();
    expect((await c.req("POST", `/api/companies/${c.company.id}/check-claude`)).json()).toEqual({ ok: true, message: "Claude Code answered using the setup-token." });
    const cmd = c.sent.find((x) => x.type === "credential.check")!;
    expect(Object.keys(cmd).sort()).toEqual(["requestId", "type"]);
    expect(JSON.stringify(c.sent)).not.toContain("sk-ant-oat01");
  });

  it("lets the runner fetch the token for a check, outside a run", async () => {
    const c = (ctx = await setup());
    await c.grantToken();
    const res = await c.req("GET", "/api/runner/env?purpose=check", undefined, { authorization: `Bearer ${c.reg.token}` });
    expect(res.json().env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-abcdefghijklmnop");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("says when the runner isn't connected", async () => {
    const c = (ctx = await setup(false));
    await c.grantToken();
    expect((await c.req("POST", `/api/companies/${c.company.id}/check-claude`)).json().message).toContain("isn't connected");
  });
});
