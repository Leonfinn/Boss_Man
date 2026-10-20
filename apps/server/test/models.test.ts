import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url.startsWith("https://api.anthropic.com/v1/models")) return new Response(JSON.stringify({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", type: "model" }, { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", type: "model" }], has_more: false }), { status: 200 });
    if (url === "https://gw.example/api/v1/models") return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5", name: "GPT-5", supported_parameters: ["tools"] }, { id: "some/no-tools", supported_parameters: [] }, { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", supported_parameters: ["tools"] }] }), { status: 200 });
    if (url === "https://api.openai.com/v1/models") return new Response(JSON.stringify({ data: [{ id: "text-embedding-3-large" }, { id: "gpt-5" }, { id: "gpt-5-codex" }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  return { ...built, db, close, req, company, runnerRow: runnerRow!, calls };
}

describe("model lists for the picker (R60)", () => {
  it("keeps what the runner reports per agent kind, and lists an API key's models", async () => {
    const c = (ctx = await setup());
    await c.runners.ingest(c.runnerRow, { seq: 1, at: new Date().toISOString(), event: { type: "runner.models", agentKind: "claude", models: [{ value: "default", name: "Default", description: "Recommended" }, { value: "opus", name: "Opus" }] } });
    await new Promise((r) => setTimeout(r, 50));
    const { secret } = (await c.req("POST", "/api/secrets", { name: "Anthropic key", kind: "anthropic_api_key", value: "sk-ant-api03-example-key" })).json();
    await c.req("POST", "/api/funding-sources", { name: "API credit", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 100, cycleAnchor: new Date().toISOString(), secretId: secret.id });
    const { secret: oa } = (await c.req("POST", "/api/secrets", { name: "OpenAI key", kind: "openai_api_key", value: "sk-proj-example-openai-key" })).json();
    await c.req("POST", "/api/funding-sources", { name: "OpenAI", kind: "api_payg", provider: "openai", secretId: oa.id });

    const lists = (await c.req("GET", `/api/companies/${c.company.id}/models`)).json();
    expect(lists.runner.claude.models.map((m: { value: string }) => m.value)).toEqual(["default", "opus"]);
    const anthropic = lists.api.find((a: { provider: string }) => a.provider === "anthropic");
    expect(anthropic).toMatchObject({ name: "API credit", error: null, models: [{ value: "claude-opus-5-5", name: "Claude Opus 5.5" }, { value: "claude-haiku-5-5", name: "Claude Haiku 5.5" }] });
    expect(lists.api.find((a: { provider: string }) => a.provider === "openai").models.map((m: { value: string }) => m.value)).toEqual(["gpt-5", "gpt-5-codex"]);
    const call = c.calls.find((x) => x.url.startsWith("https://api.anthropic.com"))!;
    expect(call.headers.get("x-api-key")).toBe("sk-ant-api03-example-key");
    expect(call.headers.get("anthropic-version")).toBe("2023-06-01");

    // Cached for an hour, unless asked to refresh.
    const before = c.calls.length;
    await c.req("GET", `/api/companies/${c.company.id}/models`);
    expect(c.calls.length).toBe(before);
    await c.req("GET", `/api/companies/${c.company.id}/models?refresh=1`);
    expect(c.calls.length).toBe(before + 2);
  });

  it("lists a gateway's tool-capable models from its ANTHROPIC_BASE_URL, Claude first", async () => {
    const c = (ctx = await setup());
    const { secret: key } = (await c.req("POST", "/api/secrets", { name: "OpenRouter key", kind: "generic", value: "sk-or-v1-example-key" })).json();
    await c.req("POST", "/api/funding-sources", { name: "OpenRouter", kind: "api_payg", provider: "gateway", secretId: key.id });
    const { secret: url } = (await c.req("POST", "/api/secrets", { name: "Gateway URL", kind: "generic", value: "https://gw.example/api/" })).json();
    expect((await c.req("POST", `/api/secrets/${url.id}/grants`, { companyId: c.company.id, envName: "ANTHROPIC_BASE_URL" })).statusCode).toBe(201);

    const lists = (await c.req("GET", `/api/companies/${c.company.id}/models`)).json();
    expect(lists.api.find((a: { provider: string }) => a.provider === "gateway")).toMatchObject({
      error: null,
      models: [
        { value: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
        { value: "openai/gpt-5", name: "GPT-5 (not Claude: may not work)" },
      ],
    });
    expect(c.calls.find((x) => x.url.startsWith("https://gw.example"))!.headers.get("authorization")).toBe("Bearer sk-or-v1-example-key");
  });
});
