// Company import (docs/11, step 2): reads a "bossman-company/1" package, shows what it would
// create, and applies it as a NEW company in one transaction. The package is untrusted: every
// path, size and field is checked, imported agents start paused, and no secret is created or
// granted (the owner adds each value; the checklist decision lists them).
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";
import { ruleProblems, RuleMatchSchema,type PolicyMatch, type PolicyOutcome, columnProblems, DEFAULT_REVIEW_POLICY, noLooserThan, normalisePolicyMarked, REVIEW_KINDS, ReviewPolicySchema, repoUrlAllowed, findCredential, DAEMON_ONLY_SECRET_REFUSAL, isDaemonOnlySecret,THINKING_LEVELS, TICKET_PREFIX, defaultTicketPrefix, type ReviewKind, type ReviewPolicy } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { endpointProblem } from "./deploys.js";
import { agentAvatars, agentSkills, agents, companies, deployTargets, features, fundingSources, policyRules, keyResults, mcpServers, milestones, objectives, projects, skills, ticketMessages, tickets, wikiPages, wikiRevisions, workflowColumns } from "../db/schema.js";
import { EXPORT_FORMAT } from "./company-export.js";
import { fromAgentCompanies, isAgentCompanies } from "./import-agent-companies.js";
import { MAX_BODY, slugify } from "./wiki.js";
import { cleanPath, LIMITS, normalise, parseSkillMd, skillName, SkillError, type SkillFile } from "./skills.js";
import { allowsPrivate, gitHostAddress, reachesStack, sendableAddress } from "./launcher.js";
import { normalizeStandingRules, standingRulesError } from "./standing-rules.js";
import { addTicketDependency } from "./ticket-links.js";
import { applySettings, PackageSettings, screenSettings } from "./company-settings-package.js";

export class ImportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const IMPORT_LIMITS = { zipBytes: 48 * 1024 * 1024, unpackedBytes: 256 * 1024 * 1024, files: 20_000, avatarBytes: 256 * 1024 };

const str = (max: number) => z.string().max(max);
const opt = (max: number) => str(max).nullable().optional();
const Uuidish = z.string().max(100);
const Company = z.object({ name: z.string().trim().min(1).max(80), mission: opt(2000), reviewPolicy: z.unknown().optional(), goalCheckDays: z.number().int().min(1).max(365).optional(), ownerApprovesEngagements: z.boolean().optional(), ticketPrefix: z.string().regex(TICKET_PREFIX).nullable().optional().catch(null), standingRules: opt(100_000), watchdog: z.object({ enabled: z.boolean().optional() }).partial().optional() });
const Agent = z.object({
  ref: Uuidish.optional(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["ceo", "manager", "worker"]),
  title: opt(120),
  template: opt(64),
  duty: opt(32),
  reviewKind: opt(32),
  agentKind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).default("claude"),
  model: opt(200),
  thinking: z.enum(THINKING_LEVELS).nullable().optional().catch(null),
  reportsTo: opt(120),
  instructions: opt(100_000),
});
const SkillMeta = z.object({ name: z.string().max(64), source: z.enum(["written", "link", "upload", "retro"]).optional(), sourceUrl: opt(2000), sourceRef: opt(200), pack: opt(200), packUrl: opt(2000), requiresAddons: z.array(str(64)).max(20).nullable().optional(), agents: z.array(str(120)).max(500).default([]) });
const Column = z.object({ name: z.string().trim().min(1).max(60), systemState: z.enum(["backlog", "ready", "in_progress", "blocked", "review", "done"]), wipLimit: z.number().int().positive().nullable().optional() });
const Project = z.object({
  name: z.string().trim().min(1).max(80),
  repoUrl: str(500).refine(repoUrlAllowed, "a repo address Boss Man doesn't accept").refine((u) => !findCredential(u), "a repo address with a credential in it").nullable().optional(),
  defaultBranch: z.string().trim().min(1).max(200).default("main"),
  landing: z.enum(["merge", "pull_request"]).default("merge"),
  gitHost: z.enum(["github", "gitea"]).nullable().optional(),
  gitApiBase: opt(500),
  verifyCommand: opt(1000),
  deepVerifyCommand: opt(1000),
  ticketCostCapMicros: z.number().int().nonnegative().nullable().optional(),
  monthlyCapMicros: z.number().int().nonnegative().nullable().optional(),
  reviewPolicy: z.unknown().optional(),
  columns: z.array(Column).min(1).max(30).superRefine((cols, ctx) => columnProblems(cols).forEach((message) => ctx.addIssue({ code: "custom", message }))),
});
const Plan = z.object({
  objectives: z
    .array(
      z.object({
        ref: Uuidish,
        title: z.string().trim().min(1).max(500),
        priority: z.number().int().min(1).max(5).default(2),
        status: str(32).default("active"),
        project: opt(120),
        keyResults: z.array(z.object({ title: z.string().trim().min(1).max(500), target: z.number().nullable().optional(), current: z.number().nullable().optional(), unit: opt(32), method: z.enum(["manual", "agent", "check"]).default("manual"), checkSpec: z.unknown().optional() })).max(50).default([]),
        milestones: z.array(z.object({ ref: Uuidish, title: z.string().trim().min(1).max(500), targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), horizon: z.enum(["now", "next", "later"]).nullable().optional() })).max(100).default([]),
      }),
    )
    .max(500)
    .default([]),
  features: z
    .array(z.object({ ref: Uuidish, title: z.string().trim().min(1).max(500), description: opt(20_000), status: z.enum(["idea", "considering", "planned", "in_progress", "released", "declined"]).default("idea"), effort: z.number().int().min(1).max(5).nullable().optional(), parent: opt(100), objective: opt(100), milestone: opt(100) }))
    .max(5000)
    .default([]),
});
const ToolServer = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).refine((n) => n !== "bossman"), url: str(500).refine((u) => /^https?:\/\//.test(u)), transport: z.enum(["http", "sse"]), headerName: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/).default("Authorization"), headerValue: str(200).default("Bearer {secret}"), secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).refine((n) => !isDaemonOnlySecret(n), DAEMON_ONLY_SECRET_REFUSAL).nullable().optional() }).refine((v) => !v.secretEnv || v.headerValue.includes("{secret}"), "the header value must contain {secret}");
const Secret = z.object({ name: z.string().trim().min(1).max(200), kind: str(64), envName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), agents: z.array(str(120)).max(500).default([]) });
const DeployTarget = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["ssh", "docker", "git"]),
  endpoint: str(500),
  isProduction: z.boolean().default(false),
  rules: z.object({ requiresApproval: z.boolean().optional(), liveTag: z.object({ project: str(120), name: str(200) }).nullable().optional() }).partial().default({}),
  secrets: z.array(Secret).max(100).default([]),
});
const PermissionRule = z.object({ name: z.string().trim().min(1).max(200), trigger: str(64).default("permission"), condition: z.record(z.string(), z.unknown()).default({}), outcome: z.enum(["allow", "ceo", "owner", "deny"]), position: z.number().int().min(0).max(100_000).default(0) });
const WikiMeta = z.object({ slug: z.string().min(1).max(300), title: z.string().trim().min(1).max(300), folder: str(300).default(""), ticket: opt(100) });
const Ticket = z.object({
  ref: z.string().min(1).max(100),
  /** Its number in the company's sequence, kept so references like HOL-12 still point at it. */
  number: z.number().int().positive().max(999_999_999).nullable().optional().catch(null),
  project: z.string().max(120),
  title: z.string().trim().min(1).max(500),
  body: opt(100_000),
  state: Column.shape.systemState.default("backlog"),
  outcome: opt(10_000),
  risk: z.enum(["trivial", "low", "medium", "high", "critical"]).nullable().optional(),
  parent: opt(100),
  feature: opt(100),
  milestone: opt(100),
  assignee: opt(120),
  acceptanceCriteria: z.array(z.string().max(1000)).max(10).default([]),
  branch: opt(300),
  waitsOn: z.array(str(100)).max(100).default([]),
  createdAt: z.string().max(40).optional(),
  conversation: z.array(z.object({ author: z.enum(["owner", "agent", "system"]), agent: opt(120), from: opt(60), text: z.string().max(100_000), at: z.string().max(40).optional() })).max(5000).default([]),
});

export type Package = {
  company: z.infer<typeof Company>;
  agents: Array<z.infer<typeof Agent> & { slug: string; avatar: { bytes: Uint8Array; type: string } | null }>;
  skills: Array<{ name: string; folder: string; description: string; files: SkillFile[]; bytes: number; meta: z.infer<typeof SkillMeta> | null }>;
  projects: Array<z.infer<typeof Project> & { slug: string }>;
  plan: z.infer<typeof Plan>;
  toolServers: Array<z.infer<typeof ToolServer>>;
  secrets: Array<z.infer<typeof Secret>>;
  /** BOS-2169: absent in packages made before it. */
  deployTargets: Array<z.infer<typeof DeployTarget>>;
  permissionRules: Array<z.infer<typeof PermissionRule>>;
  /** BOS-2242: the company's own settings; empty in packages made before it. */
  settings: PackageSettings;
  wiki: Array<z.infer<typeof WikiMeta> & { body: string }>;
  tickets: Array<z.infer<typeof Ticket>>;
  /** What an adapter changed or left out on the way in. */
  notes: string[];
};

/** The picture's type from its first bytes, as the upload route checks it: PNG, JPEG or WebP only, never what the name claims. */
export const pictureType = (b: Uint8Array) => {
  const head = Buffer.from(b.subarray(0, 12));
  return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
    : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? "image/jpeg"
    : head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp"
    : null;
};
const SCRIPT = /(^|\/)scripts?\/|\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|bin)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw new ImportError(400, `${where}: ${i.path.join(".") || "the file"} — ${i.message}`);
  }
  return r.data;
}

/** Unpacks and checks a package without writing anything. */
export function readPackage(zip: Uint8Array): Package {
  if (zip.length > IMPORT_LIMITS.zipBytes) throw new ImportError(413, `A package can be at most ${IMPORT_LIMITS.zipBytes / 1024 / 1024} MB.`);
  let total = 0;
  let count = 0;
  let raw: Record<string, Uint8Array>;
  try {
    // The sizes are checked before anything is inflated, and each file inflates into a buffer of its stated size.
    raw = unzipSync(zip, {
      filter: (f) => {
        total += f.originalSize;
        if (++count > IMPORT_LIMITS.files || total > IMPORT_LIMITS.unpackedBytes) throw new ImportError(413, "The package unpacks to too many files or too many bytes.");
        return !f.name.endsWith("/");
      },
    });
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError(400, "That isn't a zip file Boss Man can read.");
  }
  let files = new Map<string, Uint8Array>(); // lost on restart, harmless because it lives only for this one import call.
  for (const [name, bytes] of Object.entries(raw)) {
    const path = cleanPath(name);
    if (!path || path !== name.replace(/\\/g, "/")) throw new ImportError(400, `"${name}" isn't a safe path inside the package.`);
    // What a Mac adds when it zips a folder.
    if (!path.startsWith("__MACOSX/") && !path.endsWith(".DS_Store")) files.set(path, bytes);
  }
  // A zipped folder puts everything under one top folder.
  const tops = new Set([...files.keys()].map((p) => p.split("/")[0]));
  const [top] = [...tops];
  if (tops.size === 1 && !files.has("manifest.json") && !files.has("COMPANY.md") && (files.has(`${top}/manifest.json`) || files.has(`${top}/COMPANY.md`)))
    files = new Map([...files].map(([p, b]) => [p.slice(top!.length + 1), b]));
  let notes: string[] = [];
  if (isAgentCompanies(files)) ({ files, notes } = fromAgentCompanies(files));
  const text = (p: string) => (files.has(p) ? strFromU8(files.get(p)!) : null);
  const json = (p: string) => {
    const t = text(p);
    if (t === null) return undefined;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      throw new ImportError(400, `${p} isn't valid JSON.`);
    }
  };

  const manifest = parse(z.object({ format: z.string() }), json("manifest.json") ?? {}, "manifest.json");
  if (manifest.format !== EXPORT_FORMAT) throw new ImportError(400, `This isn't a Boss Man company package (format "${manifest.format}", expected "${EXPORT_FORMAT}").`);
  const company = parse(Company, json("company.json"), "company.json");
  // Standing rules come in as plain text only (DR-041): same trimming and length cap as the owner's own
  // save, and nothing else in the package can turn them into a permission rule. Text that is too long
  // or holds a credential is left out, with a warning, rather than failing the whole import.
  const rules = normalizeStandingRules(company.standingRules ?? "");
  company.standingRules = rules || null;
  if (rules && standingRulesError(rules)) {
    notes.push(`The standing rules in the package were left out: ${standingRulesError(rules)}`);
    company.standingRules = null;
  } else if (rules && findCredential(rules)) {
    notes.push("The standing rules in the package were left out because they look like they hold a password or key.");
    company.standingRules = null;
  }

  const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
  const folders = (dir: string) => [...new Set(under(dir).map((p) => p.split("/")[1]!))].sort();

  const pkgAgents = folders("agents").map((slug) => {
    const a = parse(Agent, { ...(json(`agents/${slug}/agent.json`) as object), instructions: text(`agents/${slug}/INSTRUCTIONS.md`) }, `agents/${slug}`);
    const pic = under(`agents/${slug}`).find((p) => /\/avatar\.[a-z]+$/.test(p));
    const bytes = pic ? files.get(pic)! : null;
    const type = bytes ? pictureType(bytes) : null;
    return { ...a, slug, avatar: type && bytes && bytes.length <= IMPORT_LIMITS.avatarBytes ? { bytes, type } : null };
  });
  if (pkgAgents.filter((a) => a.role === "ceo").length > 1) throw new ImportError(400, "The package has more than one CEO.");
  const duties = pkgAgents.map((a) => a.duty).filter(Boolean);
  if (new Set(duties).size !== duties.length) throw new ImportError(400, "The package gives the same duty to two agents.");

  const metas = parse(z.array(SkillMeta).max(1000), json("skills.json") ?? [], "skills.json");
  const pkgSkills = folders("skills").map((folder) => {
    const own = under(`skills/${folder}`).map((p) => ({ path: p.slice(`skills/${folder}/`.length), content: Buffer.from(files.get(p)!).toString("base64") }));
    try {
      const n = normalise(own);
      const md = parseSkillMd(Buffer.from(n.files[0]!.content, "base64").toString("utf8"));
      const description = (md.description ?? "").slice(0, 1024);
      if (!description) throw new SkillError(400, "SKILL.md needs a description.");
      const meta = metas.find((m) => m.name === folder) ?? null;
      return { name: skillName(meta?.name ?? md.name ?? folder), folder, description, files: n.files, bytes: n.bytes, meta };
    } catch (err) {
      if (err instanceof SkillError) throw new ImportError(400, `skills/${folder}: ${err.message}`);
      throw err;
    }
  });
  const skillNames = pkgSkills.map((s) => s.name);
  if (new Set(skillNames).size !== skillNames.length) throw new ImportError(400, "Two skills in the package end up with the same name.");

  for (const a of pkgAgents) {
    const held = pkgSkills.filter((s) => s.meta?.agents.includes(a.slug)).reduce((n, s) => n + s.bytes, 0);
    if (held > LIMITS.perAgentBytes) throw new ImportError(400, `${a.name}'s skills come to more than ${LIMITS.perAgentBytes / 1024 / 1024} MB.`);
  }

  const pkgProjects = folders("projects").map((slug) => ({ ...parse(Project, json(`projects/${slug}/project.json`), `projects/${slug}`), slug }));
  const wiki = under("wiki")
    .filter((p) => p.endsWith(".md"))
    .map((p) => {
      const m = /^---\n(.*)\n---\n([\s\S]*)$/.exec(text(p)!);
      if (!m) throw new ImportError(400, `${p} has no frontmatter.`);
      let meta: unknown;
      try {
        meta = JSON.parse(m[1]!);
      } catch {
        throw new ImportError(400, `${p}'s frontmatter isn't valid JSON.`);
      }
      if (m[2]!.length > MAX_BODY) throw new ImportError(400, `${p} is over ${MAX_BODY} characters.`);
      return { ...parse(WikiMeta, meta, p), body: m[2]! };
    });
  const lines = (text("tickets.jsonl") ?? "").split("\n").filter((l) => l.trim());
  const pkgTickets = lines.map((l, i) => {
    try {
      return parse(Ticket, JSON.parse(l), `tickets.jsonl line ${i + 1}`);
    } catch (err) {
      if (err instanceof ImportError) throw err;
      throw new ImportError(400, `tickets.jsonl line ${i + 1} isn't valid JSON.`);
    }
  });

  // A setting the package holds in a shape Boss Man can't use is left out, and said, rather than failing the import.
  const rawSettings = json("settings.json");
  const pkgSettings = PackageSettings.parse(rawSettings);
  if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
    const labels: Record<string, string> = { agentApprovals: "who approves agent changes", gitTemplates: "the commit and PR message templates", retroAgent: "who runs the retro", secondOpinion: "the second opinion" };
    for (const [k, label] of Object.entries(labels))
      if ((rawSettings as Record<string, unknown>)[k] != null && (pkgSettings as Record<string, unknown>)[k] === undefined) notes.push(`The package's setting for ${label} couldn't be read and was left out; the default is used.`);
  }

  return {
    company,
    settings: pkgSettings,
    agents: pkgAgents,
    skills: pkgSkills,
    projects: pkgProjects,
    plan: parse(Plan, json("plan.json") ?? {}, "plan.json"),
    toolServers: parse(z.array(ToolServer).max(100), json("tool-servers.json") ?? [], "tool-servers.json"),
    secrets: parse(z.array(Secret).max(500), json("secrets.json") ?? [], "secrets.json"),
    deployTargets: parse(z.array(DeployTarget).max(100), json("deploy-targets.json") ?? [], "deploy-targets.json"),
    permissionRules: parse(z.array(PermissionRule).max(500), json("permission-rules.json") ?? [], "permission-rules.json"),
    wiki,
    tickets: pkgTickets,
    notes,
  };
}

/**
 * What of the package's deploy targets and permission rules can be imported (BOS-2169), and what the owner is told
 * about the rest. Pure, so the preview and the apply agree. An Allow rule comes in as "Ask me" (owner), a rule that
 * names agents the package doesn't hold is left out rather than widened to every agent, and an endpoint the deploy
 * target form would refuse is skipped.
 */
export function screenExtras(pkg: Package) {
  const lines: string[] = [];
  const seenTargets = new Set<string>(); // shortcut: local to one call, gone when it returns, so nothing to lose on restart
  const targets: Array<z.infer<typeof DeployTarget>> = [];
  for (const t of pkg.deployTargets) {
    const problem = endpointProblem(t.kind, t.endpoint);
    if (problem) {
      lines.push(`Deploy target "${t.name}" was not imported: ${problem}`);
      continue;
    }
    if (seenTargets.has(t.name.toLowerCase())) {
      lines.push(`Deploy target "${t.name}" appears twice in the package; only the first was imported.`);
      continue;
    }
    seenTargets.add(t.name.toLowerCase());
    const lt = t.rules.liveTag ?? null;
    // The live tag is not carried: saving one makes Boss Man check the tag name against the repo's branches through a runner,
    // and an import has no runner yet. The owner sets it again once the company's runner is up.
    if (lt) lines.push(`Deploy target "${t.name}" had a live tag "${lt.name}" for project "${lt.project}"; it was not carried over. Set it again on the target once the company's runner is running.`);
    targets.push(t);
    for (const s of t.secrets) lines.push(`Add the secret "${s.name}" and grant it as ${s.envName} to deploy target "${t.name}"${s.agents.length ? `, for ${s.agents.map((slug) => pkg.agents.find((a) => a.slug === slug)?.name ?? slug).join(", ")}` : ""}.`);
  }
  const agentNames = new Set(pkg.agents.map((a) => a.name));
  const rules: Array<{ name: string; match: PolicyMatch; outcome: PolicyOutcome; agentNames: string[] | null }> = [];
  for (const r of [...pkg.permissionRules].sort((a, b) => a.position - b.position)) {
    if (r.trigger !== "permission") {
      lines.push(`Rule "${r.name}" was not imported: it is a "${r.trigger}" rule and only permission rules are carried.`);
      continue;
    }
    const { agents: named, ...rest } = r.condition as Record<string, unknown> & { agents?: unknown };
    // Agent ids from another server mean nothing here; a rule that carries them can't be placed, and dropping them would widen it.
    if ("agentIds" in rest) {
      lines.push(`Rule "${r.name}" was not imported: it names agents by id, which can't be placed in this company.`);
      continue;
    }
    let wanted: string[] | null = null;
    if (named !== undefined) {
      wanted = Array.isArray(named) ? named.filter((n): n is string => typeof n === "string") : [];
      const missing = wanted.filter((n) => !agentNames.has(n));
      const kept = wanted.filter((n) => agentNames.has(n));
      if (!kept.length) {
        lines.push(`Rule "${r.name}" names ${wanted.length ? `${listJoin(wanted)}, who ${wanted.length > 1 ? "aren't" : "isn't"}` : "agents that aren't"} in this company; it was not imported.`);
        continue;
      }
      if (missing.length) lines.push(`Rule "${r.name}" also named ${listJoin(missing)}, who ${missing.length > 1 ? "aren't" : "isn't"} in this company; it applies to ${listJoin(kept)} only.`);
      wanted = kept;
    }
    // Only what the owner's rule form can set; the schema strips anything else, so a package can't carry built-in-only
    // conditions (bossmanCall, destructive, pushing, ...), and a wrong type fails here.
    const unknownKeys = Object.keys(rest).filter((k) => !(k in RuleMatchSchema.shape));
    const parsed = RuleMatchSchema.safeParse(rest);
    if (unknownKeys.length || !parsed.success) {
      lines.push(`Rule "${r.name}" was not imported: its condition isn't one the rule form can set${unknownKeys.length ? ` (${unknownKeys.join(", ")})` : ""}.`);
      continue;
    }
    const match: PolicyMatch = parsed.data;
    const problems = ruleProblems({ ...match, ...(wanted ? { agentIds: ["x"] } : {}) });
    if (problems.length) {
      lines.push(`Rule "${r.name}" was not imported: ${problems.join(" ")}`);
      continue;
    }
    // A package can't hand out permissions or move the owner's approvals to the CEO (a CEO routing rule beats the built-in
    // owner gates for destructive requests and pushes), so Allow and Ask-the-CEO both come in as Ask me.
    const softened = r.outcome === "allow" || r.outcome === "ceo";
    if (softened) lines.push(`Rule "${r.name}" was ${r.outcome === "allow" ? "Allow" : "Ask the CEO"} in the export; it asks you now. If you trust it, change it back in Settings → Permissions.`);
    rules.push({ name: r.name, match, outcome: softened ? "owner" : r.outcome, agentNames: wanted });
  }
  return { targets, rules, lines };
}
const listJoin = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0]!);

/** What applying the package would create, and what the owner should look at first. */
export async function previewPackage(db: Db, pkg: Package, name = pkg.company.name) {
  const [taken] = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name));
  const warnings: string[] = [...pkg.notes];
  if (!pkg.agents.some((a) => a.role === "ceo")) warnings.push("The package has no CEO; hire one after importing.");
  const extras = screenExtras(pkg);
  warnings.push(...extras.lines.filter((l) => !l.startsWith("Add the secret")));
  const companySettings = await screenSettings(db, pkg.settings, pkg.agents);
  return {
    settings: [...companySettings.lines, ...companySettings.todo],
    company: { name, nameTaken: !!taken },
    counts: { agents: pkg.agents.length, skills: pkg.skills.length, projects: pkg.projects.length, objectives: pkg.plan.objectives.length, features: pkg.plan.features.length, toolServers: pkg.toolServers.length, wikiPages: pkg.wiki.length, tickets: pkg.tickets.length, deployTargets: extras.targets.length, permissionRules: extras.rules.length },
    agents: pkg.agents.map((a) => ({ name: a.name, role: a.role, title: a.title ?? null, agentKind: a.agentKind, model: a.model ?? null, instructions: a.instructions ?? null })),
    skills: pkg.skills.map((s) => ({ name: s.name, renamedFrom: s.name !== s.folder ? s.folder : null, description: s.description, scripts: s.files.map((f) => f.path).filter((p) => SCRIPT.test(p)) })),
    secrets: pkg.secrets.map((s) => ({ name: s.name, envName: s.envName, agents: s.agents })),
    // Each tool server and the host:port the runner's network guard would let through for it (null: none it can allow).
    // Each project's verify commands word for word: they run on the runner during checks (BOS-818). Shown, not judged.
    projects: pkg.projects.map((p) => ({ name: p.name, verifyCommand: p.verifyCommand ?? null, deepVerifyCommand: p.deepVerifyCommand ?? null })),
    toolServers: await Promise.all(pkg.toolServers.map(async (t) => ({ name: t.name, url: t.url, opens: sendableAddress(t.url), stackService: await reachesStack(t.url) }))),
    // Each project's git address and whether it would reach a private or stack address, so the owner sees it and ticks for it (BOS-708).
    gitHosts: await Promise.all(
      pkg.projects
        .filter((p) => p.repoUrl)
        .map(async (p) => ({ project: p.name, url: p.repoUrl!, opens: gitHostAddress(p.repoUrl!), stackService: await reachesStack(p.repoUrl!) })),
    ),
    warnings,
  };
}

/**
 * Swaps the package's agent ids in a review policy for the new ones; a single id it can't place
 * becomes the CEO, and a list keeps the agents it can place (the CEO when none). A legacy "marked"
 * cell becomes the package's agents marked for that kind (marks: their new ids).
 */
function remapPolicy(policy: unknown, ids: Map<string, string>, marks: Partial<Record<ReviewKind, string[]>>): ReviewPolicy {
  if (policy === undefined || policy === null) return DEFAULT_REVIEW_POLICY;
  const swap = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const placed = [...new Set(v.flatMap((x) => (typeof x === "string" && ids.has(x) ? [ids.get(x)!] : [])))];
      return placed.length ? placed : "ceo";
    }
    if (typeof v === "string" && UUID.test(v)) return ids.get(v) ?? "ceo";
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  const r = ReviewPolicySchema.safeParse(swap(policy));
  return r.success ? normalisePolicyMarked(r.data, marks) : DEFAULT_REVIEW_POLICY;
}

/** Creates the package as a new company in one transaction. Every agent starts paused. */
export async function applyPackage(db: Db, pkg: Package, opts: { name?: string; fundingSourceId?: string | null; allowStackServices?: boolean } = {}) {
  const name = opts.name?.trim() || pkg.company.name;
  const ticked = opts.allowStackServices === true;
  const flags = await Promise.all(pkg.toolServers.map((t) => reachesStack(t.url)));
  // The tick says the owner allows private addresses for the servers the preview flagged, and only those: a public name
  // the package also lists stays untrusted, so re-pointing it later can't open the stack network (BOS-708). A server the
  // preview didn't flag stays untrusted even when ticked, and so does one whose host isn't really meant for a private
  // address (allowsPrivate fails closed on a lookup error).
  const trustPrivate = await Promise.all(
    pkg.toolServers.map(async (t, i) => ticked && flags[i] === true && (await allowsPrivate(t.url))),
  );
  const onStack = pkg.toolServers.filter((_, i) => flags[i]);
  if (!ticked && onStack.length)
    throw new ImportError(400, `Tool server${onStack.length > 1 ? "s" : ""} ${onStack.map((t) => `"${t.name}" (${sendableAddress(t.url) ?? t.url})`).join(", ")} point${onStack.length > 1 ? "" : "s"} at Boss Man's own services or a private-network address, which could give the company's runner a direct path to them. Tick the box to allow it, or remove ${onStack.length > 1 ? "them" : "it"} from the package.`);
  // A project's git address in a package is treated the same way (BOS-708, Jane's finding): the preview flags the ones that
  // reach the stack, and only the tick lets them keep a private address. The owner's own git address stays trusted.
  const gitFlags = await Promise.all(pkg.projects.map((p) => (p.repoUrl ? reachesStack(p.repoUrl) : false)));
  const onStackGit = pkg.projects.filter((_, i) => gitFlags[i]);
  if (!ticked && onStackGit.length)
    throw new ImportError(400, `Project git address${onStackGit.length > 1 ? "es" : ""} ${onStackGit.map((p) => `"${p.name}" (${gitHostAddress(p.repoUrl!) ?? p.repoUrl})`).join(", ")} point${onStackGit.length > 1 ? "" : "s"} at Boss Man's own services or a private-network address, which could give the company's runner a direct path to them. Tick the box to allow ${onStackGit.length > 1 ? "them" : "it"}, or remove ${onStackGit.length > 1 ? "them" : "it"} from the package.`);
  // Trust a package's git host for private only when the preview flagged it, the owner ticked, and it really resolves private.
  const gitTrust = await Promise.all(pkg.projects.map(async (p, i) => ticked && gitFlags[i] === true && !!p.repoUrl && (await allowsPrivate(p.repoUrl))));
  if (opts.fundingSourceId && !(await db.select({ id: fundingSources.id }).from(fundingSources).where(eq(fundingSources.id, opts.fundingSourceId))).length) throw new ImportError(400, "No such funding source.");
  if ((await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name))).length) throw new ImportError(409, `There's already a company called ${name}. Pick another name.`);
  // BOS-2242: the company's own settings, screened the same way as for the preview.
  const companySettings = await screenSettings(db, pkg.settings, pkg.agents);

  return db.transaction(async (tx) => {
    // Source ids and folder names → new ids. lost on restart, harmless because they live only for this one import call.
    const agentId = new Map<string, string>();
    const agentRef = new Map<string, string>();
    const projectId = new Map<string, string>();
    const objectiveId = new Map<string, string>();
    const milestoneId = new Map<string, string>();
    const featureId = new Map<string, string>();
    const ticketId = new Map<string, string>();
    const columnsOf = new Map<string, Array<{ id: string; systemState: string }>>();

    // Tickets keep their numbers (a repeat gets a new one); tickets without one are numbered after the highest.
    const seen = new Set<number>();
    const numberOf = new Map(pkg.tickets.map((t) => [t.ref, t.number && !seen.has(t.number) && seen.add(t.number) ? t.number : null]));
    // A package may tighten the owner's safeguards but never loosen them (BOS-754, BOS-762): approving
    // engagements keeps its default (on), each review policy keeps the default's owner sign-offs and plan
    // approvals, and the watchdog starts on for a new company. The checklist says what the package asked
    // for, so the owner can loosen it on purpose.
    const tightened: string[] = [];
    if (pkg.company.ownerApprovesEngagements === false) tightened.push("Kept on: your approval before this company takes on work for another company. The package had it switched off.");
    if (pkg.company.watchdog?.enabled === false) tightened.push("Kept on: the Scrum Master watchdog, which checks the board for stuck work. The package had it switched off. To change it, use Settings → Watchdog.");
    const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0]!);
    // The company's policy is floored against the default; each project's override against the company's
    // (BOS-818). The default has a security review at high and critical (BOS-824); the company's own
    // policy adds whatever else it has, which is what a project override would otherwise drop.
    const floored = (policy: ReviewPolicy, project?: { name: string; floor: ReviewPolicy }) => {
      const r = noLooserThan(policy, project?.floor);
      if (r.tightened.length)
        tightened.push(
          `Kept on${project ? ` in project ${project.name}` : ""}: ${listed(r.tightened)}. The package had ${r.tightened.length > 1 ? "them" : "it"} switched off. To change ${r.tightened.length > 1 ? "them" : "it"}, use ${project ? "the project's review settings" : "Settings → Reviews"}.`,
        );
      return r.policy;
    };
    const [c] = await tx
      .insert(companies)
      .values({ name, mission: pkg.company.mission ?? null, goalCheckDays: pkg.company.goalCheckDays, ticketPrefix: pkg.company.ticketPrefix ?? defaultTicketPrefix(name), ...(pkg.company.standingRules ? { standingRules: pkg.company.standingRules, standingRulesBy: "import", standingRulesAt: new Date() } : {}), nextTicketNumber: Math.max(0, ...seen) + 1 })
      .returning();
    // companies.id is the database's own default (gen_random_uuid), so a missing row means the insert did not
    // take at all, not that the id was blank. Say so plainly instead of dereferencing undefined and letting
    // the caller read a generic failure or a company with no id (BOS-927).
    if (!c) throw new ImportError(500, "The import could not create the company: the database returned no row for it, so nothing was saved. Try the import again.");
    const companyId = c.id;

    for (const a of pkg.agents) {
      const [row] = await tx
        .insert(agents)
        .values({ companyId, name: a.name, role: a.role, title: a.title ?? null, template: a.template ?? null, duty: a.duty ?? null, agentKind: a.agentKind, model: a.model ?? null, thinking: a.thinking ?? null, instructions: a.instructions ?? null, fundingSourceId: opts.fundingSourceId ?? null, paused: true, avatarAt: a.avatar ? new Date() : null })
        .returning();
      agentId.set(a.slug, row!.id);
      if (a.ref) agentRef.set(a.ref, row!.id);
      if (a.avatar) await tx.insert(agentAvatars).values({ agentId: row!.id, bytes: Buffer.from(a.avatar.bytes), type: a.avatar.type });
    }
    for (const a of pkg.agents) if (a.reportsTo && agentId.has(a.reportsTo)) await tx.update(agents).set({ reportsTo: agentId.get(a.reportsTo)! }).where(eq(agents.id, agentId.get(a.slug)!));
    // An older package marks reviewers on the agent; its "marked" cells name them instead (BOS-198).
    const marks: Partial<Record<ReviewKind, string[]>> = {};
    for (const a of pkg.agents) if (a.reviewKind && (REVIEW_KINDS as readonly string[]).includes(a.reviewKind)) (marks[a.reviewKind as ReviewKind] ??= []).push(agentId.get(a.slug)!);
    const companyPolicy = floored(remapPolicy(pkg.company.reviewPolicy, agentRef, marks));
    await tx.update(companies).set({ reviewPolicy: companyPolicy }).where(eq(companies.id, companyId));

    for (const s of pkg.skills) {
      const m = s.meta;
      const [row] = await tx
        .insert(skills)
        .values({ companyId, name: s.name, description: s.description, source: m?.source ?? "upload", sourceUrl: m?.sourceUrl ?? null, sourceRef: m?.sourceRef ?? null, pack: m?.pack ?? null, packUrl: m?.packUrl ?? null, requiresAddons: m?.requiresAddons ?? null, files: s.files, sizeBytes: s.bytes })
        .returning();
      const holders = (m?.agents ?? []).map((slug) => agentId.get(slug)).filter((x): x is string => !!x);
      if (holders.length) await tx.insert(agentSkills).values(holders.map((id) => ({ agentId: id, skillId: row!.id })));
    }

    for (const [pi, p] of pkg.projects.entries()) {
      const { slug, columns, reviewPolicy, ...fields } = p;
      const [row] = await tx
        .insert(projects)
        .values({ companyId, ...fields, allowPrivate: gitTrust[pi] === true, reviewPolicy: reviewPolicy === undefined || reviewPolicy === null ? null : floored(remapPolicy(reviewPolicy, agentRef, marks), { name: fields.name, floor: companyPolicy }) })
        .returning();
      projectId.set(slug, row!.id);
      columnsOf.set(row!.id, await tx.insert(workflowColumns).values(columns.map((col, i) => ({ projectId: row!.id, name: col.name, systemState: col.systemState, wipLimit: col.wipLimit ?? null, position: i }))).returning({ id: workflowColumns.id, systemState: workflowColumns.systemState }));
    }

    for (const o of pkg.plan.objectives) {
      const [row] = await tx.insert(objectives).values({ companyId, title: o.title, priority: o.priority, status: o.status, projectId: (o.project && projectId.get(o.project)) || null }).returning();
      objectiveId.set(o.ref, row!.id);
      if (o.keyResults.length) await tx.insert(keyResults).values(o.keyResults.map((k) => ({ objectiveId: row!.id, title: k.title, target: k.target ?? null, current: k.current ?? null, unit: k.unit ?? null, method: k.method, checkSpec: k.checkSpec ?? null })));
      for (const m of o.milestones) {
        const [ms] = await tx.insert(milestones).values({ objectiveId: row!.id, title: m.title, targetDate: m.targetDate ?? null, horizon: m.horizon ?? null }).returning();
        milestoneId.set(m.ref, ms!.id);
      }
    }
    // Parents first, since a subfeature points at its parent.
    const feats = [...pkg.plan.features].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
    for (const f of feats) {
      const [row] = await tx
        .insert(features)
        .values({ companyId, title: f.title, description: f.description ?? null, status: f.status, effort: f.effort ?? null, parentId: (f.parent && featureId.get(f.parent)) || null, objectiveId: (f.objective && objectiveId.get(f.objective)) || null, milestoneId: (f.milestone && milestoneId.get(f.milestone)) || null })
        .returning();
      featureId.set(f.ref, row!.id);
    }

    // The import tick lets a packaged tool server point at a private address, so trust it for private from then on
    // (BOS-708): the guard keeps its private addresses instead of dropping them when its name is re-pointed.
    if (pkg.toolServers.length) await tx.insert(mcpServers).values(pkg.toolServers.map((t, i) => ({ companyId, ...t, secretEnv: t.secretEnv ?? null, allowPrivate: trustPrivate[i] === true })));

    // Deploy targets and the company's own permission rules (BOS-2169). No secret is created or granted; the checklist lists them.
    const extras = screenExtras(pkg);
    if (extras.targets.length)
      await tx.insert(deployTargets).values(
        extras.targets.map((t) => ({ companyId, name: t.name, kind: t.kind, endpoint: t.endpoint.trim(), isProduction: t.isProduction, rules: t.rules.requiresApproval === true ? { requiresApproval: true } : {} })),
      );
    const agentByName = new Map(pkg.agents.map((a) => [a.name, agentId.get(a.slug)!]));
    if (extras.rules.length)
      await tx.insert(policyRules).values(
        extras.rules.map((r, i) => ({ companyId, name: r.name, trigger: "permission", condition: { ...r.match, ...(r.agentNames ? { agentIds: r.agentNames.map((n) => agentByName.get(n)!) } : {}) }, outcome: r.outcome, position: i, createdAt: new Date(), createdBy: "import" })),
      );

    await applySettings(tx as unknown as Db, companyId, companySettings, (slug) => agentId.get(slug));

    for (const t of pkg.tickets) {
      const project = projectId.get(t.project);
      if (!project) throw new ImportError(400, `Ticket "${t.title}" is in project "${t.project}", which isn't in the package.`);
      // A ref like HOL-228 stays searchable; Boss Man's own ids mean nothing on another server.
      const body = UUID.test(t.ref) ? (t.body ?? null) : `${t.body ? `${t.body}\n\n` : ""}Imported from ${t.ref}`;
      const assignee = t.assignee && t.assignee !== "owner" ? (agentId.get(t.assignee) ?? null) : null;
      const created = t.createdAt && !Number.isNaN(Date.parse(t.createdAt)) ? new Date(t.createdAt) : undefined;
      const [row] = await tx
        .insert(tickets)
        .values({
          companyId,
          projectId: project,
          title: t.title,
          number: numberOf.get(t.ref) ?? null,
          body,
          systemState: t.state,
          outcome: t.outcome ?? null,
          risk: t.risk ?? null,
          columnId: columnsOf.get(project)!.find((col) => col.systemState === t.state)?.id ?? null,
          featureId: (t.feature && featureId.get(t.feature)) || null,
          milestoneId: (t.milestone && milestoneId.get(t.milestone)) || null,
          assigneeAgentId: assignee,
          assignedToOwner: t.assignee === "owner",
          acceptanceCriteria: t.acceptanceCriteria.filter((x) => x.trim()),
          branch: t.branch ?? null,
          ...(created ? { createdAt: created } : {}),
        })
        .returning();
      ticketId.set(t.ref, row!.id);
    }
    for (const t of pkg.tickets) {
      const id = ticketId.get(t.ref)!;
      if (t.parent && ticketId.has(t.parent)) await tx.update(tickets).set({ parentTicketId: ticketId.get(t.parent)! }).where(eq(tickets.id, id));
      const blockers = t.waitsOn.map((r) => ticketId.get(r)).filter((x): x is string => !!x && x !== id);
      for (const b of blockers) await addTicketDependency(tx as unknown as Db, { companyId, blockedTicketId: id, blockerTicketId: b, actor: { type: "system" } });
      if (t.conversation.length)
        await tx.insert(ticketMessages).values(
          t.conversation.map((m) => ({ companyId, ticketId: id, author: m.author, agentId: (m.agent && agentId.get(m.agent)) || null, text: m.text, ...(m.author === "system" && m.from ? { delivery: `from:${m.from}` } : {}), ...(m.at && !Number.isNaN(Date.parse(m.at)) ? { createdAt: new Date(m.at) } : {}) })),
        );
    }

    const pages = pkg.wiki.length
      ? await tx
          .insert(wikiPages)
          .values(pkg.wiki.map((w) => ({ companyId, slug: w.slug.split("/").map(slugify).join("/"), folder: w.folder, title: w.title, body: w.body, ticketId: (w.ticket && ticketId.get(w.ticket)) || null })))
          .onConflictDoNothing()
          .returning({ id: wikiPages.id, title: wikiPages.title, body: wikiPages.body })
      : [];
    // An imported page keeps its imported text as its first version (BOS-430), so its first edit
    // doesn't make the original the one version nobody can get back.
    if (pages.length) await tx.insert(wikiRevisions).values(pages.map((p) => ({ pageId: p.id, title: p.title, body: p.body })));

    // What the owner still has to do, for the checklist decision.
    const slugName = (slug: string) => pkg.agents.find((a) => a.slug === slug)?.name ?? slug;
    const checklist = [
      ...(pkg.company.standingRules ? [`Standing rules came in as plain notes every run reads (they grant no permissions). Read them in Settings and change what doesn't fit:\n${pkg.company.standingRules}`] : []),
      ...pkg.secrets.map((s) => `Add the secret "${s.name}" and grant it as ${s.envName}${s.agents.length ? ` to ${s.agents.map(slugName).join(", ")}` : ""}.`),
      ...extras.lines,
      ...companySettings.lines,
      ...companySettings.todo,
      ...(opts.fundingSourceId ? [] : ["Give each agent a funding source."]),
      ...pkg.skills.filter((s) => s.files.some((f) => SCRIPT.test(f.path))).map((s) => `Read the scripts in the skill ${s.name} before agents use it.`),
      "Every imported agent is paused: check its model and instructions, then unpause it.",
      ...tightened,
    ];
    return { companyId, name, agentIds: [...agentId.values()], wikiPageIds: pages.map((p) => p.id), checklist };
  });
}

