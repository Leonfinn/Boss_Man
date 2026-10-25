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
    "projects:",
    "  site:",
    "    workspaces:",
    "      repo:",
    "        isPrimary: true",
    '        repoUrl: "https://github.com/acme/site.git"',
    '        defaultRef: "trunk"',
  ].join("\n"),
  "agents/boss/AGENTS.md": '---\nname: "Boss"\nskills:\n  - "paperclipai/paperclip/paperclip"\n  - "company/1234/seo-audit"\n---\nRun the company.\n',
  "agents/builder/AGENTS.md": '---\nname: "Builder"\ntitle: "Web Engineer"\nreportsTo: "boss"\nskills:\n  - "someone/seo-pack/seo-audit"\n  - "vercel-labs/agent-browser/dogfood"\n  - "nobody/gone/missing-skill"\n---\nBuild the site.\n',
  "skills/company/ACME/seo-audit/SKILL.md": skill("seo-audit", "Our own SEO audit."),
  "skills/someone/seo-pack/seo-audit/SKILL.md": skill("seo-audit", "Someone else's SEO audit."),
  "skills/vercel-labs/agent-browser/dogfood/SKILL.md": skill("dogfood", "Explores a site in a real browser."),
  "skills/paperclipai/paperclip/paperclip/SKILL.md": skill("paperclip", "Talks to the Paperclip API."),
  "projects/site/PROJECT.md": '---\nname: "Site"\n---\nThe public website. Deploy on Thursdays.\n',
};
// Zipped as a folder, the way an export usually arrives.
const zip = Buffer.from(zipSync(Object.fromEntries(Object.entries(FILES).map(([p, t]) => [`acme/${p}`, strToU8(t)])))).toString("base64");

async function setup() {
  const { db, close } = await openPglite();
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
    expect(pre.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Left out 1 skills that drive Paperclip itself, since Boss Man has its own tools for that: paperclip."), expect.stringContaining("imported as seo-pack-seo-audit"), "Builder had skills that aren't in the export: missing-skill."]),
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
