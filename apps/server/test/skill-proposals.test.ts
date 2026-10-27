import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, skills } from "../src/db/schema.js";
import { hashFiles, scriptFilesOf, skillProposalsService } from "../src/services/skill-proposals.js";
import { skillsService } from "../src/services/skills.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const md = (extra = "") => `---\nname: tidy\ndescription: Tidies notes.\n---\n${extra}`;

// A fake GitHub repo "acme/kit" with one skill; `repo.files` can change between calls.
const repo = { commit: "1".repeat(40), files: { "tidy/SKILL.md": md("Steps."), "tidy/notes.md": "n" } as Record<string, string> };
const fakeFetch = (async (input: string | URL) => {
  const url = String(input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  if (url === "https://api.github.com/repos/acme/kit") return json({ default_branch: "main" });
  if (url.startsWith("https://api.github.com/repos/acme/kit/commits/")) return json({ sha: repo.commit });
  if (url.includes("/repos/acme/kit/git/trees/")) return json({ tree: Object.entries(repo.files).map(([path, c]) => ({ path, type: "blob", size: c.length })) });
  const raw = /^https:\/\/raw\.githubusercontent\.com\/acme\/kit\/[0-9a-f]{40}\/(.*)$/.exec(url);
  if (raw && repo.files[decodeURIComponent(raw[1]!)] !== undefined) return new Response(repo.files[decodeURIComponent(raw[1]!)]);
  return new Response("", { status: 404 });
}) as typeof fetch;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: fakeFetch });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const sk = skillsService(db, { fetch: fakeFetch });
  const svc = skillProposalsService(db, sk);
  return { ...built, db, close, company, ceo, worker, svc };
}

describe("script detection", () => {
  const f = (path: string, content: string) => ({ path, content: b64(content) });
  it("flags executable and interpreted files, and run-able code blocks", () => {
    expect(scriptFilesOf([f("SKILL.md", md("text only"))])).toEqual([]);
    expect(scriptFilesOf([f("SKILL.md", md()), f("a.py", "print(1)")])).toEqual(["a.py"]);
    expect(scriptFilesOf([f("SKILL.md", md()), f("scripts/go", "x")])).toEqual(["scripts/go"]);
    expect(scriptFilesOf([f("SKILL.md", md()), f("tool", "#!/bin/sh\necho")])).toEqual(["tool"]);
    expect(scriptFilesOf([f("SKILL.md", md()), f("Makefile", "all:")])).toEqual(["Makefile"]);
    expect(scriptFilesOf([f("SKILL.md", md("```bash\nls\n```"))])).toEqual(["SKILL.md"]);
    expect(scriptFilesOf([f("SKILL.md", md("Run this:\n\n```\nls\n```"))])).toEqual(["SKILL.md"]);
    expect(scriptFilesOf([f("SKILL.md", md("Example output:\n```\nok\n```"))])).toEqual([]);
    expect(scriptFilesOf([f("SKILL.md", md()), { path: "bin", content: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]).toString("base64") }])).toEqual(["bin"]);
  });
  it("hashes change with any byte", () => {
    const a = hashFiles([{ path: "SKILL.md", content: b64("a") }]);
    expect(a.bundleHash).not.toBe(hashFiles([{ path: "SKILL.md", content: b64("b") }]).bundleHash);
    expect(a.fileHashes["SKILL.md"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("propose", () => {
  it("a CEO draft with no script skips review and logs why", async () => {
    const c = (ctx = await setup());
    const p = await c.svc.propose({ companyId: c.company.id, byAgentId: c.ceo.id, source: "draft", files: [{ path: "SKILL.md", content: b64(md("Steps.")) }], why: "Notes are messy", agentIds: [c.worker.id] });
    expect(p).toMatchObject({ hasScripts: false, reviewRequired: false, status: "proposed", name: "tidy" });
    const log = await c.db.select().from(activity);
    expect(log.some((l) => l.kind === "skill.proposed" && /No security review needed: CEO draft with no scripts/.test(l.summary))).toBe(true);
    expect(await c.db.select().from(skills).where(eq(skills.companyId, c.company.id))).toHaveLength(0);
  });

  it("a CEO draft with a script is marked for review, decided by the system", async () => {
    const c = (ctx = await setup());
    const p = await c.svc.propose({ companyId: c.company.id, byAgentId: c.ceo.id, source: "draft", files: [{ path: "SKILL.md", content: b64(md()) }, { path: "run.sh", content: b64("echo hi") }], why: "x", agentIds: [c.worker.id] });
    expect(p).toMatchObject({ hasScripts: true, reviewRequired: true, scriptFiles: ["run.sh"] });
  });

  it("a link is always reviewed, pinned to the commit with every file hashed", async () => {
    const c = (ctx = await setup());
    const p = await c.svc.propose({ companyId: c.company.id, byAgentId: c.ceo.id, source: "link", url: "https://github.com/acme/kit/tree/main/tidy", why: "x", agentIds: [c.worker.id] });
    expect(p).toMatchObject({ reviewRequired: true, hasScripts: false, pinnedRef: repo.commit, name: "tidy" });
    expect(Object.keys(p.fileHashes).sort()).toEqual(["SKILL.md", "notes.md"]);
  });

  it("needs a reason and agents, and one open proposal per name", async () => {
    const c = (ctx = await setup());
    const base = { companyId: c.company.id, byAgentId: c.ceo.id, source: "draft" as const, files: [{ path: "SKILL.md", content: b64(md()) }] };
    await expect(c.svc.propose({ ...base, why: " ", agentIds: [c.worker.id] })).rejects.toThrow(/why/);
    await expect(c.svc.propose({ ...base, why: "x", agentIds: [] })).rejects.toThrow(/agents/);
    await c.svc.propose({ ...base, why: "x", agentIds: [c.worker.id] });
    await expect(c.svc.propose({ ...base, why: "y", agentIds: [c.worker.id] })).rejects.toThrow(/open proposal/);
  });
});
