import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

// No real DNS: public names resolve to a public address, "rebind" names to the stack's, anything else fails.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "tools.example.org") return [{ address: "93.184.216.34", family: 4 }];
    if (host === "rebind.example.org") return [{ address: "172.18.0.2", family: 4 }];
    if (host === "rebind6.example.org") return [{ address: "fd00::2", family: 6 }];
    throw new Error("ENOTFOUND");
  },
}));

const b64 = (s: string) => Buffer.from(s).toString("base64");

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { req };
}

describe("company import (docs/11, step 2)", () => {
  it("previews, then recreates an exported company as a new one: paused agents, remapped reviewers, no secrets", async () => {
    const { req } = await setup();
    const { company } = (await req("POST", "/api/companies", { name: "Holiday Hours", mission: "Help people work out leave." })).json() as { company: { id: string } };
    const cid = company.id;
    const worker = (await req("POST", `/api/companies/${cid}/agents`, { name: "Celebrimbor", template: "engineer" })).json() as { id: string };
    const policy = (await req("GET", `/api/companies/${cid}/review-policy`)).json();
    expect((await req("PUT", `/api/companies/${cid}/review-policy`, { ...policy, medium: { ...policy.medium, reviewer: worker.id } })).statusCode).toBe(200);
    const [skill] = (await req("POST", `/api/companies/${cid}/skills`, { from: "upload", files: [{ path: "deploy/SKILL.md", content: b64("---\ndescription: Deploys the site.\n---\nRun the script.") }, { path: "deploy/run.sh", content: b64("#!/bin/sh\necho hi") }] })).json();
    await req("PUT", `/api/companies/${cid}/skills/${skill.id}/agents`, { agentIds: [worker.id] });
    const secret = (await req("POST", "/api/secrets", { name: "Gitea token", kind: "generic", value: "sk-live-abc-1234567890" })).json().secret.id as string;
    await req("POST", `/api/secrets/${secret}/grants`, { companyId: cid, envName: "GITEA_TOKEN" });
    const project = (await req("POST", `/api/companies/${cid}/projects`, { name: "Run, Maintain, Deploy" })).json() as { id: string };
    const objective = (await req("POST", `/api/companies/${cid}/objectives`, { title: "Grow sign-ups", projectId: project.id })).json() as { id: string };
    await req("POST", `/api/objectives/${objective.id}/milestones`, { title: "Launch" });
    const a = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Write the notice", assigneeAgentId: worker.id })).json() as { id: string };
    const b = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Publish the notice" })).json() as { id: string };
    expect((await req("POST", `/api/tickets/${b.id}/dependencies`, { ticketId: a.id })).statusCode).toBe(201);
    await req("POST", `/api/companies/${cid}/wiki`, { folder: "Runbooks", title: "Deploy", body: "Thursday 23:00." });
    const zip = Buffer.from((await req("GET", `/api/companies/${cid}/export?wiki=1&tickets=all`)).rawPayload).toString("base64");

    // The name is taken on this server, so the preview says so and applying it refuses.
    const pre = (await req("POST", "/api/companies/import/preview", { zip })).json();
    expect(pre.company).toEqual({ name: "Holiday Hours", nameTaken: true });
    expect(pre.counts).toMatchObject({ skills: 1, projects: 1, objectives: 1, wikiPages: 1, tickets: 2 });
    expect(pre.skills).toEqual([expect.objectContaining({ name: "deploy", scripts: ["run.sh"] })]);
    expect(pre.secrets).toEqual([{ name: "Gitea token", envName: "GITEA_TOKEN", agents: [] }]);
    expect((await req("POST", "/api/companies/import", { zip })).statusCode).toBe(409);

    const res = await req("POST", "/api/companies/import", { zip, name: "Holiday Hours Copy" });
    expect(res.statusCode).toBe(201);
    const { companyId, checklist } = res.json() as { companyId: string; checklist: string[] };
    expect(checklist).toEqual(expect.arrayContaining(['Add the secret "Gitea token" and grant it as GITEA_TOKEN.', "Read the scripts in the skill deploy before agents use it."]));

    const copy = ((await req("GET", "/api/companies")).json() as Array<{ id: string; name: string; mission: string; agents: Array<{ id: string; name: string; paused: boolean }> }>).find((c) => c.id === companyId)!;
    expect(copy).toMatchObject({ name: "Holiday Hours Copy", mission: "Help people work out leave." });
    expect(copy.agents.map((x) => x.name).sort()).toEqual(["CEO", "Celebrimbor", "Wiki Maintainer"].sort());
    expect(copy.agents.every((x) => x.paused)).toBe(true);
    const newWorker = copy.agents.find((x) => x.name === "Celebrimbor")!;
    // The medium reviewer was the old Celebrimbor; it is now the new one.
    expect((await req("GET", `/api/companies/${companyId}/review-policy`)).json().medium.reviewer).toBe(newWorker.id);
    // Exporting the copy gives back the same skills, holders and tickets, dependencies included.
    const unpack = async (id: string) => unzipSync(new Uint8Array((await req("GET", `/api/companies/${id}/export?wiki=1&tickets=all`)).rawPayload));
    const [before, after] = [await unpack(cid), await unpack(companyId)];
    const tix = (z: Record<string, Uint8Array>) => strFromU8(z["tickets.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l)).map(({ title, assignee, state, project, waitsOn }) => ({ title, assignee, state, project, waits: waitsOn.length }));
    expect(tix(after)).toEqual(tix(before));
    expect(tix(after)).toContainEqual(expect.objectContaining({ title: "Publish the notice", waits: 1 }));
    expect(strFromU8(after["skills.json"]!)).toBe(strFromU8(before["skills.json"]!));
    expect(JSON.parse(strFromU8(after["plan.json"]!)).objectives[0]).toMatchObject({ title: "Grow sign-ups", project: "run-maintain-deploy", milestones: [expect.objectContaining({ title: "Launch" })] });
    // No secret was created or granted.
    expect(((await req("GET", "/api/secrets")).json() as unknown[]).length).toBe(1);
    const wiki = (await req("GET", `/api/companies/${companyId}/wiki`)).json();
    expect(JSON.stringify(wiki)).toContain("Deploy");
    const decisions = JSON.stringify((await req("GET", "/api/decisions")).json());
    expect(decisions).toContain("Holiday Hours Copy was imported");
  });

  // BOS-198: lists of reviewers survive the trip, and an older package's "marked" cells name its marked agent.
  it("remaps reviewer lists and an older package's marked reviewers", async () => {
    const { req } = await setup();
    const { company } = (await req("POST", "/api/companies", { name: "Lists Co" })).json() as { company: { id: string } };
    const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Ann", template: "engineer" })).json() as { id: string };
    const policy = (await req("GET", `/api/companies/${company.id}/review-policy`)).json();
    expect((await req("PUT", `/api/companies/${company.id}/review-policy`, { ...policy, medium: { ...policy.medium, kinds: { security: [worker.id] } } })).statusCode).toBe(200);
    const files = unzipSync(new Uint8Array((await req("GET", `/api/companies/${company.id}/export`)).rawPayload));
    // Make it look older: a list naming an agent the package lacks, a "marked" cell and the agent's mark.
    const co = JSON.parse(strFromU8(files["company.json"]!));
    co.reviewPolicy.medium.kinds = { security: [worker.id, "99999999-9999-4999-8999-999999999999"], infra: "marked" };
    co.name = "Lists Copy";
    files["company.json"] = strToU8(JSON.stringify(co));
    const agentFile = Object.keys(files).find((k) => k.endsWith("agent.json") && strFromU8(files[k]!).includes('"Ann"'))!;
    files[agentFile] = strToU8(JSON.stringify({ ...JSON.parse(strFromU8(files[agentFile]!)), reviewKind: "infra" }));
    const res = await req("POST", "/api/companies/import", { zip: Buffer.from(zipSync(files)).toString("base64") });
    expect(res.statusCode).toBe(201);
    const { companyId } = res.json() as { companyId: string };
    const ann = ((await req("GET", "/api/companies")).json() as Array<{ id: string; agents: Array<{ id: string; name: string }> }>).find((c) => c.id === companyId)!.agents.find((a) => a.name === "Ann")!;
    expect((await req("GET", `/api/companies/${companyId}/review-policy`)).json().medium.kinds).toEqual({ security: [ann.id], infra: ann.id });
  });

  it("previews each tool server's host:port and refuses ones aimed at Boss Man's own services unless ticked", async () => {
    const { req } = await setup();
    const server = (name: string, url: string) => ({ name, url, transport: "http" });
    const pack = (servers: unknown[]) => Buffer.from(zipSync({ "manifest.json": strToU8('{"format":"bossman-company/1"}'), "company.json": strToU8('{"name":"Tools Co"}'), "tool-servers.json": strToU8(JSON.stringify(servers)) })).toString("base64");

    const fine = pack([server("pen", "https://tools.example.org/mcp"), server("pub", "http://8.8.8.8:80/mcp")]);
    const pre = (await req("POST", "/api/companies/import/preview", { zip: fine })).json();
    expect(pre.toolServers).toEqual([
      { name: "pen", url: "https://tools.example.org/mcp", opens: "tools.example.org:443", stackService: false },
      { name: "pub", url: "http://8.8.8.8:80/mcp", opens: "8.8.8.8:80", stackService: false },
    ]);
    expect((await req("POST", "/api/companies/import", { zip: fine })).statusCode).toBe(201);

    // Stack names (incl. blue-green overlay), container names, loopback, IP literals (incl. a LAN host), names resolving to private
    // addresses, and a name whose lookup fails: flagged in the preview, refused on import.
    for (const url of ["http://db:5432/mcp", "http://launcher:3105/x", "http://LAUNCHER:9/x", "http://netguard:80/", "http://server:3100/mcp", "http://runner-app-co:1/",
      "http://server-blue:3100/", "http://proxy:80/", "http://boss-man-db-1:5432/", "http://localhost:5432/", "http://127.0.0.1:5432/", "http://host.docker.internal:80/",
      "http://172.18.0.2:5432/", "http://10.0.0.5:1/", "http://192.168.68.20:11235/mcp", "http://169.254.169.254/", "http://[::1]:5432/",
      "http://rebind.example.org/", "http://rebind6.example.org/", "http://nxdomain.example.org/"]) {
      const bad = pack([server("sneaky", url)]);
      expect((await req("POST", "/api/companies/import/preview", { zip: bad })).json().toolServers[0].stackService, url).toBe(true);
      const refused = await req("POST", "/api/companies/import", { zip: bad, name: "Bad" });
      expect(refused.statusCode, url).toBe(400);
      expect(refused.json().message).toContain("Boss Man's own services");
      expect((await req("POST", "/api/companies/import", { zip: bad, name: "Bad", allowStackServices: false })).statusCode, url).toBe(400);
    }
    const ticked = await req("POST", "/api/companies/import", { zip: pack([server("db", "http://db:5432/")]), name: "Ticked", allowStackServices: true });
    expect(ticked.statusCode).toBe(201);
    const names = ((await req("GET", "/api/companies")).json() as Array<{ name: string }>).map((c) => c.name);
    expect(names).not.toContain("Bad");
  });

  it("refuses files that aren't a safe Boss Man package", async () => {
    const { req } = await setup();
    const send = (files: Record<string, string>) => req("POST", "/api/companies/import/preview", { zip: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))).toString("base64") });
    expect((await req("POST", "/api/companies/import/preview", { zip: b64("not a zip") })).statusCode).toBe(400);
    expect((await send({ "manifest.json": '{"format":"agent-companies/1"}', "company.json": '{"name":"X"}' })).json().message).toContain("isn't a Boss Man company package");
    const ok = { "manifest.json": '{"format":"bossman-company/1"}', "company.json": '{"name":"X"}' };
    expect((await send({ ...ok, "../escape.txt": "x" })).json().message).toContain("isn't a safe path");
    expect((await send({ ...ok, "projects/p/project.json": JSON.stringify({ name: "P", repoUrl: "https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b.git", columns: [{ name: "To do", systemState: "backlog" }] }) })).statusCode).toBe(400);
    expect((await send(ok)).statusCode).toBe(200);
  });

  it("starts a new company with the watchdog on, and an import keeps it on however the package asked (BOS-762)", async () => {
    const { req } = await setup();
    const enabledOf = async (companyId: string) => ((await req("GET", `/api/companies/${companyId}/watchdog`)).json() as { settings: { enabled: boolean } }).settings.enabled;
    const exportOf = async (companyId: string) => unzipSync(new Uint8Array((await req("GET", `/api/companies/${companyId}/export`)).rawPayload));

    // A new company starts with the watchdog on, and its export carries that switch.
    const { company } = (await req("POST", "/api/companies", { name: "Watched Co" })).json() as { company: { id: string } };
    expect(await enabledOf(company.id)).toBe(true);
    const files = await exportOf(company.id);
    expect(JSON.parse(strFromU8(files["company.json"]!)).watchdog).toEqual({ enabled: true });

    // A package whose owner switched it off imports with it on, and the checklist says so in plain words.
    const co = JSON.parse(strFromU8(files["company.json"]!));
    const off = { ...files, "company.json": strToU8(JSON.stringify({ ...co, name: "Off Co", watchdog: { enabled: false } })) };
    const res = await req("POST", "/api/companies/import", { zip: Buffer.from(zipSync(off)).toString("base64") });
    expect(res.statusCode).toBe(201);
    const { companyId, checklist } = res.json() as { companyId: string; checklist: string[] };
    expect(await enabledOf(companyId)).toBe(true);
    expect(checklist).toContain("Kept on: the Scrum Master watchdog, which checks the board for stuck work. The package had it switched off. To change it, use Settings → Watchdog.");

    // A package that kept it on imports with no such line.
    const on = { ...files, "company.json": strToU8(JSON.stringify({ ...co, name: "On Co" })) };
    const ok = (await req("POST", "/api/companies/import", { zip: Buffer.from(zipSync(on)).toString("base64") })).json() as { checklist: string[] };
    expect(ok.checklist.filter((l) => l.includes("Scrum Master watchdog"))).toEqual([]);

    // The company that made the package is unchanged: an existing company's switch is its own.
    expect(await enabledOf(company.id)).toBe(true);
    await req("PATCH", `/api/companies/${company.id}/watchdog`, { enabled: false });
    expect(await enabledOf(company.id)).toBe(false);
    await req("POST", "/api/companies/import", { zip: Buffer.from(zipSync(on)).toString("base64"), name: "Another Co" });
    expect(await enabledOf(company.id)).toBe(false);
  });
});
