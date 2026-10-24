import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

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
});
