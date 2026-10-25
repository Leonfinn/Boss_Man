import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const SECRET = "sk-live-SUPERSECRETVALUE-1234567890";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "Holiday Hours", mission: "Help people work out leave." })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Celebrimbor", template: "engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Run, Maintain, Deploy" })).json() as { id: string };
  return { req, company, worker, project };
}

describe("company export (docs/11, step 1)", () => {
  it("writes the set-up, wiki and open tickets to one zip, with secret names and grants but never values", async () => {
    const c = await setup();
    const [skill] = (await c.req("POST", `/api/companies/${c.company.id}/skills`, { from: "upload", files: [{ path: "deploy/SKILL.md", content: b64("---\ndescription: Deploys the site.\n---\nRun the script.") }, { path: "deploy/run.sh", content: b64("#!/bin/sh\necho hi") }] })).json();
    await c.req("PUT", `/api/companies/${c.company.id}/skills/${skill.id}/agents`, { agentIds: [c.worker.id] });
    const secret = (await c.req("POST", "/api/secrets", { name: "Gitea token", kind: "generic", value: SECRET })).json().secret.id as string;
    const grant = (await c.req("POST", `/api/secrets/${secret}/grants`, { companyId: c.company.id, envName: "GITEA_TOKEN" })).json() as { id: string };
    await c.req("PUT", `/api/grants/${grant.id}/agents`, { agentIds: [c.worker.id] });
    await c.req("POST", `/api/companies/${c.company.id}/wiki`, { folder: "Runbooks", title: "Deploy", body: "Thursday 23:00." });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix the notice wording", assigneeAgentId: c.worker.id });
    const done = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Old work" })).json() as { id: string };
    await c.req("PATCH", `/api/tickets/${done.id}`, { state: "done" });

    const res = await c.req("GET", `/api/companies/${c.company.id}/export?wiki=1&tickets=open`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="holiday-hours.bossman.zip"');
    const zip = unzipSync(new Uint8Array(res.rawPayload));
    expect(Object.keys(zip).sort()).toEqual(
      expect.arrayContaining(["manifest.json", "company.json", "agents/ceo/agent.json", "agents/celebrimbor/agent.json", "skills/deploy/SKILL.md", "skills/deploy/run.sh", "skills.json", "projects/run-maintain-deploy/project.json", "plan.json", "tool-servers.json", "secrets.json", "tickets.jsonl"]),
    );
    const read = (p: string) => JSON.parse(strFromU8(zip[p]!));
    expect(read("manifest.json")).toMatchObject({ format: "bossman-company/1", company: "Holiday Hours", includes: { wiki: true, tickets: "open" } });
    expect(read("company.json")).toMatchObject({ name: "Holiday Hours", mission: "Help people work out leave." });
    // A new company's CEO starts with the CEO template's instructions, not an empty box.
    expect(strFromU8(zip["agents/ceo/INSTRUCTIONS.md"]!)).toContain("You run the company for the owner");
    expect(read("skills.json")).toEqual([expect.objectContaining({ name: "deploy", agents: ["celebrimbor"] })]);
    expect(strFromU8(zip["skills/deploy/run.sh"]!)).toBe("#!/bin/sh\necho hi");
    expect(read("secrets.json")).toEqual([{ name: "Gitea token", kind: "generic", envName: "GITEA_TOKEN", agents: ["celebrimbor"] }]);
    expect(read("projects/run-maintain-deploy/project.json").columns.length).toBeGreaterThan(0);
    const wiki = Object.keys(zip).filter((p) => p.startsWith("wiki/"));
    expect(wiki).toHaveLength(1);
    expect(strFromU8(zip[wiki[0]!]!)).toContain("Thursday 23:00.");
    // Open tickets only, with who they're assigned to by folder name.
    const lines = strFromU8(zip["tickets.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([expect.objectContaining({ title: "Fix the notice wording", assignee: "celebrimbor", project: "run-maintain-deploy" })]);
    // The secret's value (and any part of it a hint might show) appears nowhere in the file.
    const all = Buffer.concat(Object.values(zip).map((b) => Buffer.from(b))).toString("latin1");
    expect(all).not.toContain("SUPERSECRET");
    expect(all).not.toContain("7890");
  });

  it("leaves out the wiki and tickets unless asked, and 404s an unknown company", async () => {
    const c = await setup();
    const zip = unzipSync(new Uint8Array((await c.req("GET", `/api/companies/${c.company.id}/export`)).rawPayload));
    expect(Object.keys(zip).some((p) => p.startsWith("wiki/") || p === "tickets.jsonl")).toBe(false);
    expect((await c.req("GET", "/api/companies/00000000-0000-4000-8000-000000000000/export")).statusCode).toBe(404);
  });
});
