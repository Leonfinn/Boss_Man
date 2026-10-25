// Agent Companies adapter (docs/11, step 4): turns a company exported as "agentcompanies/v1"
// (Paperclip's export: COMPANY.md, agents/*/AGENTS.md, projects/*/PROJECT.md, skills/**/SKILL.md
// and .paperclip.yaml) into the files of a Boss Man package. The importer then checks and applies
// it like any other package. Written from an observed export; no code or files are copied.
import { strFromU8, strToU8 } from "fflate";
import { parse as parseYaml } from "yaml";
import { DEFAULT_COLUMNS, findCredential, repoUrlAllowed } from "@boss-man/shared";
import { EXPORT_FORMAT } from "./company-export.js";
import { skillName } from "./skills.js";

/** Skills that drive Paperclip's own API: Boss Man has its own tools for these. */
const REPLACED = [/^paperclipai\/paperclip\//, /^paperclipai\/bundled\/paperclip-operations\//, /^plugin\/paperclipai-plugin-llm-wiki\//];
/** Skills known to need a runner add-on (docs/12). */
const NEEDS_ADDON: Record<string, string[]> = { dogfood: ["agent-browser"], "agent-browser": ["agent-browser"] };
const KIND: Record<string, string> = { claude_local: "claude", opencode_local: "opencode", codex_local: "codex" };
const TEMPLATE: Record<string, string> = { engineer: "engineer", researcher: "researcher", qa: "qa", pm: "product-manager", designer: "designer", writer: "writer" };

type Files = Map<string, Uint8Array>;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The frontmatter and body of a markdown file; bad YAML reads as no frontmatter. */
function frontmatter(text: string): { meta: Obj; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  if (!m) return { meta: {}, body: text };
  try {
    return { meta: obj(parseYaml(m[1]!)), body: m[2]! };
  } catch {
    return { meta: {}, body: m[2]! };
  }
}

/** True when the files look like an Agent Companies export rather than a Boss Man package. */
export function isAgentCompanies(files: Files) {
  return !files.has("manifest.json") && files.has("COMPANY.md");
}

/** The Boss Man package files for an Agent Companies export, and what the owner should know. */
export function fromAgentCompanies(files: Files): { files: Files; notes: string[] } {
  const text = (p: string) => (files.has(p) ? strFromU8(files.get(p)!) : null);
  const out: Files = new Map(); // lost on restart, harmless because it lives only for this one import call.
  const notes: string[] = [];
  const json = (p: string, v: unknown) => out.set(p, strToU8(`${JSON.stringify(v, null, 2)}\n`));
  let config: Obj = {};
  try {
    config = obj(parseYaml(text(".paperclip.yaml") ?? ""));
  } catch {
    notes.push(".paperclip.yaml couldn't be read, so models, roles, secrets and repos were left out.");
  }
  const agentCfg = obj(config.agents);
  const projectCfg = obj(config.projects);

  const company = frontmatter(text("COMPANY.md")!);
  json("manifest.json", { format: EXPORT_FORMAT, from: str(company.meta.schema) ?? "agentcompanies" });
  json("company.json", { name: str(company.meta.name) ?? "Imported company", mission: str(company.body) });

  // Skills: one per folder holding a SKILL.md, keyed by its path under skills/ (as AGENTS.md refers to them).
  const dirs = [...files.keys()].filter((p) => p.startsWith("skills/") && p.endsWith("/SKILL.md")).map((p) => p.slice("skills/".length, -"/SKILL.md".length));
  const replaced = dirs.filter((d) => REPLACED.some((r) => r.test(`${d}/`)));
  if (replaced.length) notes.push(`Left out ${replaced.length} skills that drive Paperclip itself, since Boss Man has its own tools for that: ${replaced.map((d) => d.split("/").at(-1)).join(", ")}.`);
  const names = new Map<string, string>(); // folder → Boss Man name. lost on restart, harmless: one import call.
  const kept = dirs.filter((d) => !replaced.includes(d)).sort((a, b) => Number(!a.startsWith("company/")) - Number(!b.startsWith("company/")) || a.localeCompare(b));
  for (const d of kept) {
    const parts = d.split("/");
    let name = skillName(parts.at(-1)!);
    // The company's own skill keeps the plain name; a same-named one from elsewhere gets its source in front.
    if ([...names.values()].includes(name)) {
      name = skillName(`${parts.at(-2)}-${parts.at(-1)}`);
      notes.push(`Two skills are called ${parts.at(-1)}; the one from ${parts.slice(0, -1).join("/")} is imported as ${name}.`);
    }
    names.set(d, name);
    for (const [p, bytes] of files) if (p.startsWith(`skills/${d}/`) && !dirs.some((o) => o !== d && o.startsWith(`${d}/`) && p.startsWith(`skills/${o}/`))) out.set(`skills/${name}/${p.slice(`skills/${d}/`.length)}`, bytes);
  }
  /** AGENTS.md names skills as "owner/repo/…/leaf", "company/<id>/leaf" or "local/<id>/leaf"; the folders drop those ids. */
  const skillFor = (ref: string) => {
    const leaf = ref.split("/").at(-1)!;
    const exact = kept.find((d) => d === ref);
    if (exact) return names.get(exact)!;
    const scope = ref.split("/")[0];
    const match = kept.find((d) => d.split("/").at(-1) === leaf && (scope === "company" || scope === "local" ? d.startsWith(`${scope}/`) : true));
    return match ? names.get(match)! : null;
  };

  // Agents.
  const holders = new Map<string, string[]>(); // skill → agent folders. lost on restart, harmless: one import call.
  const secrets = new Map<string, string[]>(); // env name → agent folders. lost on restart, harmless: one import call.
  const agentDirs = [...new Set([...files.keys()].filter((p) => /^agents\/[^/]+\/AGENTS\.md$/.test(p)).map((p) => p.split("/")[1]!))].sort();
  for (const slug of agentDirs) {
    const md = frontmatter(text(`agents/${slug}/AGENTS.md`)!);
    const cfg = obj(agentCfg[slug]);
    const adapter = obj(cfg.adapter);
    const role = str(cfg.role) ?? "";
    const kind = KIND[str(adapter.type) ?? ""];
    if (adapter.type && !kind) notes.push(`${slug} ran on "${String(adapter.type)}", which Boss Man doesn't have; it's set to Claude.`);
    json(`agents/${slug}/agent.json`, {
      name: str(md.meta.name) ?? slug,
      role: role === "ceo" ? "ceo" : "worker",
      title: str(md.meta.title),
      template: TEMPLATE[role] ?? null,
      duty: role === "knowledge-maintainer" ? "wiki" : null,
      agentKind: kind ?? "claude",
      model: str(obj(adapter.config).model),
      reportsTo: str(md.meta.reportsTo),
    });
    if (md.body.trim()) out.set(`agents/${slug}/INSTRUCTIONS.md`, strToU8(md.body.trim()));
    const missing: string[] = [];
    for (const ref of Array.isArray(md.meta.skills) ? md.meta.skills.filter((s): s is string => typeof s === "string") : []) {
      if (REPLACED.some((r) => r.test(`${ref}/`))) continue;
      const name = skillFor(ref);
      if (name) holders.set(name, [...(holders.get(name) ?? []), slug]);
      else missing.push(ref.split("/").at(-1)!);
    }
    if (missing.length) notes.push(`${str(md.meta.name) ?? slug} had skills that aren't in the export: ${missing.join(", ")}.`);
    for (const [env, v] of Object.entries(obj(obj(cfg.inputs).env))) if (obj(v).kind === "secret" && /^[A-Z][A-Z0-9_]{0,63}$/.test(env)) secrets.set(env, [...(secrets.get(env) ?? []), slug]);
  }
  json(
    "skills.json",
    kept.map((d) => {
      const name = names.get(d)!;
      return { name, source: "upload", requiresAddons: NEEDS_ADDON[name] ?? null, agents: holders.get(name) ?? [] };
    }),
  );
  json(
    "secrets.json",
    [...secrets].map(([envName, agents]) => ({ name: envName, kind: "generic", envName, agents })),
  );

  // Projects: the repo from the primary workspace; the description becomes a wiki page.
  const projectDirs = [...new Set([...files.keys()].filter((p) => /^projects\/[^/]+\/PROJECT\.md$/.test(p)).map((p) => p.split("/")[1]!))].sort();
  for (const slug of projectDirs) {
    const md = frontmatter(text(`projects/${slug}/PROJECT.md`)!);
    const name = str(md.meta.name) ?? slug;
    const spaces = Object.values(obj(obj(projectCfg[slug]).workspaces)).map(obj);
    const repo = spaces.find((w) => w.isPrimary === true) ?? spaces[0];
    let repoUrl = str(repo?.repoUrl);
    if (repoUrl && (!repoUrlAllowed(repoUrl) || findCredential(repoUrl))) {
      notes.push(`${name}'s repo address (${findCredential(repoUrl) ? "it holds a credential" : "Boss Man doesn't accept it"}) was left out; add it on the Projects page.`);
      repoUrl = null;
    }
    json(`projects/${slug}/project.json`, { name, repoUrl, defaultBranch: str(repo?.defaultRef) ?? "main", columns: DEFAULT_COLUMNS });
    const about = md.body.trim() || str(md.meta.description);
    if (about) out.set(`wiki/imported/${slug}.md`, strToU8(`---\n${JSON.stringify({ slug: `imported/${slug}`, title: `${name} (imported)`, folder: "Imported" })}\n---\n${about}\n`));
  }
  return { files: out, notes };
}
