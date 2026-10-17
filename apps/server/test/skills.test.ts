import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { notifications, runners } from "../src/db/schema.js";
import { cleanPath, normalise, parseGitHub, parseSkillMd, skillName } from "../src/services/skills.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

// A fake GitHub: a repo "acme/kit" whose skills/ folder holds two skills.
let commit = "1111111111111111111111111111111111111111";
const fetched: string[] = [];
const files: Record<string, string> = {
  "skills/release-notes/SKILL.md": "---\nname: release-notes\ndescription: >\n  Writes release notes\n  in our style.\n---\n\n# Release notes\n",
  "skills/release-notes/templates/entry.md": "- {change}",
  "skills/triage/SKILL.md": "---\nname: triage\ndescription: \"Sorts bug reports by severity.\"\n---\nSteps.\n",
  "README.md": "Kit",
};
const fakeFetch = (async (input: string | URL) => {
  const url = String(input);
  fetched.push(url);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url === "https://api.github.com/repos/acme/kit") return json({ default_branch: "main" });
  if (url === "https://api.github.com/repos/acme/kit/commits/main") return json({ sha: commit });
  if (url.startsWith(`https://api.github.com/repos/acme/kit/git/trees/${commit}`)) return json({ tree: Object.keys(files).map((p) => ({ path: p, type: "blob", size: files[p]!.length })) });
  const raw = `https://raw.githubusercontent.com/acme/kit/${commit}/`;
  if (url.startsWith(raw) && files[url.slice(raw.length)] !== undefined) return new Response(files[url.slice(raw.length)]);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, workspaceRoot: "/ws", fetch: fakeFetch });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  const mcp = async (runId: string, agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, worker, project, sent, emit, starts, mcp, ceo };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("skill files (R71)", () => {
  it("reads SKILL.md frontmatter, including folded and quoted values", () => {
    expect(parseSkillMd(files["skills/release-notes/SKILL.md"]!)).toMatchObject({ name: "release-notes", description: "Writes release notes in our style." });
    expect(parseSkillMd(files["skills/triage/SKILL.md"]!).description).toBe("Sorts bug reports by severity.");
    expect(parseSkillMd("# Title\n\nNo frontmatter here.")).toMatchObject({ name: null, description: "No frontmatter here." });
    expect(skillName("My Great Skill!")).toBe("my-great-skill");
  });

  it("parses GitHub links and refuses paths outside the folder", () => {
    expect(parseGitHub("https://github.com/acme/kit")).toEqual({ owner: "acme", repo: "kit", ref: null, path: "" });
    expect(parseGitHub("https://github.com/acme/kit/tree/main/skills/triage")).toEqual({ owner: "acme", repo: "kit", ref: "main", path: "skills/triage" });
    expect(parseGitHub("https://github.com/acme/kit/blob/v2/skills/triage/SKILL.md")).toEqual({ owner: "acme", repo: "kit", ref: "v2", path: "skills/triage" });
    expect(parseGitHub("https://gitlab.com/acme/kit")).toBeNull();
    expect(cleanPath("../etc/passwd")).toBeNull();
    expect(cleanPath("a/./b.md")).toBe("a/b.md");
    // An uploaded folder's top folder is taken off and becomes the name.
    expect(normalise([{ path: "my-skill/SKILL.md", content: b64("x") }, { path: "my-skill/x.py", content: b64("y") }])).toMatchObject({ folder: "my-skill", files: [{ path: "SKILL.md" }, { path: "x.py" }] });
    expect(() => normalise([{ path: "notes.md", content: b64("x") }])).toThrow(/SKILL.md/);
  });
});

describe("skills library (R71)", () => {
  it("adds every skill under a GitHub link, pinned to a commit, and checks for updates", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const added = await c.req("POST", base, { from: "link", url: "https://github.com/acme/kit/tree/main/skills" });
    expect(added.statusCode).toBe(201);
    expect(added.json().map((s: { name: string }) => s.name).sort()).toEqual(["release-notes", "triage"]);
    const list = (await c.req("GET", base)).json();
    const notes = list.find((s: { name: string }) => s.name === "release-notes");
    expect(notes).toMatchObject({ source: "link", sourceRef: commit, sourceUrl: "https://github.com/acme/kit/tree/main/skills/release-notes", fileCount: 2, description: "Writes release notes in our style." });
    const one = (await c.req("GET", `${base}/${notes.id}`)).json();
    expect(one.files.map((f: { path: string; text: string }) => [f.path, f.text])).toEqual([
      ["SKILL.md", files["skills/release-notes/SKILL.md"]],
      ["templates/entry.md", "- {change}"],
    ]);
    // The same link again clashes; a check with no new commit changes nothing.
    expect((await c.req("POST", base, { from: "link", url: "https://github.com/acme/kit/tree/main/skills/triage" })).statusCode).toBe(409);
    expect((await c.req("POST", `${base}/${notes.id}/refresh`)).json()).toEqual({ changed: false, sourceRef: commit });
    const before = commit;
    commit = "2222222222222222222222222222222222222222";
    files["skills/release-notes/templates/entry.md"] = "* {change}";
    expect((await c.req("POST", `${base}/${notes.id}/refresh`)).json()).toEqual({ changed: true, sourceRef: commit });
    commit = before;
    expect((await c.req("POST", base, { from: "link", url: "https://github.com/acme/nothing" })).statusCode).toBe(404);
  });

  it("writes and uploads skills, and gives them to agents' runs", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const [written] = (await c.req("POST", base, { from: "written", name: "House Style", description: "How we write: short sentences, UK spelling.", body: "# House style\n\nUse UK spelling." })).json();
    expect(written.name).toBe("house-style");
    expect((await c.req("POST", base, { from: "upload", files: [{ path: "deploy/SKILL.md", content: b64("---\ndescription: Deploys to staging.\n---\nRun make deploy.") }, { path: "deploy/run.sh", content: b64("#!/bin/sh") }] })).json()).toEqual([expect.objectContaining({ name: "deploy" })]);
    // No frontmatter: the first line is the description, as Claude Code does.
    expect((await c.req("POST", base, { from: "upload", files: [{ path: "SKILL.md", content: b64("Checks links.") }], name: "Link Check" })).json()).toEqual([expect.objectContaining({ name: "link-check" })]);
    expect((await c.req("POST", base, { from: "upload", files: [{ path: "SKILL.md", content: b64("---\nname: empty\n---\n") }] })).statusCode).toBe(400);
    expect((await c.req("POST", base, { from: "upload", files: [{ path: "a/../../x/SKILL.md", content: b64("x") }] })).statusCode).toBe(400);

    expect((await c.req("PUT", `${base}/${written.id}/agents`, { agentIds: [c.worker.id] })).statusCode).toBe(200);
    expect((await c.req("GET", base)).json().find((s: { name: string }) => s.name === "house-style").agents).toEqual([{ id: c.worker.id, name: "Engineer" }]);
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Write the changelog", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const start = c.starts().find((s) => s.agentId === c.worker.id)!;
    expect(start.skills).toEqual([{ name: "house-style", files: [{ path: "SKILL.md", content: expect.any(String) }] }]);
    expect(Buffer.from(start.skills![0]!.files[0]!.content, "base64").toString()).toContain("description: \"How we write: short sentences, UK spelling.\"");
  });

  it("lets the CEO give and take skills, and tells the owner", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/companies/${c.company.id}/skills`, { from: "written", name: "triage", description: "Sorts bug reports.", body: "Steps." });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Anything", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const runId = c.starts()[0]!.runId;
    const asWorker = await c.mcp(runId, c.worker.id);
    expect(textOf(await asWorker.callTool({ name: "skills", arguments: { action: "give", skill: "triage", agent: "Engineer" } }))).toBe("Only your company's CEO can give or take skills.");
    await asWorker.close();
    const asCeo = await c.mcp(runId, c.ceo.id);
    expect(textOf(await asCeo.callTool({ name: "skills", arguments: { action: "give", skill: "triage", agent: "engineer" } }))).toBe("Engineer has the triage skill from their next run.");
    expect(JSON.parse(textOf(await asCeo.callTool({ name: "skills", arguments: { action: "list" } })))).toEqual([{ name: "triage", description: "Sorts bug reports.", agents: ["Engineer"] }]);
    expect(await asCeo.callTool({ name: "skills", arguments: { action: "give", skill: "nope", agent: "Engineer" } })).toMatchObject({ isError: true });
    await asCeo.callTool({ name: "skills", arguments: { action: "take", skill: "triage", agent: "Engineer" } });
    await asCeo.close();
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toEqual(expect.arrayContaining(["The CEO gave Engineer the triage skill", "The CEO took the triage skill from Engineer"]));
  });
});
