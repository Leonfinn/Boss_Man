import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

// A small company in the Agent Companies layout, written for this test.
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`;
const FILES: Record<string, string> = {
  "COMPANY.md": '---\nname: "Acme"\nschema: "agentcompanies/v1"\n---\nSell good widgets.\n',
  ".paperclip.yaml": [
    'schema: "paperclip/v1"',
    "agents:",
    "  boss:",
    '    role: "ceo"',
    "    adapter:",
    '      type: "claude_local"',
    "      config:",
    '        model: "claude-opus-5-5"',
    "    heartbeat: { intervalSec: 300 }",
    "  builder:",
    '    role: "engineer"',
    "    adapter:",
    '      type: "opencode_local"',
    "      config:",
    '        model: "openrouter/some/model"',
    "    inputs:",
    "      env:",
    "        GIT_TOKEN:",
    '          kind: "secret"',
    "        umami_username:",
    '          kind: "secret"',
    "projects:",
    "  site:",
    "    workspaces:",
    "      repo:",
    "        isPrimary: true",
    '        repoUrl: "https://github.com/acme/site.git"',
    '        defaultRef: "trunk"',
  ].join("\n"),
  "agents/boss/AGENTS.md": '---\nname: "Boss"\nskills:\n  - "paperclipai/paperclip/paperclip"\n  - "company/1234/seo-audit"\n---\nRun the company.\n',
  "agents/builder/AGENTS.md": '---\nname: "Builder"\ntitle: "Web Engineer"\nreportsTo: "boss"\nskills:\n  - "someone/seo-pack/seo-audit"\n  - "vercel-labs/agent-browser/dogfood"\n  - "nobody/gone/missing-skill"\n---\nBuild the site. Leave a comment every heartbeat.\n',
  "skills/company/ACME/seo-audit/SKILL.md": skill("seo-audit", "Our own SEO audit."),
  "skills/someone/seo-pack/seo-audit/SKILL.md": skill("seo-audit", "Someone else's SEO audit."),
  "skills/vercel-labs/agent-browser/dogfood/SKILL.md": skill("dogfood", "Explores a site in a real browser."),
  "skills/paperclipai/paperclip/paperclip/SKILL.md": skill("paperclip", "Talks to the Paperclip API."),
  "projects/site/PROJECT.md": '---\nname: "Site"\n---\nThe public website. Deploy on Thursdays.\n',
};
// Zipped as a folder, the way an export usually arrives.
const zip = Buffer.from(zipSync(Object.fromEntries(Object.entries(FILES).map(([p, t]) => [`acme/${p}`, strToU8(t)])))).toString("base64");

async function setup() {
  // BOS-855: its own database, never a parked pool copy. An import queues background wiki indexing that can still be running when the test ends, and on a pooled copy that work landed on (or raced the truncate of) the next test's database.
  const { db, close } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

describe("Agent Companies import (docs/11, step 4)", () => {
  it("previews and imports an Agent Companies export as a Boss Man company", async () => {
    const req = await setup();
    const pre = (await req("POST", "/api/companies/import/preview", { zip })).json();
    expect(pre.company).toEqual({ name: "Acme", nameTaken: false });
    expect(pre.agents.map((a: { name: string; agentKind: string; model: string }) => `${a.name} ${a.agentKind} ${a.model}`)).toEqual(["Boss claude claude-opus-5-5", "Builder opencode openrouter/some/model"]);
    expect(pre.skills.map((s: { name: string }) => s.name).sort()).toEqual(["dogfood", "seo-audit", "seo-pack-seo-audit"]);
    expect(pre.secrets).toEqual([{ name: "GIT_TOKEN", envName: "GIT_TOKEN", agents: ["builder"] }]);
    expect(pre.warnings).toEqual(expect.arrayContaining([expect.stringContaining("umami_username (add it as UMAMI_USERNAME)")]));
    expect(pre.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Left out 1 skills that drive Paperclip itself, since Boss Man has its own tools for that: paperclip."), expect.stringContaining("imported as seo-pack-seo-audit"), "Builder had skills that aren't in the export: missing-skill.", expect.stringContaining("1 agent's instructions describe working in Paperclip (the paperclip skill, heartbeats, its API or /paperclip paths), which Boss Man doesn't have: Builder.")]),
    );

    const res = await req("POST", "/api/companies/import", { zip });
    expect(res.statusCode).toBe(201);
    const id = res.json().companyId as string;
    const company = ((await req("GET", "/api/companies")).json() as Array<{ id: string; mission: string; agents: Array<{ id: string; name: string; role: string; reportsTo: string | null; title: string | null; template: string | null; paused: boolean }> }>).find((c) => c.id === id)!;
    expect(company.mission).toBe("Sell good widgets.");
    const boss = company.agents.find((a) => a.name === "Boss")!;
    expect(boss.role).toBe("ceo");
    expect(company.agents.find((a) => a.name === "Builder")).toMatchObject({ role: "worker", title: "Web Engineer", template: "engineer", reportsTo: boss.id, paused: true });

    const skills = (await req("GET", `/api/companies/${id}/skills`)).json() as Array<{ name: string; requiresAddons: string[] | null }>;
    expect(skills.find((s) => s.name === "dogfood")!.requiresAddons).toEqual(["agent-browser"]);
    expect(skills.find((s) => s.name === "seo-audit")!.requiresAddons).toBeNull();
    // The company's own seo-audit went to Boss; the other one to Builder.
    const exp = await req("GET", `/api/companies/${id}/export?wiki=1`);
    const { unzipSync, strFromU8 } = await import("fflate");
    const out = unzipSync(new Uint8Array(exp.rawPayload));
    const held = JSON.parse(strFromU8(out["skills.json"]!)) as Array<{ name: string; agents: string[] }>;
    expect(Object.fromEntries(held.map((s) => [s.name, s.agents]))).toEqual({ dogfood: ["builder"], "seo-audit": ["boss"], "seo-pack-seo-audit": ["builder"] });
    expect(strFromU8(out["skills/seo-audit/SKILL.md"]!)).toContain("Our own SEO audit.");
    expect(JSON.parse(strFromU8(out["projects/site/project.json"]!))).toMatchObject({ repoUrl: "https://github.com/acme/site.git", defaultBranch: "trunk" });
    expect(strFromU8(out["wiki/imported/site.md"]!)).toContain("Deploy on Thursdays.");
  });
});

describe("Paperclip issues (docs/11, step 5)", () => {
  it("brings issues, comments and documents in as tickets, conversation and wiki pages", async () => {
    const issues = [
      { identifier: "ACM-1", title: "Launch the site", status: "in_progress", priority: "high", parent: null, project: "Site", description: "Ship it.", created_at: "2026-10-01T09:00:00Z", comments: [{ at: "2026-10-01T10:00:00Z", by: "Boss", body: "On it." }, { at: "2026-10-01T11:00:00Z", by: "user-abc123", body: "Thanks." }, { at: "2026-10-01T12:00:00Z", by: "system", body: "Status changed." }], documents: [{ key: "plan", title: "Launch plan", body: "Step one." }, { key: "continuation-summary", title: null, body: "notes between runs" }, { key: "claims", title: "Claims", body: "x".repeat(250_000) }] },
      { identifier: "ACM-2", title: "Write the copy", status: "cancelled", priority: "low", parent: "ACM-1", project: "Site", description: null, created_at: "2026-10-02T09:00:00Z", comments: null, documents: null },
      { identifier: "ACM-3", title: "Loose idea", status: "todo", priority: "medium", parent: null, project: null, description: null, created_at: "2026-10-03T09:00:00Z", comments: [], documents: [] },
    ];
    const withIssues = Buffer.from(zipSync(Object.fromEntries([...Object.entries(FILES), ["paperclip-issues.json", JSON.stringify(issues)] as [string, string]].map(([p, t]) => [`acme/${p}`, strToU8(t)])))).toString("base64");
    const req = await setup();
    const pre = (await req("POST", "/api/companies/import/preview", { zip: withIssues })).json();
    expect(pre.counts).toMatchObject({ tickets: 3, projects: 2, wikiPages: 4 });
    expect(pre.warnings).toEqual(expect.arrayContaining(['1 tickets had no project in Paperclip; they\'re in a new project, "Imported tickets".', 'Skipped 1 "continuation-summary" documents: they were Paperclip\'s working notes between runs.']));
    const id = (await req("POST", "/api/companies/import", { zip: withIssues })).json().companyId as string;

    const { unzipSync, strFromU8 } = await import("fflate");
    const exported = await req("GET", `/api/companies/${id}/export?wiki=1&tickets=all`);
    expect(exported.statusCode, exported.body.slice(0, 300)).toBe(200);
    const out = unzipSync(new Uint8Array(exported.rawPayload));
    const tickets = strFromU8(out["tickets.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l));
    const by = (t: string) => tickets.find((x) => x.title === t);
    expect(by("Launch the site")).toMatchObject({ state: "in_progress", project: "site", body: "Ship it.\n\nImported from ACM-1" });
    expect(by("Launch the site").conversation.map((m: { author: string; agent: string | null; text: string }) => [m.author, m.agent, m.text])).toEqual([["agent", "boss", "On it."], ["owner", null, "Thanks."], ["system", null, "Status changed."]]);
    // Paperclip's own notes keep saying where they came from, through export and back.
    expect(by("Launch the site").conversation.map((m: { from?: string }) => m.from ?? null)).toEqual([null, null, "Paperclip"]);
    expect(by("Write the copy")).toMatchObject({ state: "done", outcome: "Cancelled in Paperclip.", parent: by("Launch the site").ref });
    expect(by("Loose idea")).toMatchObject({ state: "ready", project: "imported-tickets" });
    // Paperclip's numbers and prefix carry on, so ACM-2 still means the same ticket; new ones follow on.
    expect(tickets.map((t) => [t.title, t.number])).toEqual(expect.arrayContaining([["Launch the site", 1], ["Write the copy", 2], ["Loose idea", 3]]));
    expect(JSON.parse(strFromU8(out["company.json"]!))).toMatchObject({ ticketPrefix: "ACM" });
    const projectId = ((await req("GET", `/api/companies/${id}/projects`)).json() as Array<{ id: string }>)[0]!.id;
    const next = (await req("POST", `/api/projects/${projectId}/tickets`, { title: "New work" })).json() as { id: string };
    expect((await req("GET", `/api/tickets/${next.id}`)).json()).toMatchObject({ ref: "ACM-4" });
    const pages = Object.keys(out).filter((p) => p.startsWith("wiki/imported/acm-1/")).sort();
    expect(pages).toEqual(["wiki/imported/acm-1/claims-2.md", "wiki/imported/acm-1/claims.md", "wiki/imported/acm-1/plan.md"]);
    expect(strFromU8(out["wiki/imported/acm-1/claims.md"]!).length + strFromU8(out["wiki/imported/acm-1/claims-2.md"]!).length).toBeGreaterThan(250_000);
    expect(strFromU8(out["wiki/imported/acm-1/plan.md"]!)).toContain('"ticket":"' + by("Launch the site").ref + '"');
  });
});

describe("skipped secret names give advice the owner can act on (BOS-884)", () => {
  const withSecrets = (...env: string[]) => {
    const lines = FILES[".paperclip.yaml"]!.split("\n");
    const inEnv = (l: string) => ["GIT_TOKEN", "umami_username"].some((n) => l.trim().startsWith(`${n}:`));
    const kept = lines.filter((l, i) => !inEnv(l) && !(i > 0 && /^\s+kind: "secret"$/.test(l) && inEnv(lines[i - 1]!)));
    // The env block ends at the first line that isn't indented under it ("projects:").
    const end = kept.findIndex((l) => l.startsWith("projects:"));
    const files: Record<string, string> = { ...FILES, ".paperclip.yaml": [...kept.slice(0, end), ...env.flatMap((n) => [`        ${n}:`, '          kind: "secret"']), ...kept.slice(end)].join("\n") };
    return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p, t]) => [`acme/${p}`, strToU8(t)])))).toString("base64");
  };
  it("says a name whose upper-case twin is imported is already imported, and suggests a valid name for one that still breaks the rule", async () => {
    const req = await setup();
    const pre = (await req("POST", "/api/companies/import/preview", { zip: withSecrets("git_token", "GIT_TOKEN", "umami-user", "2fa_code") })).json();
    expect(pre.secrets.map((s: { name: string }) => s.name)).toEqual(["GIT_TOKEN"]);
    expect(pre.warnings).toEqual(expect.arrayContaining([expect.stringContaining("git_token (already imported as GIT_TOKEN: change scripts to read GIT_TOKEN)")]));
    expect(pre.warnings.join("\n")).not.toContain("add it as GIT_TOKEN");
    expect(pre.warnings).toEqual(expect.arrayContaining([expect.stringContaining("umami-user (add it as UMAMI_USER)"), expect.stringContaining("2fa_code (add it as X2FA_CODE)")]));
    const suggestions = ["UMAMI_USER", "X2FA_CODE"];
    for (const s of suggestions) expect(s).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
  });
});

describe("agent pictures in an Agent Companies export", () => {
  it("takes a real PNG beside AGENTS.md as the avatar, and ignores a file that only claims to be one", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAEhgGAcwq9lwAAAABJRU5ErkJggg==", "base64");
    const entries: Record<string, Uint8Array> = Object.fromEntries(Object.entries(FILES).map(([p, t]) => [`acme/${p}`, strToU8(t)]));
    entries["acme/agents/builder/avatar.PNG"] = new Uint8Array(png);
    entries["acme/agents/boss/avatar.png"] = strToU8("<svg onload=alert(1)>not a png</svg>");
    const req = await setup();
    const imported = await req("POST", "/api/companies/import", { zip: Buffer.from(zipSync(entries)).toString("base64") });
    expect(imported.statusCode, imported.body).toBe(201);
    const id = imported.json().companyId as string;
    const team = ((await req("GET", "/api/companies")).json() as Array<{ id: string; agents: Array<{ id: string; name: string }> }>).find((c) => c.id === id)!.agents;
    const pic = await req("GET", `/api/agents/${team.find((a) => a.name === "Builder")!.id}/avatar`);
    expect(pic.statusCode).toBe(200);
    expect(pic.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(pic.rawPayload).equals(png)).toBe(true);
    expect((await req("GET", `/api/agents/${team.find((a) => a.name === "Boss")!.id}/avatar`)).statusCode).toBe(404);
  });
});
