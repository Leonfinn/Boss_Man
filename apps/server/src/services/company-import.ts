// Company import (docs/11, step 2): reads a "bossman-company/1" package, shows what it would
// create, and applies it as a NEW company in one transaction. The package is untrusted: every
// path, size and field is checked, imported agents start paused, and no secret is created or
// granted (the owner adds each value; the checklist decision lists them).
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";
import { columnProblems, DEFAULT_REVIEW_POLICY, ReviewPolicySchema, repoUrlAllowed, findCredential, type ReviewPolicy } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agentAvatars, agentSkills, agents, companies, features, fundingSources, keyResults, mcpServers, milestones, objectives, projects, skills, ticketDependencies, ticketMessages, tickets, wikiPages, workflowColumns } from "../db/schema.js";
import { EXPORT_FORMAT } from "./company-export.js";
import { fromAgentCompanies, isAgentCompanies } from "./import-agent-companies.js";
import { MAX_BODY, slugify } from "./wiki.js";
import { cleanPath, LIMITS, normalise, parseSkillMd, skillName, SkillError, type SkillFile } from "./skills.js";

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
const Company = z.object({ name: z.string().trim().min(1).max(80), mission: opt(2000), reviewPolicy: z.unknown().optional(), goalCheckDays: z.number().int().min(1).max(365).optional(), ownerApprovesEngagements: z.boolean().optional() });
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
  reportsTo: opt(120),
  instructions: opt(100_000),
});
const SkillMeta = z.object({ name: z.string().max(64), source: z.enum(["written", "link", "upload"]).optional(), sourceUrl: opt(2000), sourceRef: opt(200), pack: opt(200), packUrl: opt(2000), requiresAddons: z.array(str(64)).max(20).nullable().optional(), agents: z.array(str(120)).max(500).default([]) });
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
const ToolServer = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).refine((n) => n !== "bossman"), url: str(500).refine((u) => /^https?:\/\//.test(u)), transport: z.enum(["http", "sse"]), headerName: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/).default("Authorization"), headerValue: str(200).default("Bearer {secret}"), secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable().optional() }).refine((v) => !v.secretEnv || v.headerValue.includes("{secret}"), "the header value must contain {secret}");
const Secret = z.object({ name: z.string().trim().min(1).max(200), kind: str(64), envName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), agents: z.array(str(120)).max(500).default([]) });
const WikiMeta = z.object({ slug: z.string().min(1).max(300), title: z.string().trim().min(1).max(300), folder: str(300).default(""), ticket: opt(100) });
const Ticket = z.object({
  ref: z.string().min(1).max(100),
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
  conversation: z.array(z.object({ author: z.enum(["owner", "agent", "system"]), agent: opt(120), text: z.string().max(100_000), at: z.string().max(40).optional() })).max(5000).default([]),
});

export type Package = {
  company: z.infer<typeof Company>;
  agents: Array<z.infer<typeof Agent> & { slug: string; avatar: { bytes: Uint8Array; type: string } | null }>;
  skills: Array<{ name: string; folder: string; description: string; files: SkillFile[]; bytes: number; meta: z.infer<typeof SkillMeta> | null }>;
  projects: Array<z.infer<typeof Project> & { slug: string }>;
  plan: z.infer<typeof Plan>;
  toolServers: Array<z.infer<typeof ToolServer>>;
  secrets: Array<z.infer<typeof Secret>>;
  wiki: Array<z.infer<typeof WikiMeta> & { body: string }>;
  tickets: Array<z.infer<typeof Ticket>>;
  /** What an adapter changed or left out on the way in. */
  notes: string[];
};

/** The picture's type from its first bytes, as the upload route checks it: PNG, JPEG or WebP only, never what the name claims. */
const pictureType = (b: Uint8Array) => {
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

  return {
    company,
    agents: pkgAgents,
    skills: pkgSkills,
    projects: pkgProjects,
    plan: parse(Plan, json("plan.json") ?? {}, "plan.json"),
    toolServers: parse(z.array(ToolServer).max(100), json("tool-servers.json") ?? [], "tool-servers.json"),
    secrets: parse(z.array(Secret).max(500), json("secrets.json") ?? [], "secrets.json"),
    wiki,
    tickets: pkgTickets,
    notes,
  };
}

/** What applying the package would create, and what the owner should look at first. */
export async function previewPackage(db: Db, pkg: Package, name = pkg.company.name) {
  const [taken] = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name));
  const warnings: string[] = [...pkg.notes];
  if (!pkg.agents.some((a) => a.role === "ceo")) warnings.push("The package has no CEO; hire one after importing.");
  return {
    company: { name, nameTaken: !!taken },
    counts: { agents: pkg.agents.length, skills: pkg.skills.length, projects: pkg.projects.length, objectives: pkg.plan.objectives.length, features: pkg.plan.features.length, toolServers: pkg.toolServers.length, wikiPages: pkg.wiki.length, tickets: pkg.tickets.length },
    agents: pkg.agents.map((a) => ({ name: a.name, role: a.role, title: a.title ?? null, agentKind: a.agentKind, model: a.model ?? null, instructions: a.instructions ?? null })),
    skills: pkg.skills.map((s) => ({ name: s.name, renamedFrom: s.name !== s.folder ? s.folder : null, description: s.description, scripts: s.files.map((f) => f.path).filter((p) => SCRIPT.test(p)) })),
    secrets: pkg.secrets.map((s) => ({ name: s.name, envName: s.envName, agents: s.agents })),
    warnings,
  };
}

/** Swaps the package's agent ids in a review policy for the new ones; an id it can't place becomes the CEO. */
function remapPolicy(policy: unknown, ids: Map<string, string>): ReviewPolicy {
  if (policy === undefined || policy === null) return DEFAULT_REVIEW_POLICY;
  const swapped = JSON.parse(JSON.stringify(policy).replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi, (_m, id: string) => JSON.stringify(ids.get(id) ?? "ceo")));
  const r = ReviewPolicySchema.safeParse(swapped);
  return r.success ? r.data : DEFAULT_REVIEW_POLICY;
}

/** Creates the package as a new company in one transaction. Every agent starts paused. */
export async function applyPackage(db: Db, pkg: Package, opts: { name?: string; fundingSourceId?: string | null } = {}) {
  const name = opts.name?.trim() || pkg.company.name;
  if (opts.fundingSourceId && !(await db.select({ id: fundingSources.id }).from(fundingSources).where(eq(fundingSources.id, opts.fundingSourceId))).length) throw new ImportError(400, "No such funding source.");
  if ((await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name))).length) throw new ImportError(409, `There's already a company called ${name}. Pick another name.`);

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

    const [c] = await tx.insert(companies).values({ name, mission: pkg.company.mission ?? null, goalCheckDays: pkg.company.goalCheckDays, ownerApprovesEngagements: pkg.company.ownerApprovesEngagements }).returning();
    const companyId = c!.id;

    for (const a of pkg.agents) {
      const [row] = await tx
        .insert(agents)
        .values({ companyId, name: a.name, role: a.role, title: a.title ?? null, template: a.template ?? null, duty: a.duty ?? null, reviewKind: a.reviewKind ?? null, agentKind: a.agentKind, model: a.model ?? null, instructions: a.instructions ?? null, fundingSourceId: opts.fundingSourceId ?? null, paused: true, avatarAt: a.avatar ? new Date() : null })
        .returning();
      agentId.set(a.slug, row!.id);
      if (a.ref) agentRef.set(a.ref, row!.id);
      if (a.avatar) await tx.insert(agentAvatars).values({ agentId: row!.id, bytes: Buffer.from(a.avatar.bytes), type: a.avatar.type });
    }
    for (const a of pkg.agents) if (a.reportsTo && agentId.has(a.reportsTo)) await tx.update(agents).set({ reportsTo: agentId.get(a.reportsTo)! }).where(eq(agents.id, agentId.get(a.slug)!));
    await tx.update(companies).set({ reviewPolicy: remapPolicy(pkg.company.reviewPolicy, agentRef) }).where(eq(companies.id, companyId));

    for (const s of pkg.skills) {
      const m = s.meta;
      const [row] = await tx
        .insert(skills)
        .values({ companyId, name: s.name, description: s.description, source: m?.source ?? "upload", sourceUrl: m?.sourceUrl ?? null, sourceRef: m?.sourceRef ?? null, pack: m?.pack ?? null, packUrl: m?.packUrl ?? null, requiresAddons: m?.requiresAddons ?? null, files: s.files, sizeBytes: s.bytes })
        .returning();
      const holders = (m?.agents ?? []).map((slug) => agentId.get(slug)).filter((x): x is string => !!x);
      if (holders.length) await tx.insert(agentSkills).values(holders.map((id) => ({ agentId: id, skillId: row!.id })));
    }

    for (const p of pkg.projects) {
      const { slug, columns, reviewPolicy, ...fields } = p;
      const [row] = await tx
        .insert(projects)
        .values({ companyId, ...fields, reviewPolicy: reviewPolicy === undefined || reviewPolicy === null ? null : remapPolicy(reviewPolicy, agentRef) })
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

    if (pkg.toolServers.length) await tx.insert(mcpServers).values(pkg.toolServers.map((t) => ({ companyId, ...t, secretEnv: t.secretEnv ?? null })));

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
      if (blockers.length) await tx.insert(ticketDependencies).values(blockers.map((b) => ({ blockedTicketId: id, blockerTicketId: b })));
      if (t.conversation.length)
        await tx.insert(ticketMessages).values(
          t.conversation.map((m) => ({ companyId, ticketId: id, author: m.author, agentId: (m.agent && agentId.get(m.agent)) || null, text: m.text, ...(m.at && !Number.isNaN(Date.parse(m.at)) ? { createdAt: new Date(m.at) } : {}) })),
        );
    }

    const pages = pkg.wiki.length
      ? await tx
          .insert(wikiPages)
          .values(pkg.wiki.map((w) => ({ companyId, slug: w.slug.split("/").map(slugify).join("/"), folder: w.folder, title: w.title, body: w.body, ticketId: (w.ticket && ticketId.get(w.ticket)) || null })))
          .onConflictDoNothing()
          .returning({ id: wikiPages.id })
      : [];

    // What the owner still has to do, for the checklist decision.
    const slugName = (slug: string) => pkg.agents.find((a) => a.slug === slug)?.name ?? slug;
    const checklist = [
      ...pkg.secrets.map((s) => `Add the secret "${s.name}" and grant it as ${s.envName}${s.agents.length ? ` to ${s.agents.map(slugName).join(", ")}` : ""}.`),
      ...(opts.fundingSourceId ? [] : ["Give each agent a funding source."]),
      ...pkg.skills.filter((s) => s.files.some((f) => SCRIPT.test(f.path))).map((s) => `Read the scripts in the skill ${s.name} before agents use it.`),
      "Every imported agent is paused: check its model and instructions, then unpause it.",
    ];
    return { companyId, name, agentIds: [...agentId.values()], wikiPageIds: pages.map((p) => p.id), checklist };
  });
}

