import { nameSecurityReviewer } from "./helpers.js";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, notifications, runners, settings, skills } from "../src/db/schema.js";
import { cleanPath, normalise, parseGitHub, parseSkillMd, skillInstructions, skillMarkdown, skillName, skillNameOf } from "../src/services/skills.js";
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
// A second repo laid out like many skill repos: the source in skill/, and a built copy per tool.
const multi: Record<string, string> = {
  "skill/SKILL.src.md": "template",
  ".claude/skills/polish/SKILL.md": "---\nname: polish\ndescription: Polishes UI.\n---\nClaude copy.",
  ".claude/skills/polish/reference/a.md": "ref",
  ".cursor/skills/polish/SKILL.md": "---\nname: polish\ndescription: Polishes UI.\n---\nCursor copy.",
  ".codex/skills/polish/SKILL.md": "---\nname: polish\ndescription: Polishes UI.\n---\nCodex copy.",
};
// A skill with many example assets, like cathrynlavery/diagram-design.
const big: Record<string, string> = {
  "skills/diagrams/SKILL.md": "---\nname: diagrams\ndescription: Draws diagrams.\n---\nBody.",
  ...Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`skills/diagrams/assets/example-${i}.html`, `<p>${i}</p>`])),
};
const fakeFetch = (async (input: string | URL) => {
  const url = String(input);
  fetched.push(url);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url === "https://api.github.com/repos/acme/multi") return json({ default_branch: "main" });
  if (url === "https://api.github.com/repos/acme/multi/commits/main") return json({ sha: "3333333333333333333333333333333333333333" });
  if (url.startsWith("https://api.github.com/repos/acme/multi/git/trees/")) return json({ tree: Object.keys(multi).map((p) => ({ path: p, type: "blob", size: multi[p]!.length })) });
  const rawMulti = "https://raw.githubusercontent.com/acme/multi/3333333333333333333333333333333333333333/";
  if (url.startsWith(rawMulti) && multi[decodeURIComponent(url.slice(rawMulti.length))] !== undefined) return new Response(multi[decodeURIComponent(url.slice(rawMulti.length))]);
  if (url === "https://api.github.com/repos/acme/big") return json({ default_branch: "main" });
  if (url === "https://api.github.com/repos/acme/big/commits/main") return json({ sha: "4444444444444444444444444444444444444444" });
  if (url.startsWith("https://api.github.com/repos/acme/big/git/trees/")) return json({ tree: Object.keys(big).map((p) => ({ path: p, type: "blob", size: big[p]!.length })) });
  const rawBig = "https://raw.githubusercontent.com/acme/big/4444444444444444444444444444444444444444/";
  if (url.startsWith(rawBig) && big[url.slice(rawBig.length)] !== undefined) return new Response(big[url.slice(rawBig.length)]);
  if (url === "https://api.github.com/repos/acme/kit") return json({ default_branch: "main" });
  if (url === "https://api.github.com/repos/acme/kit/commits/main") return json({ sha: commit });
  if (url.startsWith(`https://api.github.com/repos/acme/kit/git/trees/${commit}`)) return json({ tree: Object.keys(files).map((p) => ({ path: p, type: "blob", size: files[p]!.length })) });
  const raw = `https://raw.githubusercontent.com/acme/kit/${commit}/`;
  if (url.startsWith(raw) && files[url.slice(raw.length)] !== undefined) return new Response(files[url.slice(raw.length)]);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: fakeFetch });
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
  const funding = (await req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
  return { ...built, db, close, req, company, worker, project, sent, emit, starts, mcp, ceo, funding };
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

  it("names a fetched skill from its frontmatter, slugged, or its folder when there is no name", () => {
    const skill = (folder: string, files: Record<string, string>) => ({ folder, files: Object.entries(files).map(([path, text]) => ({ path, content: b64(text) })) });
    // The frontmatter name wins over the folder, and is slugged as a written or uploaded name is.
    expect(skillNameOf(skill("from-folder", { "SKILL.md": "---\nname: Release Notes\ndescription: Writes them.\n---\nBody." }))).toBe("release-notes");
    expect(skillNameOf(skill("from-folder", { "SKILL.md": '---\nname: "My Great Skill!"\n---\nBody.' }))).toBe("my-great-skill");
    // No name in the frontmatter (no match): the folder is the name, slugged too.
    expect(skillNameOf(skill("My Skill Folder", { "SKILL.md": "---\ndescription: No name here.\n---\nBody." }))).toBe("my-skill-folder");
    // No frontmatter at all: still the folder.
    expect(skillNameOf(skill("plain-skill", { "SKILL.md": "# Title\n\nNo frontmatter." }))).toBe("plain-skill");
    // Only SKILL.md's name is read, among supporting files and a README.
    expect(skillNameOf(skill("notes", { "README.md": "---\nname: not-this\n---", "SKILL.md": "---\nname: real\n---\nBody.", "assets/x.md": "x" }))).toBe("real");
  });

  it("builds a SKILL.md from the form: the name slugged, the description quoted, the body trimmed", () => {
    expect(skillMarkdown({ name: "My Great Skill!", description: "  Writes   release\n notes.  ", body: "  # Steps\n\nDo it.  " })).toBe(
      '---\nname: my-great-skill\ndescription: "Writes release notes."\n---\n\n# Steps\n\nDo it.\n',
    );
    // Quotes in the description are JSON-escaped, so the frontmatter stays valid YAML.
    expect(skillMarkdown({ name: "Quotes", description: 'Says "hi".', body: "Body." })).toContain('description: "Says \\"hi\\"."');
    // A pasted frontmatter block is dropped: the form's name and description replace it.
    expect(skillMarkdown({ name: "web-fetch", description: "Fetch pages.", body: "---\nname: old\ndescription: old\n---\n# Rules\n\nOne page." })).toBe(
      '---\nname: web-fetch\ndescription: "Fetch pages."\n---\n\n# Rules\n\nOne page.\n',
    );
    // CRLF frontmatter is found too.
    expect(skillMarkdown({ name: "crlf", description: "CRLF.", body: "---\r\nname: old\r\n---\r\nSteps." })).toBe('---\nname: crlf\ndescription: "CRLF."\n---\n\nSteps.\n');
    // An empty name falls back to "skill", and an empty body leaves just the frontmatter.
    expect(skillMarkdown({ name: "", description: "Says what it does.", body: "   " })).toBe('---\nname: skill\ndescription: "Says what it does."\n---\n\n\n');
  });

  it("reads a skill's instructions: the body after the frontmatter, trimmed, or why there is none", () => {
    const md = (text: string) => [{ path: "SKILL.md", content: b64(text) }];
    expect(skillInstructions(md("---\nname: style\ndescription: House style.\n---\n\n# Rules\n\nUse UK spelling.\n\n"))).toEqual({ path: "SKILL.md", body: "# Rules\n\nUse UK spelling.", empty: false, unreadable: false });
    // Headings are part of the instructions; only the frontmatter is taken off.
    expect(skillInstructions(md("# Title\n\nSteps.")).body).toBe("# Title\n\nSteps.");
    // No SKILL.md at all, and a SKILL.md with no body, both read as empty.
    expect(skillInstructions([{ path: "README.md", content: b64("Hello") }])).toEqual({ path: null, body: null, empty: true, unreadable: false });
    expect(skillInstructions(md("---\nname: empty\ndescription: Nothing yet.\n---\n\n"))).toEqual({ path: "SKILL.md", body: "", empty: true, unreadable: false });
    // A legacy lower-case path is found; a real SKILL.md wins over it.
    expect(skillInstructions([{ path: "skill.md", content: b64("---\ndescription: Legacy.\n---\n\nLegacy body.") }])).toEqual({ path: "skill.md", body: "Legacy body.", empty: false, unreadable: false });
    expect(skillInstructions([{ path: "skill.md", content: b64("Old.") }, ...md("---\ndescription: New.\n---\n\nNew body.")])).toMatchObject({ path: "SKILL.md", body: "New body." });
    // A NUL byte means the file is not text: the page flags it rather than showing an empty body.
    const binary = Buffer.concat([Buffer.from("---\ndescription: Binary.\n---\n\n"), Buffer.from([0, 1])]);
    expect(skillInstructions([{ path: "SKILL.md", content: binary.toString("base64") }])).toEqual({ path: "SKILL.md", body: null, empty: true, unreadable: true });
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
    await nameSecurityReviewer(c.db, c.worker.id);
    expect((await c.req("POST", `${base}/${notes.id}/refresh`)).json()).toEqual({ changed: false, proposalId: null, status: null });
    const before = commit;
    commit = "2222222222222222222222222222222222222222";
    files["skills/release-notes/templates/entry.md"] = "* {change}";
    // A newer version never replaces the library's copy: it becomes a proposal that is reviewed and decided.
    expect((await c.req("POST", `${base}/${notes.id}/refresh`)).json()).toMatchObject({ changed: true, status: "in_review" });
    expect((await c.req("GET", `${base}/${notes.id}`)).json()).toMatchObject({ sourceRef: before, files: [expect.anything(), { path: "templates/entry.md", text: "- {change}" }] });
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

  it("sends skills to an OpenCode agent's run, and says plainly when a Codex agent's can't load them (BOS-2264)", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const [s] = (await c.req("POST", base, { from: "written", name: "house-style", description: "UK spelling.", body: "Use UK spelling." })).json();
    await c.req("PUT", `${base}/${s.id}/agents`, { agentIds: [c.worker.id] });
    // OpenCode (the Synthetic infinite-mode harness) gets the same skill files Claude does.
    await c.db.update(agents).set({ agentKind: "opencode" }).where(eq(agents.id, c.worker.id));
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "On OpenCode", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const oc = c.starts().filter((x) => x.agentId === c.worker.id).at(-1)!;
    expect(oc.agentKind).toBe("opencode");
    expect(oc.skills?.map((k) => k.name)).toEqual(["house-style"]);
    expect(oc.prompt).not.toContain("NOT loaded");
    c.emit({ type: "run.ended", runId: oc.runId, stopReason: "end_turn", error: null });
    // Codex can't: no skills are sent, the run is told so, and the CEO's give carries a warning.
    await c.db.update(agents).set({ agentKind: "codex" }).where(eq(agents.id, c.worker.id));
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "On Codex", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const cx = c.starts().filter((x) => x.agentId === c.worker.id).at(-1)!;
    expect(cx.agentKind).toBe("codex");
    expect(cx.skills).toBeUndefined();
    expect(cx.prompt).toContain("can't load skills");
    const asCeo = await c.mcp(cx.runId, c.ceo.id);
    await asCeo.callTool({ name: "skills", arguments: { action: "take", skill: "house-style", agent: "Engineer" } });
    expect(textOf(await asCeo.callTool({ name: "skills", arguments: { action: "give", skill: "house-style", agent: "Engineer" } }))).toContain("Warning: Engineer runs on Codex, which can't load skills");
    await asCeo.close();
  });

  it("holds back a skill whose runner add-on isn't working, and tells the owner once (docs/12)", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const [qa] = (await c.req("POST", base, { from: "written", name: "dogfood", description: "Explore the site in a browser.", body: "Use agent-browser." })).json();
    const [style] = (await c.req("POST", base, { from: "written", name: "house-style", description: "UK spelling.", body: "Use UK spelling." })).json();
    expect((await c.req("PUT", `${base}/${qa.id}/addons`, { requires: ["warp-drive"] })).statusCode).toBe(400);
    expect((await c.req("PUT", `${base}/${qa.id}/addons`, { requires: ["agent-browser"] })).statusCode).toBe(200);
    expect((await c.req("GET", base)).json().find((s: { name: string }) => s.name === "dogfood").requiresAddons).toEqual(["agent-browser"]);
    await c.req("PUT", `${base}/${qa.id}/agents`, { agentIds: [c.worker.id] });
    await c.req("PUT", `${base}/${style.id}/agents`, { agentIds: [c.worker.id] });
    const run = async (title: string) => {
      await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title, assigneeAgentId: c.worker.id });
      await c.scheduler.tick();
      return c.starts().filter((s) => s.agentId === c.worker.id).at(-1)!;
    };
    const asks = async () => (await c.db.select().from(decisions)).filter((d) => d.question.includes('"dogfood" is left out'));
    // The runner hasn't reported the add-on: the skill stays home, the rest go.
    expect((await run("Check the homepage")).skills?.map((s) => s.name)).toEqual(["house-style"]);
    expect(await asks()).toHaveLength(1);
    const end = async () => c.emit({ type: "run.ended", runId: c.starts().filter((x) => x.agentId === c.worker.id).at(-1)!.runId, stopReason: "end_turn", error: null });
    await end();
    await run("Check the menu");
    expect(await asks()).toHaveLength(1);
    // Once the runner reports it healthy, the skill goes with the run.
    await end();
    await c.db.update(runners).set({ addons: [{ id: "agent-browser", version: "0.39.0", ok: true }] });
    expect((await run("Check the footer")).skills?.map((s) => s.name)).toEqual(["dogfood", "house-style"]);
    expect(c.starts().filter((x) => x.agentId === c.worker.id)).toHaveLength(3);
  });

  it("asks a runner how its add-ons are, keeps the answer, and re-arms the notice when it changes (docs/12)", async () => {
    const c = (ctx = await setup());
    const [row] = await c.db.select().from(runners);
    let report: unknown = [{ id: "agent-browser", version: "0.39.0", ok: true }];
    const asked: string[] = [];
    // A runner without the "addons" feature is never asked.
    expect(await c.runners.checkAddons(row!.id)).toBeNull();
    c.runners.connect(row!.id, (cmd) => {
      if (cmd.type !== "addons.check") return true;
      asked.push(cmd.type);
      queueMicrotask(() => c.runners.resolveReply({ requestId: cmd.requestId, ok: true, data: report }));
      return true;
    }, ["addons"]);
    await c.db.insert(settings).values({ key: `addon-missing:${row!.id}:dogfood:agent-browser`, value: true });
    expect(await c.runners.checkAddons(row!.id)).toEqual([{ id: "agent-browser", version: "0.39.0", ok: true }]);
    expect((await c.db.select().from(runners))[0]!.addons).toEqual([{ id: "agent-browser", version: "0.39.0", ok: true }]);
    expect(await c.db.select().from(settings).where(like(settings.key, "addon-missing:%"))).toEqual([]);
    // A malformed answer is refused, and the stored report stays.
    report = [{ id: "agent-browser" }];
    await expect(c.runners.checkAddons(row!.id)).rejects.toThrow();
    expect((await c.db.select().from(runners))[0]!.addons).toEqual([{ id: "agent-browser", version: "0.39.0", ok: true }]);
    expect(asked).toHaveLength(2);
  });

  it("edits a written skill, and drops front matter pasted into the instructions", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const [made] = (await c.req("POST", base, { from: "written", name: "web-fetch", description: "Fetch pages.", body: "---\nname: web-fetch\ndescription: old\n---\n# Rules\n\nOne page per call." })).json();
    const md = async () => (await c.req("GET", `${base}/${made.id}`)).json().files.find((f: { path: string }) => f.path === "SKILL.md").text as string;
    expect(await md()).toBe('---\nname: web-fetch\ndescription: "Fetch pages."\n---\n\n# Rules\n\nOne page per call.\n');
    expect((await c.req("PUT", `${base}/${made.id}`, { name: "web-fetch", description: "Fetch public pages as text.", body: "# Rules\n\nTwo pages at most." })).statusCode).toBe(200);
    expect(await md()).toContain('description: "Fetch public pages as text."');
    expect(await md()).toContain("Two pages at most.");
  });

  it("marks skills with no instructions and refuses to empty a body without confirmation", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const [empty] = (await c.req("POST", base, { from: "written", name: "empty-body", description: "Says what it does, but has no steps.", body: "" })).json();
    const [full] = (await c.req("POST", base, { from: "written", name: "full-body", description: "Has real steps.", body: "# Rules\n\nDo the thing." })).json();
    const list = (await c.req("GET", base)).json() as Array<{ name: string; hasInstructions: boolean; instructionsUnreadable: boolean }>;
    expect(list.find((x) => x.name === "empty-body")).toMatchObject({ hasInstructions: false, instructionsUnreadable: false });
    expect(list.find((x) => x.name === "full-body")).toMatchObject({ hasInstructions: true, instructionsUnreadable: false });
    expect(((await c.req("GET", `${base}/${empty.id}`)).json() as { instructions: unknown }).instructions).toEqual({ path: "SKILL.md", body: "", empty: true, unreadable: false });
    // An empty editor must not silently replace real instructions.
    const refused = await c.req("PUT", `${base}/${full.id}`, { name: "full-body", description: "Has real steps.", body: "" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/instructions/i);
    expect(((await c.req("GET", `${base}/${full.id}`)).json() as { instructions: { body: string } }).instructions.body).toBe("# Rules\n\nDo the thing.");
    expect((await c.req("PUT", `${base}/${full.id}`, { name: "full-body", description: "Has real steps.", body: "", confirmEmptyBody: true })).statusCode).toBe(200);
    expect(((await c.req("GET", `${base}/${full.id}`)).json() as { instructions: { empty: boolean } }).instructions.empty).toBe(true);
  });

  it("shows the body when a legacy skill's SKILL.md has different casing, and flags one that isn't text", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const legacyMd = "---\nname: legacy\ndescription: Legacy casing.\n---\n\n# Steps\n\nUse it.";
    await c.db.insert(skills).values({ companyId: c.company.id, name: "legacy", description: "Legacy casing.", source: "upload", files: [{ path: "skill.md", content: b64(legacyMd) }], sizeBytes: Buffer.byteLength(legacyMd) });
    const legacy = ((await c.req("GET", base)).json() as Array<{ id: string; name: string }>).find((x) => x.name === "legacy")!;
    expect(((await c.req("GET", `${base}/${legacy.id}`)).json() as { instructions: unknown }).instructions).toEqual({ path: "skill.md", body: "# Steps\n\nUse it.", empty: false, unreadable: false });
    const binary = Buffer.concat([Buffer.from("---\nname: binary\ndescription: Has a binary body.\n---\n\n"), Buffer.from([0, 1, 2])]);
    const [odd] = (await c.req("POST", base, { from: "upload", files: [{ path: "SKILL.md", content: binary.toString("base64") }] })).json();
    expect(((await c.req("GET", `${base}/${odd.id}`)).json() as { instructions: unknown }).instructions).toEqual({ path: "SKILL.md", body: null, empty: true, unreadable: true });
    expect(((await c.req("GET", base)).json() as Array<{ name: string; instructionsUnreadable: boolean }>).find((x) => x.name === "binary")).toMatchObject({ instructionsUnreadable: true });
  });

  it("shows the body when the description is quoted with escapes, or a folded block", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    // The shape of content-strategy's description: a quoted value with escaped quotes inside.
    const quotedMd = '---\nname: quoted\ndescription: "When the user mentions \\"content strategy,\\" and \\"topic clusters.\\""\n---\n\n# Steps\n\nThe body after an escaped description.';
    // The shape of british-plain-english's description: a block scalar with several lines.
    const foldedMd = "---\nname: folded\ndescription: |\n  Write plain British English.\n  Explain every term.\n---\n\n# Rules\n\nKeep sentences short.";
    await c.db.insert(skills).values([
      { companyId: c.company.id, name: "quoted", description: "Quoted", source: "upload", files: [{ path: "SKILL.md", content: b64(quotedMd) }], sizeBytes: Buffer.byteLength(quotedMd) },
      { companyId: c.company.id, name: "folded", description: "Folded", source: "upload", files: [{ path: "SKILL.md", content: b64(foldedMd) }], sizeBytes: Buffer.byteLength(foldedMd) },
    ]);
    const list = (await c.req("GET", base)).json() as Array<{ id: string; name: string; hasInstructions: boolean }>;
    const quoted = list.find((x) => x.name === "quoted")!;
    const folded = list.find((x) => x.name === "folded")!;
    expect(quoted.hasInstructions).toBe(true);
    expect(folded.hasInstructions).toBe(true);
    expect(((await c.req("GET", `${base}/${quoted.id}`)).json() as { instructions: { body: string } }).instructions.body).toBe("# Steps\n\nThe body after an escaped description.");
    expect(((await c.req("GET", `${base}/${folded.id}`)).json() as { instructions: { body: string } }).instructions.body).toBe("# Rules\n\nKeep sentences short.");
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
    // The library also carries Boss Man's built-in skills (BOS-2631); this checks the one added here.
    const listed = JSON.parse(textOf(await asCeo.callTool({ name: "skills", arguments: { action: "list" } }))) as Array<{ name: string }>;
    expect(listed.filter((s) => s.name === "triage")).toEqual([{ name: "triage", description: "Sorts bug reports.", agents: ["Engineer"] }]);
    expect(await asCeo.callTool({ name: "skills", arguments: { action: "give", skill: "nope", agent: "Engineer" } })).toMatchObject({ isError: true });
    await asCeo.callTool({ name: "skills", arguments: { action: "take", skill: "triage", agent: "Engineer" } });
    await asCeo.close();
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toEqual(expect.arrayContaining(["The CEO gave Engineer the triage skill", "The CEO took the triage skill from Engineer"]));
  });
  it("lets the CEO propose a team as one decision; the owner's ticked hires join with their skills (docs/13)", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/companies/${c.company.id}/skills`, { from: "written", name: "triage", description: "Sorts bug reports.", body: "Steps." });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Anything", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const runId = c.starts()[0]!.runId;
    const propose = async (agentId: string, args: Record<string, unknown>) => {
      const m = await c.mcp(runId, agentId);
      const r = await m.callTool({ name: "propose_team", arguments: args });
      await m.close();
      return r;
    };
    const model = { harness: "claude", provider: "anthropic", model: "claude-opus-4-5", fundingSourceId: c.funding.id };
    const plan = { projectId: c.project.id, covered: "Engineer builds the site.", hires: [{ ...model, name: "Quinn", template: "qa", reason: "Checks each release in a browser.", skills: ["triage"] }, { ...model, name: "Rae", reason: "Writes the copy." }] };
    expect(textOf(await propose(c.worker.id, plan))).toBe("Only your company's CEO can propose a team.");
    expect(textOf(await propose(c.ceo.id, { ...plan, hires: [{ ...model, name: "X", reason: "y", skills: ["nope"] }] }))).toBe("There's no skill or pack called nope in the library.");
    expect(textOf(await propose(c.ceo.id, plan))).toMatch(/^The team plan is waiting for the owner/);
    expect(textOf(await propose(c.ceo.id, plan))).toBe("A team plan for this is already waiting for the owner.");
    const [d] = (await c.db.select().from(decisions)).filter((x) => (x.context as { type?: string }).type === "team_plan");
    expect(d).toMatchObject({ tier: "owner", options: ["Hire the ticked ones", "Not now"] });
    expect(d!.question).toContain("Team plan for Site: the CEO proposes 2 hires.");
    expect(d!.question).toContain("1. Quinn (qa) Harness: Claude Code · Provider: Anthropic · Model: claude-opus-4-5 · Paid from: Claude Max: Checks each release in a browser. Skills: triage.");
    // A pick outside the plan is refused and the decision stays open; then the owner ticks only Quinn.
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Hire the ticked ones", picks: [5] })).statusCode).toBe(422);
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Hire the ticked ones", picks: [0] })).statusCode).toBe(200);
    const team = (await c.req("GET", `/api/companies/${c.company.id}/skills`)).json().find((s: { name: string }) => s.name === "triage").agents.map((a: { name: string }) => a.name);
    expect(team).toEqual(["Quinn"]);
    const names = (await c.db.select().from(agents)).map((a) => a.name);
    expect(names).toContain("Quinn");
    expect(names).not.toContain("Rae");
  });

  it("tells the CEO, on its next run only, about projects, objectives and milestones the owner added (docs/13)", async () => {
    const c = (ctx = await setup());
    const docs = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "Docs" })).json() as { id: string };
    const goal = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Launch the beta", projectId: docs.id })).json() as { id: string };
    await c.req("POST", `/api/objectives/${goal.id}/milestones`, { title: "Private beta" });
    const ceoRun = async (title: string) => {
      await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title, assigneeAgentId: c.ceo.id });
      await c.scheduler.tick();
      return c.starts().filter((x) => x.agentId === c.ceo.id).at(-1)!;
    };
    const first = await ceoRun("Plan the docs");
    expect(first.prompt).toContain("Since your last run the owner created a project, \"Site\"");
    expect(first.prompt).toContain(`created a project, "Docs" (${docs.id}); added an objective, "Launch the beta" for project ${docs.id}; added a milestone, "Private beta", under the objective "Launch the beta".`);
    expect(first.prompt).toContain("propose_team");
    await c.emit({ type: "run.ended", runId: first.runId, stopReason: "end_turn", error: null });
    expect((await ceoRun("Something else")).prompt).not.toContain("Since your last run the owner");
  });

  it("says where a repository's skills are, and takes Claude Code's copy from a repo with one per tool", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const miss = await c.req("POST", base, { from: "link", url: "https://github.com/acme/multi/tree/main/skill" });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().message).toBe(
      "There's no SKILL.md in skill/. This repository has skills in: .claude/skills/polish, .cursor/skills/polish, .codex/skills/polish. Link to one of those, e.g. https://github.com/acme/multi/tree/main/.claude/skills/polish",
    );
    const whole = await c.req("POST", base, { from: "link", url: "https://github.com/acme/multi" });
    expect(whole.json()).toEqual([expect.objectContaining({ name: "polish" })]);
    const skill = (await c.req("GET", base)).json().find((s: { name: string }) => s.name === "polish");
    const files = (await c.req("GET", `${base}/${skill.id}`)).json().files;
    expect(files.map((f: { path: string; text: string }) => [f.path, f.text])).toEqual([
      ["SKILL.md", multi[".claude/skills/polish/SKILL.md"]],
      ["reference/a.md", "ref"],
    ]);
  });
  it("adds a skill with hundreds of asset files", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const added = await c.req("POST", base, { from: "link", url: "https://github.com/acme/big" });
    expect(added.json()).toEqual([expect.objectContaining({ name: "diagrams" })]);
    const files = (await c.req("GET", `${base}/${added.json()[0].id}`)).json().files as Array<{ path: string; text: string }>;
    expect(files).toHaveLength(251);
    expect(files.find((f) => f.path === "assets/example-249.html")?.text).toBe("<p>249</p>");
  });
  it("keeps skills from one link together as a pack: given, updated and removed as one", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const packs = `/api/companies/${c.company.id}/skill-packs`;
    await c.req("POST", base, { from: "link", url: "https://github.com/acme/kit/tree/main/skills" });
    // The library also carries Boss Man's built-in skills (BOS-2631); these checks are the acme/kit pack alone.
    expect((await c.req("GET", base)).json().filter((s: { pack: string }) => s.pack === "acme/kit").map((s: { name: string; pack: string }) => [s.name, s.pack])).toEqual([
      ["release-notes", "acme/kit"],
      ["triage", "acme/kit"],
    ]);
    expect((await c.req("POST", base, { from: "link", url: "https://github.com/acme/kit/tree/main/skills" })).json().message).toBe("The acme/kit pack is already in the library; check it for updates instead.");

    // Given to an agent in one go.
    expect((await c.req("PUT", `${packs}/agents`, { pack: "acme/kit", agentIds: [c.worker.id] })).statusCode).toBe(200);
    expect((await c.req("GET", base)).json().filter((s: { pack: string }) => s.pack === "acme/kit").every((s: { agents: Array<{ id: string }> }) => s.agents.length === 1 && s.agents[0]!.id === c.worker.id)).toBe(true);

    // Updated in one go: a changed skill and a new one.
    const before = commit;
    commit = "4444444444444444444444444444444444444444";
    files["skills/triage/SKILL.md"] = "---\nname: triage\ndescription: \"Sorts bug reports by severity.\"\n---\nNew steps.\n";
    files["skills/deploy/SKILL.md"] = "---\nname: deploy\ndescription: Deploys.\n---\n";
    await nameSecurityReviewer(c.db, c.worker.id);
    // The changed skill becomes a proposal; nothing in the library moves.
    expect((await c.req("POST", `${packs}/refresh`, { pack: "acme/kit" })).json()).toEqual({ proposed: ["triage"], unchanged: 1, problems: [] });
    expect((await c.req("GET", base)).json().filter((s: { pack: string }) => s.pack === "acme/kit").map((s: { name: string; sourceRef: string }) => [s.name, s.sourceRef])).toEqual([["release-notes", before], ["triage", before]]);
    commit = before;
    delete files["skills/deploy/SKILL.md"];

    expect((await c.req("DELETE", `${packs}?pack=${encodeURIComponent("acme/kit")}`)).statusCode).toBe(204);
    // Only the pack left; the built-in skills (BOS-2631) stay in the library.
    expect((await c.req("GET", base)).json().filter((s: { pack: string }) => s.pack === "acme/kit")).toEqual([]);
  });

  it("lets the CEO give a whole pack by its name", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/companies/${c.company.id}/skills`, { from: "link", url: "https://github.com/acme/kit" });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Anything", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const asCeo = await c.mcp(c.starts()[0]!.runId, c.ceo.id);
    expect(textOf(await asCeo.callTool({ name: "skills", arguments: { action: "give", skill: "acme/kit", agent: "Engineer" } }))).toBe("Engineer has the acme/kit skill from their next run.");
    await asCeo.close();
    const all = (await c.req("GET", `/api/companies/${c.company.id}/skills`)).json();
    expect(all.filter((s: { pack: string }) => s.pack === "acme/kit").map((s: { name: string; agents: unknown[] }) => [s.name, s.agents.length])).toEqual([["release-notes", 1], ["triage", 1]]);
  });

  it("finds skills in other companies and copies one in, files and add-ons but not holders", async () => {
    const c = (ctx = await setup());
    const mine = `/api/companies/${c.company.id}/skills`;
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json().company as { id: string };
    const theirs = `/api/companies/${other.id}/skills`;
    await c.req("POST", mine, { from: "written", name: "local-only", description: "Only here.", body: "" });
    const [kit] = (await c.req("POST", theirs, { from: "upload", files: [{ path: "kit/SKILL.md", content: b64("---\nname: kit\ndescription: Builds 100% kits.\n---\nGo.") }, { path: "kit/scripts/run.sh", content: b64("echo hi") }] })).json();
    await c.req("PUT", `${theirs}/${kit.id}/addons`, { requires: ["agent-browser"] });
    await c.req("PUT", `${theirs}/${kit.id}/agents`, { agentIds: [(await c.db.select().from(agents).where(eq(agents.companyId, other.id)))[0]!.id] });
    // Search skips this company's own skills; q matches name or description, with % taken literally.
    const found = async (q = "") => (await c.req("GET", `${mine}/elsewhere?q=${encodeURIComponent(q)}`)).json();
    expect(await found()).toEqual([{ id: kit.id, name: "kit", description: "Builds 100% kits.", companyName: "Other Co", requiresAddons: ["agent-browser"], fileCount: 2, hasScripts: true }]);
    expect(await found("BUILDS")).toHaveLength(1);
    expect(await found("100%")).toHaveLength(1);
    expect(await found("%x")).toEqual([]);
    expect(await found("nope")).toEqual([]);
    expect(await found("local")).toEqual([]);
    // Copying brings the files and add-ons, not who holds it.
    const copied = await c.req("POST", `${mine}/copy`, { skillId: kit.id });
    expect(copied.statusCode).toBe(201);
    const one = (await c.req("GET", `${mine}/${copied.json().id}`)).json();
    expect(one).toMatchObject({ name: "kit", source: "upload", requiresAddons: ["agent-browser"], agents: [], pack: null });
    expect(one.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect((await c.req("GET", `${theirs}/${kit.id}`)).json().agents).toHaveLength(1);
    // A name clash is refused, and so is copying a skill to its own company or an unknown one.
    const again = await c.req("POST", `${mine}/copy`, { skillId: kit.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toBe("There's already a skill called kit.");
    expect((await c.req("POST", `${theirs}/copy`, { skillId: kit.id })).statusCode).toBe(400);
    expect((await c.req("POST", `${mine}/copy`, { skillId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    // Owner only.
    expect((await c.app.inject({ method: "GET", url: `${mine}/elsewhere` })).statusCode).toBe(401);
    expect((await c.app.inject({ method: "POST", url: `${mine}/copy`, payload: { skillId: kit.id } })).statusCode).toBe(401);
  });
});
