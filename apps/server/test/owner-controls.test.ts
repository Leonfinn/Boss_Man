import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners } from "../src/db/schema.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Homelab Co" })).json();
  const other = (await req("POST", "/api/companies", { name: "App Co" })).json().company;
  return { ...built, db, req, company, ceo, other };
}

describe("decision rules (R19)", () => {
  it("are checked company first, then for every company, then the defaults, in the owner's order", async () => {
    const c = await setup();
    const test = (command: string, companyId = c.company.id, kind = "execute") => c.req("POST", "/api/policy-rules/test", { companyId, command, kind }).then((r) => r.json());
    // By default a docker restart is an ordinary command and runs.
    expect(await test("docker restart web")).toEqual({ outcome: "allow", rule: "Other shell commands", row: 6 });

    // A routing rule only fires for a request that would otherwise ask (BOS-307, DR-001), so these cases use a
    // move (not a built-in allow) to show company-before-global and the owner's order.
    const global = (await c.req("POST", "/api/policy-rules", { companyId: null, name: "Container restarts go to the CEO", match: { commandPattern: "^docker\\s+restart\\b" }, outcome: "ceo" })).json();
    expect(await test("docker restart web", c.other.id, "move")).toEqual({ outcome: "ceo", rule: "Container restarts go to the CEO", row: 7 });
    const mine = (await c.req("POST", "/api/policy-rules", { companyId: c.company.id, name: "Homelab may restart containers", match: { commandPattern: "^docker\\s+restart\\b" }, outcome: "allow" })).json();
    expect(await test("docker restart web", c.company.id, "move")).toEqual({ outcome: "allow", rule: "Homelab may restart containers", row: 5 });
    expect(await test("docker restart web", c.other.id, "move")).toMatchObject({ outcome: "ceo" });

    // DR-001 row 4: a company deny beats a company allow whatever the owner's order between them.
    const deny = (await c.req("POST", "/api/policy-rules", { companyId: c.company.id, name: "No restarting the database", match: { commandPattern: "restart\\s+db" }, outcome: "deny" })).json();
    expect(await test("docker restart db", c.company.id, "move")).toEqual({ outcome: "deny", rule: "No restarting the database", row: 4 });
    // The owner's order still decides between two rules of the same kind: reorder so the allow is first, and it shows.
    const order = (await c.req("POST", "/api/policy-rules/order", { companyId: c.company.id, ids: [mine.id, deny.id] })).json();
    expect(order.map((r: { name: string }) => r.name)).toEqual(["Homelab may restart containers", "No restarting the database"]);
    expect(await test("docker restart db", c.company.id, "move")).toEqual({ outcome: "deny", rule: "No restarting the database", row: 4 });

    const list = (await c.req("GET", `/api/policy-rules?companyId=${c.company.id}`)).json();
    expect(list.company).toHaveLength(2);
    expect(list.global.map((r: { id: string }) => r.id)).toEqual([global.id]);
    expect(list.defaults.at(-1).name).toBe("Other shell commands");

    expect((await c.req("PATCH", `/api/policy-rules/${global.id}`, { outcome: "owner" })).json()).toMatchObject({ outcome: "owner" });
    expect((await c.req("DELETE", `/api/policy-rules/${deny.id}`)).statusCode).toBe(204);
    expect(await test("docker restart db", c.company.id, "move")).toMatchObject({ outcome: "allow" });
  });

  it("refuses a rule that would match nothing or can't be read, and says why", async () => {
    const c = await setup();
    const empty = await c.req("POST", "/api/policy-rules", { companyId: null, name: "Nothing", match: {}, outcome: "deny" });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().message).toMatch(/at least one condition/);
    const bad = await c.req("POST", "/api/policy-rules", { companyId: null, name: "Broken", match: { commandPattern: "([a-z" }, outcome: "deny" });
    expect(bad.json().message).toBe("The command pattern isn't a valid regular expression.");
    const kind = await c.req("POST", "/api/policy-rules", { companyId: null, name: "Typo", match: { kinds: ["exec"] }, outcome: "deny" });
    expect(kind.json().message).toMatch(/"exec" isn't a tool kind/);
    expect((await c.req("POST", "/api/policy-rules/order", { companyId: null, ids: [randomUUID()] })).statusCode).toBe(422);
  });

  it("decides a real permission request from the runner", async () => {
    const c = await setup();
    await c.req("POST", "/api/policy-rules", { companyId: c.company.id, name: "No package publishing at all", match: { commandPattern: "npm\\s+publish" }, outcome: "deny" });
    const reg = (await c.req("POST", `/api/companies/${c.company.id}/runner`)).json();
    const [runner] = await c.db.select().from(runners).where(eq(runners.id, reg.runnerId));
    const sent: RunnerCommand[] = [];
    c.runners.connect(runner!.id, (cmd) => (sent.push(cmd), true));
    const runId = randomUUID();
    await c.runners.ingest(runner!, { seq: 1, at: new Date().toISOString(), event: { type: "run.started", runId, agentId: c.ceo.id, acpSessionId: "s", model: null } });
    await c.runners.ingest(runner!, { seq: 2, at: new Date().toISOString(), event: { type: "run.permission_request", runId, requestId: "r1", title: "npm publish", kind: "execute", rawInput: { command: "npm publish" }, optionKinds: ["allow_once"] } });
    expect(sent).toEqual([{ type: "permission.decide", runId, requestId: "r1", verdict: "deny" }]);
  });
});

describe("secrets screen", () => {
  it("lists who a secret is granted to and each time a run was given it", async () => {
    const c = await setup();
    const { secret } = (await c.req("POST", "/api/secrets", { name: "GitHub", kind: "generic", value: "github_pat_example" })).json();
    await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: c.company.id, envName: "GIT_TOKEN" });
    await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: c.other.id, envName: "GIT_TOKEN" });
    const grants = (await c.req("GET", `/api/secrets/${secret.id}/grants`)).json();
    expect(grants.map((g: { company: string; envName: string }) => `${g.company}:${g.envName}`)).toEqual(["App Co:GIT_TOKEN", "Homelab Co:GIT_TOKEN"]);

    const runId = randomUUID();
    await c.secrets.resolveCompanyEnv(c.company.id, "run", runId);
    await c.secrets.resolveCompanyEnv(c.company.id, "merge");
    const log = (await c.req("GET", `/api/secrets/${secret.id}/access-log`)).json();
    expect(log.map((l: { company: string; purpose: string; runId: string | null }) => [l.company, l.purpose, l.runId])).toEqual([
      ["Homelab Co", "merge", null],
      ["Homelab Co", "run", runId],
    ]);
    // Rotating keeps the grants; the value itself never comes back.
    const rotated = (await c.req("PUT", `/api/secrets/${secret.id}/value`, { value: "github_pat_rotated" })).json();
    expect(JSON.stringify(rotated)).not.toContain("github_pat_rotated");
    expect((await c.req("GET", `/api/secrets/${secret.id}/grants`)).json()).toHaveLength(2);
  });
});
