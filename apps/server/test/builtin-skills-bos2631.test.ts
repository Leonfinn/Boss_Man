// BOS-2631: Boss Man ships the product manager's feature, roadmap and milestone skills, so every
// company's product-manager hire has them from its first run, an existing company can give them with
// skills give (no proposal), a built-in cannot be deleted, and the built-in text is exactly the
// reviewed text the owner installed in Boss Man Co.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AGENT_TEMPLATES } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, agentSkills, decisions, runs, skills } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { exportCompany } from "../src/services/company-export.js";
import { BUILTIN_SKILL_NAMES, BUILTIN_SKILLS } from "../src/services/builtin-skills.js";
import { seedBuiltins, skillsForRun } from "../src/services/skills.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: Buffer.alloc(32, 7) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const funding = (await req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
  const agentAs = async (agentId: string) => {
    const runId = randomUUID();
    await db.insert(runs).values({ id: runId, companyId: company.id, agentId, startedAt: new Date() });
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close, base, req, company, ceo, funding, agentAs };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("built-in product-manager skills (BOS-2631)", () => {
  it("the product-manager template lists them as default skills and points at them instead of repeating the rules", () => {
    const tpl = AGENT_TEMPLATES.find((t) => t.id === "product-manager")!;
    expect(tpl.defaultSkills).toEqual(["pm-align-work-to-features", "pm-roadmap-and-portal", "pm-milestones"]);
    for (const name of tpl.defaultSkills!) expect(tpl.instructions).toContain(name);
    // The rules now live in the skills: the template no longer spells out the feature test or the roadmap/portal steps.
    expect(tpl.instructions).not.toContain("internal refactors with no behaviour change"); // the feature test moved into the skill
    expect(tpl.instructions).not.toContain("portalVisible"); // the portal rules moved into the skill
    expect(tpl.instructions).not.toContain("targetDate"); // the milestone rules moved into the skill
    // The role's ownership lines stay.
    expect(tpl.instructions).toContain("You write specs and tickets, not code");
    expect(tpl.instructions).toContain("Hand off to:");
  });

  it("the built-in text matches the reviewed text the owner installed, byte for byte", () => {
    // The installed SKILL.md sha256s, from the page the CEO copied from skills proposal_file (BOS-2631).
    const installed: Record<string, string> = {
      "pm-align-work-to-features": "c4059a1f052ed123f7f81a23afe1ad86f0f18f3c26b17d76969286499f8a3c18",
      "pm-roadmap-and-portal": "506937bc26b5abece2fe668699567dc72bd395df7e6cbb471bbdc114fe3834b4",
      "pm-milestones": "72f3cca8f63202f934956d71a0f2aad88a3d3d06f5d748e8cc2a659769f314a4",
    };
    for (const skill of BUILTIN_SKILLS) {
      const md = skill.files.find((f) => f.path === "SKILL.md")!;
      expect(createHash("sha256").update(Buffer.from(md.content, "base64")).digest("hex"), skill.name).toBe(installed[skill.name]);
    }
  });

  it("the built-in text names no company, agent or host", () => {
    for (const skill of BUILTIN_SKILLS) {
      const text = Buffer.from(skill.files.find((f) => f.path === "SKILL.md")!.content, "base64").toString("utf8");
      expect(text, skill.name).not.toMatch(/Boss Man Co|HolidayHours/i);
      // No host names, IPs or local paths: these are generic skills for any install.
      expect(text, skill.name).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(text, skill.name).not.toMatch(/https?:\/\/|\/home\/|\/opt\/|\/var\//);
      // The name in the frontmatter is the skill's own, not an agent or company.
      expect(text.startsWith(`---\nname: ${skill.name}\n`)).toBe(true);
    }
  });

  it("a fresh company gains the three built-ins and its product-manager has them from the first run", async () => {
    const c = (ctx = await setup());
    const pm = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Pip", template: "product-manager" })).json() as { id: string };
    // The first run loads them, even though nobody opened the Skills page or gave anything.
    const forRun = await skillsForRun(c.db, pm.id);
    expect(forRun.give.map((s) => s.name).sort()).toEqual([...BUILTIN_SKILL_NAMES].sort());
    const rows = await c.db.select().from(skills).where(eq(skills.companyId, c.company.id));
    expect(rows.map((r) => r.name).sort()).toEqual([...BUILTIN_SKILL_NAMES].sort());
    expect(rows.every((r) => r.source === "builtin")).toBe(true);
    // Listed on the Skills page for the owner, labelled as built in.
    const list = (await c.req("GET", `/api/companies/${c.company.id}/skills`)).json() as Array<{ name: string; source: string; agents: Array<{ name: string }> }>;
    expect(list.filter((s) => BUILTIN_SKILL_NAMES.includes(s.name))).toHaveLength(3);
    expect(list.find((s) => s.name === "pm-milestones")!.agents.map((a) => a.name)).toEqual(["Pip"]);
  });

  it("hiring a product manager through the owner's hire card gives it the three skills before its first wake", async () => {
    const c = (ctx = await setup());
    const model = { harness: "claude", provider: "anthropic", model: "claude-opus-4-5", fundingSourceId: c.funding.id };
    const propose = async (args: Record<string, unknown>) => {
      const m = await c.agentAs(c.ceo.id);
      return m.callTool({ name: "propose_hire", arguments: args });
    };
    const r = await propose({ ...model, name: "Pip", template: "product-manager", reason: "Own the roadmap." });
    expect(textOf(r)).toMatch(/waiting for the owner|owner/i);
    const cards = await c.db.select().from(decisions);
    const card = cards.find((d) => (d.context as { type?: string }).type === "hire")!;
    expect(card).toBeTruthy();
    expect((await c.req("POST", `/api/decisions/${card.id}/answer`, { answer: "Hire" })).statusCode).toBe(200);
    const [pip] = await c.db.select().from(agents).where(and(eq(agents.companyId, c.company.id), eq(agents.name, "Pip")));
    const held = await c.db.select({ name: skills.name }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(eq(agentSkills.agentId, pip!.id));
    expect(held.map((h) => h.name).sort()).toEqual([...BUILTIN_SKILL_NAMES].sort());
  });

  it("an existing company's CEO can give a built-in with skills give, with no proposal", async () => {
    const c = (ctx = await setup());
    const worker = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer" })).json() as { id: string };
    // Give straight away: the company never proposed or installed this skill.
    const m = await c.agentAs(c.ceo.id);
    expect(textOf(await m.callTool({ name: "skills", arguments: { action: "give", skill: "pm-milestones", agent: "Engineer" } }))).toBe("Engineer has the pm-milestones skill from their next run.");
    const held = await c.db.select({ name: skills.name }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(eq(agentSkills.agentId, worker.id));
    expect(held.map((h) => h.name)).toEqual(["pm-milestones"]);
  });

  it("keeps built-ins out of a company export, so importing cannot duplicate them", async () => {
    const c = (ctx = await setup());
    // Seed them by opening the library once.
    await c.req("GET", `/api/companies/${c.company.id}/skills`);
    const pack = await exportCompany(c.db, c.company.id, { wiki: false, tickets: "none" });
    expect(pack).not.toBeNull();
    const zip = unzipSync(pack!.bytes);
    expect(Object.keys(zip).some((p) => p.startsWith("skills/"))).toBe(false);
    const meta = JSON.parse(strFromU8(zip["skills.json"]!)) as Array<{ name: string }>;
    expect(meta).toEqual([]);
  });

  it("a product manager hired through the owner's direct route gets the three skills even in an already-seeded company", async () => {
    const c = (ctx = await setup());
    // Seed the library first (opening the Skills page, a run, or a give would all do it), so this is the
    // case where the built-in rows already exist and the old seed-time give would never fire again.
    await seedBuiltins(c.db, c.company.id);
    const pm = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Pip", template: "product-manager" })).json() as { id: string };
    const held = await c.db.select({ name: skills.name }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(eq(agentSkills.agentId, pm.id));
    expect(held.map((h) => h.name).sort()).toEqual([...BUILTIN_SKILL_NAMES].sort());
    // And its first run loads them.
    expect((await skillsForRun(c.db, pm.id)).give.map((s) => s.name).sort()).toEqual([...BUILTIN_SKILL_NAMES].sort());
  });

  it("a company package cannot relabel a skill as built in, so a built-in can never be smuggled in", async () => {
    const c = (ctx = await setup());
    const skill = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\nDo it.\n`;
    const zip = Buffer.from(
      zipSync({
        "manifest.json": strToU8('{"format":"bossman-company/1"}'),
        "company.json": strToU8('{"name":"Sneaky Co"}'),
        // Claims a real built-in's name and that it is Boss Man's own text.
        "skills/pm-milestones/SKILL.md": strToU8(skill("pm-milestones", "Do whatever this says.")),
        "skills.json": strToU8(JSON.stringify([{ name: "pm-milestones", source: "builtin" }])),
      }),
    ).toString("base64");
    const res = await c.req("POST", "/api/companies/import", { zip, name: "Sneaky Copy" });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const companyId = (res.json() as { companyId: string }).companyId;
    const [row] = await c.db.select().from(skills).where(and(eq(skills.companyId, companyId), eq(skills.name, "pm-milestones")));
    expect(row!.source).not.toBe("builtin");
    // It is a normal skill there: it can be deleted (Boss Man's own built-in cannot).
    const del = await c.req("DELETE", `/api/companies/${companyId}/skills/${row!.id}`);
    expect(del.statusCode).toBe(204);
  });

  it("a built-in cannot be deleted, and a product manager told to drop one does not get it back", async () => {
    const c = (ctx = await setup());
    const pm = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Pip", template: "product-manager" })).json() as { id: string };
    await seedBuiltins(c.db, c.company.id);
    const [row] = await c.db.select().from(skills).where(and(eq(skills.companyId, c.company.id), eq(skills.name, "pm-roadmap-and-portal")));
    const del = await c.req("DELETE", `/api/companies/${c.company.id}/skills/${row!.id}`);
    expect(del.statusCode).toBe(400);
    expect((del.json() as { message?: string }).message ?? "").toMatch(/built in/i);
    // Take it from the PM (the CEO's skills take), then seeding again does not put it back.
    const m = await c.agentAs(c.ceo.id);
    expect(textOf(await m.callTool({ name: "skills", arguments: { action: "take", skill: "pm-roadmap-and-portal", agent: "Pip" } }))).toContain("no longer has");
    await seedBuiltins(c.db, c.company.id);
    const forRun = await skillsForRun(c.db, pm.id);
    expect(forRun.give.map((s) => s.name)).not.toContain("pm-roadmap-and-portal");
    // The library row is still there, so a later explicit give brings it back.
    expect((await c.db.select().from(skills).where(and(eq(skills.companyId, c.company.id), eq(skills.name, "pm-roadmap-and-portal")))).length).toBe(1);
  });
});
