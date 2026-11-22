// BOS-2242: a company's own settings (agent approvals, git templates, retro agent, second opinion) travel in its package,
// and an import never loosens them. The last test reads the server's source so a new per-company settings key can't be
// added without deciding whether a package carries it.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { AGENT_APPROVALS } from "../src/services/agents.js";
import { APPROVALS_STRICTNESS, CARRIED_SETTING_KEYS, LEFT_OUT_SETTING_KEYS } from "../src/services/company-settings-package.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const KEY = ["sk-or", "MADEUPVALUE-qqzzxx-0987"].join("-"); // joined: no key-shaped line for the secret scans (BOS-1932)

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { req, db };
}

type Unzipped = Record<string, Uint8Array>;
const zipOf = (files: Unzipped) => Buffer.from(zipSync(files)).toString("base64");
const withSettings = (files: Unzipped, name: string, settings: unknown) => ({
  ...files,
  "company.json": strToU8(JSON.stringify({ ...JSON.parse(strFromU8(files["company.json"]!)), name })),
  "settings.json": strToU8(JSON.stringify(settings)),
});

describe("company settings in a package (BOS-2242)", () => {
  it("carries approvals, templates, the retro agent and the second opinion, with its key by name only", async () => {
    const { req, db } = await setup();
    const { company } = (await req("POST", "/api/companies", { name: "Settled Co" })).json() as { company: { id: string } };
    const cid = company.id;
    // Per-company keys that must stay home: the weekly summary's address, the runner's observed models, alert markers.
    await db.insert(settings).values([
      { key: `weekly_summary:${cid}`, value: { enabled: true, to: "owner-private@example.com", lastSentAt: null } },
      { key: `models:${cid}:claude`, value: ["observed-model-zq7"] },
      { key: `merge_jam:${cid}`, value: { since: "2026-11-01T00:00:00Z" } },
      { key: `spend_rate_alerted:${cid}`, value: true },
    ]);
    const eng = (await req("POST", `/api/companies/${cid}/agents`, { name: "Rhoda", template: "engineer" })).json() as { id: string };
    expect((await req("PUT", `/api/companies/${cid}/agent-approvals`, { approvals: "hires_and_edits" })).statusCode).toBe(200);
    expect((await req("PUT", `/api/companies/${cid}/git-templates`, { commit: "{title} ({ref})", pr: "## {title}\n\n{body}" })).statusCode).toBe(200);
    expect((await req("PUT", `/api/companies/${cid}/retro-settings`, { agentId: eng.id })).statusCode).toBe(200);
    const secret = (await req("POST", "/api/secrets", { name: "OpenRouter key", kind: "generic", value: KEY })).json().secret.id as string;
    expect((await req("PUT", `/api/companies/${cid}/second-opinion`, { enabled: true, baseUrl: "https://openrouter.example.com/api/v1", model: "some/model", secretId: secret })).statusCode).toBe(200);

    const files = unzipSync(new Uint8Array((await req("GET", `/api/companies/${cid}/export`)).rawPayload));
    expect(JSON.parse(strFromU8(files["settings.json"]!))).toEqual({
      agentApprovals: "hires_and_edits",
      gitTemplates: { commit: "{title} ({ref})", pr: "## {title}\n\n{body}" },
      retroAgent: "rhoda",
      secondOpinion: { baseUrl: "https://openrouter.example.com/api/v1", model: "some/model", secret: "OpenRouter key" },
    });
    // Neither the key's value nor its secret id leaves.
    const all = Object.values(files).map((b) => strFromU8(b)).join("\n");
    expect(all).not.toContain(KEY);
    expect(strFromU8(files["settings.json"]!)).not.toContain(secret);
    for (const left of ["owner-private@example.com", "observed-model-zq7", "weekly_summary", "merge_jam", "spend_rate_alerted", "2026-11-01T00:00:00Z"]) expect(all).not.toContain(left);

    const zip = zipOf(files);
    const pre = (await req("POST", "/api/companies/import/preview", { zip, name: "Settled Copy" })).json() as { settings: string[] };
    expect(pre.settings).toEqual([
      "Agent changes: hires, model and instruction changes wait for you, as in the package.",
      "Commit and PR message templates: the commit template and the PR template from the package.",
      "Workflow retros: run by Rhoda, as in the package.",
      "Second opinion on permission cards: comes in switched off, set to model some/model at openrouter.example.com. Check it, then switch it on in Settings → Permissions → Second opinion.",
    ]);

    const res = await req("POST", "/api/companies/import", { zip, name: "Settled Copy" });
    expect(res.statusCode).toBe(201);
    const { companyId, checklist } = res.json() as { companyId: string; checklist: string[] };
    expect(checklist).toEqual(expect.arrayContaining(pre.settings));
    // The secret exists on this server, so it is picked and nothing asks the owner to add it.
    expect(checklist.filter((l) => l.includes('Add the secret "OpenRouter key"'))).toEqual([]);

    expect((await req("GET", `/api/companies/${companyId}/agent-approvals`)).json()).toEqual({ approvals: "hires_and_edits" });
    expect((await req("GET", `/api/companies/${companyId}/git-templates`)).json()).toEqual({ commit: "{title} ({ref})", pr: "## {title}\n\n{body}" });
    const newAgents = (await req("GET", `/api/companies/${companyId}/agents`)).json() as Array<{ id: string; name: string }>;
    const rhoda = newAgents.find((a) => a.name === "Rhoda")!;
    expect((await req("GET", `/api/companies/${companyId}/retro-settings`)).json()).toMatchObject({ agentId: rhoda.id });
    // It can allow permission cards, so it always arrives off, however the package had it.
    expect((await req("GET", `/api/companies/${companyId}/second-opinion`)).json()).toEqual({ enabled: false, baseUrl: "https://openrouter.example.com/api/v1", model: "some/model", secretId: secret });
    // The source company is untouched.
    expect((await req("GET", `/api/companies/${cid}/second-opinion`)).json()).toMatchObject({ enabled: true });
    // No secret was created.
    expect(((await req("GET", "/api/secrets")).json() as unknown[]).length).toBe(1);
  });

  it("never loosens agent approvals, leaves out what it can't place, and asks for a missing key", async () => {
    const { req } = await setup();
    const { company } = (await req("POST", "/api/companies", { name: "Loose Co" })).json() as { company: { id: string } };
    const files = unzipSync(new Uint8Array((await req("GET", `/api/companies/${company.id}/export`)).rawPayload));
    // Nothing was set, so nothing travels and the import takes the defaults.
    expect(JSON.parse(strFromU8(files["settings.json"]!))).toEqual({});

    const loose = withSettings(files, "Loose Copy", {
      agentApprovals: "nothing",
      retroAgent: "nobody-here",
      secondOpinion: { enabled: true, baseUrl: "https://llm.example.com/v1", model: "m", secret: "Key not on this server" },
    });
    const res = await req("POST", "/api/companies/import", { zip: zipOf(loose) });
    expect(res.statusCode).toBe(201);
    const { companyId, checklist } = res.json() as { companyId: string; checklist: string[] };
    expect((await req("GET", `/api/companies/${companyId}/agent-approvals`)).json()).toEqual({ approvals: "hires" });
    expect(checklist).toEqual(expect.arrayContaining([
      expect.stringContaining('The package had "nothing waits for you", which is looser than the default, so the default was kept.'),
      expect.stringContaining('the package names an agent ("nobody-here") that isn\'t in it'),
      'Add the secret "Key not on this server" and pick it as the second opinion\'s key in Settings → Permissions → Second opinion.',
    ]));
    expect((await req("GET", `/api/companies/${companyId}/retro-settings`)).json()).toMatchObject({ agentId: null });
    expect((await req("GET", `/api/companies/${companyId}/second-opinion`)).json()).toEqual({ enabled: false, baseUrl: "https://llm.example.com/v1", model: "m", secretId: null });

    // A value Boss Man can't use is left out with a note, and the import still works.
    const bad = withSettings(files, "Bad Copy", { agentApprovals: "everything", gitTemplates: { commit: "" }, secondOpinion: { baseUrl: "ftp://x", model: "m" } });
    const pre = (await req("POST", "/api/companies/import/preview", { zip: zipOf(bad) })).json() as { settings: string[]; warnings: string[] };
    expect(pre.settings).toEqual([]);
    expect(pre.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("setting for who approves agent changes couldn't be read"),
      expect.stringContaining("setting for the commit and PR message templates couldn't be read"),
      expect.stringContaining("setting for the second opinion couldn't be read"),
    ]));
    const badRes = await req("POST", "/api/companies/import", { zip: zipOf(bad) });
    expect(badRes.statusCode).toBe(201);
    expect((await req("GET", `/api/companies/${badRes.json().companyId}/agent-approvals`)).json()).toEqual({ approvals: "hires" });

    // A package made before settings.json existed imports as before.
    const old = withSettings(files, "Old Copy", {});
    delete (old as Unzipped)["settings.json"];
    const oldRes = await req("POST", "/api/companies/import", { zip: zipOf(old) });
    expect(oldRes.statusCode).toBe(201);
    expect((oldRes.json() as { checklist: string[] }).checklist.filter((l) => /Agent changes|Second opinion|Workflow retros|message templates/.test(l))).toEqual([]);
    // All four at their defaults.
    const oldId = (oldRes.json() as { companyId: string }).companyId;
    const fresh = (await req("POST", "/api/companies", { name: "Fresh Co" })).json().company.id as string;
    for (const path of ["agent-approvals", "git-templates", "second-opinion"]) expect((await req("GET", `/api/companies/${oldId}/${path}`)).json()).toEqual((await req("GET", `/api/companies/${fresh}/${path}`)).json());
    expect((await req("GET", `/api/companies/${oldId}/agent-approvals`)).json()).toEqual({ approvals: "hires" });
    expect((await req("GET", `/api/companies/${oldId}/second-opinion`)).json()).toMatchObject({ enabled: false });
    expect((await req("GET", `/api/companies/${oldId}/retro-settings`)).json()).toMatchObject({ agentId: null });
  });

  it("names every per-company settings key the server uses as carried or left out", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
    const found = new Map<string, string>();
    for (const file of walk(src)) {
      const text = readFileSync(file, "utf8");
      // Only files that touch the settings table; a key shaped `prefix:${...companyId...}`.
      if (!/\bsettings\b/.test(text)) continue;
      for (const m of text.matchAll(/`([a-z_-]+):\$\{[^}]*ompany[^}]*\}/g)) if (!found.has(m[1]!)) found.set(m[1]!, file.slice(src.length + 1));
    }
    const known = new Set([...Object.values(CARRIED_SETTING_KEYS), ...Object.keys(LEFT_OUT_SETTING_KEYS)]);
    const unlisted = [...found].filter(([k]) => !known.has(k)).map(([k, f]) => `${k} (${f})`);
    // A new per-company key: add it to CARRIED_SETTING_KEYS (and carry it) or to LEFT_OUT_SETTING_KEYS with the reason.
    expect(unlisted).toEqual([]);
    // The four carried keys are really found, so the scan itself still works.
    for (const k of Object.values(CARRIED_SETTING_KEYS)) expect(found.has(k)).toBe(true);
  });

  it("ranks every agent approvals value the owner can pick", () => {
    // A new value in agents.ts must get a place in the strictness order, or an import couldn't compare it.
    expect([...APPROVALS_STRICTNESS].sort()).toEqual([...AGENT_APPROVALS].sort());
  });
});
