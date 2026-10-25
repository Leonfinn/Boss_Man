// Company export (docs/11, step 1): the company as one zip, format "bossman-company/1". It holds
// the set-up (agents, skills, projects, plan, tool servers, secret names and grants) and, when
// asked, the wiki and tickets. Never in it: secret values or hints, owner login, runs, costs.
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import type { Db } from "../db/client.js";
import { agentAvatars, agentSkills, agents, companies, features, keyResults, mcpServers, milestones, objectives, projects, secretGrantAgents, secretGrants, secrets, skills, ticketDependencies, ticketMessages, tickets, wikiPages, workflowColumns } from "../db/schema.js";
import { slugify } from "./wiki.js";

export const EXPORT_FORMAT = "bossman-company/1";
export type ExportOptions = { wiki: boolean; tickets: "none" | "open" | "all" };

/** "Engineer", "Engineer" → "engineer", "engineer-2": a stable, unique folder name per row. */
function slugger() {
  // lost on restart, harmless because it lives only for this one export call.
  const used = new Set<string>();
  return (name: string) => {
    const base = slugify(name) || "item";
    let s = base;
    for (let n = 2; used.has(s); n++) s = `${base}-${n}`;
    used.add(s);
    return s;
  };
}

const json = (v: unknown) => strToU8(`${JSON.stringify(v, null, 2)}\n`);

export async function exportCompany(db: Db, companyId: string, opts: ExportOptions, now = new Date()) {
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!c) return null;
  const files: Record<string, Uint8Array> = {};

  files["company.json"] = json({ name: c.name, mission: c.mission, reviewPolicy: c.reviewPolicy, goalCheckDays: c.goalCheckDays, ownerApprovesEngagements: c.ownerApprovesEngagements });

  // Agents, by a folder name other files refer to them by.
  const team = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt))).orderBy(asc(agents.createdAt));
  // lost on restart, harmless because it lives only for this one export call.
  const agentSlug = new Map<string, string>();
  const nextAgent = slugger();
  for (const a of team) agentSlug.set(a.id, nextAgent(a.name));
  const avatars = team.length ? await db.select().from(agentAvatars).where(inArray(agentAvatars.agentId, team.map((a) => a.id))) : [];
  for (const a of team) {
    const dir = `agents/${agentSlug.get(a.id)}`;
    files[`${dir}/agent.json`] = json({ name: a.name, role: a.role, title: a.title, template: a.template, duty: a.duty, reviewKind: a.reviewKind, agentKind: a.agentKind, model: a.model, reportsTo: a.reportsTo ? (agentSlug.get(a.reportsTo) ?? null) : null, paused: a.paused });
    if (a.instructions) files[`${dir}/INSTRUCTIONS.md`] = strToU8(a.instructions);
    const pic = avatars.find((p) => p.agentId === a.id);
    if (pic) files[`${dir}/avatar.${pic.type.split("/")[1]?.replace("svg+xml", "svg") ?? "img"}`] = new Uint8Array(pic.bytes);
  }

  // Skills: every file as stored, and who has each.
  const library = await db.select().from(skills).where(eq(skills.companyId, companyId)).orderBy(asc(skills.name));
  const holders = library.length ? await db.select().from(agentSkills).where(inArray(agentSkills.skillId, library.map((s) => s.id))) : [];
  for (const s of library) for (const f of s.files) files[`skills/${s.name}/${f.path}`] = new Uint8Array(Buffer.from(f.content, "base64"));
  files["skills.json"] = json(
    library.map((s) => ({ name: s.name, description: s.description, source: s.source, sourceUrl: s.sourceUrl, sourceRef: s.sourceRef, pack: s.pack, packUrl: s.packUrl, requiresAddons: s.requiresAddons, agents: holders.filter((h) => h.skillId === s.id).map((h) => agentSlug.get(h.agentId)).filter(Boolean) })),
  );

  // Projects with their boards.
  const ps = await db.select().from(projects).where(eq(projects.companyId, companyId)).orderBy(asc(projects.createdAt));
  // lost on restart, harmless because it lives only for this one export call.
  const projectSlug = new Map<string, string>();
  const nextProject = slugger();
  for (const p of ps) projectSlug.set(p.id, nextProject(p.name));
  const columns = ps.length ? await db.select().from(workflowColumns).where(inArray(workflowColumns.projectId, ps.map((p) => p.id))).orderBy(asc(workflowColumns.position)) : [];
  for (const p of ps)
    files[`projects/${projectSlug.get(p.id)}/project.json`] = json({
      name: p.name,
      repoUrl: p.repoUrl,
      defaultBranch: p.defaultBranch,
      landing: p.landing,
      gitHost: p.gitHost,
      gitApiBase: p.gitApiBase,
      verifyCommand: p.verifyCommand,
      deepVerifyCommand: p.deepVerifyCommand,
      ticketCostCapMicros: p.ticketCostCapMicros,
      monthlyCapMicros: p.monthlyCapMicros,
      reviewPolicy: p.reviewPolicy,
      columns: columns.filter((col) => col.projectId === p.id).map((col) => ({ name: col.name, systemState: col.systemState, wipLimit: col.wipLimit })),
    });

  // The plan: objectives with key results and milestones, then features.
  const objs = await db.select().from(objectives).where(eq(objectives.companyId, companyId)).orderBy(asc(objectives.createdAt));
  const ids = objs.map((o) => o.id);
  const krs = ids.length ? await db.select().from(keyResults).where(inArray(keyResults.objectiveId, ids)) : [];
  const ms = ids.length ? await db.select().from(milestones).where(inArray(milestones.objectiveId, ids)) : [];
  const feats = await db.select().from(features).where(eq(features.companyId, companyId)).orderBy(asc(features.createdAt));
  files["plan.json"] = json({
    objectives: objs.map((o) => ({
      ref: o.id,
      title: o.title,
      priority: o.priority,
      status: o.status,
      project: o.projectId ? (projectSlug.get(o.projectId) ?? null) : null,
      keyResults: krs.filter((k) => k.objectiveId === o.id).map((k) => ({ title: k.title, target: k.target, current: k.current, unit: k.unit, method: k.method, checkSpec: k.checkSpec })),
      milestones: ms.filter((m) => m.objectiveId === o.id).map((m) => ({ ref: m.id, title: m.title, targetDate: m.targetDate, horizon: m.horizon })),
    })),
    features: feats.map((f) => ({ ref: f.id, title: f.title, description: f.description, status: f.status, effort: f.effort, parent: f.parentId, objective: f.objectiveId, milestone: f.milestoneId })),
  });

  files["tool-servers.json"] = json((await db.select().from(mcpServers).where(eq(mcpServers.companyId, companyId))).map((m) => ({ name: m.name, url: m.url, transport: m.transport, headerName: m.headerName, headerValue: m.headerValue, secretEnv: m.secretEnv })));

  // Secrets: names, kinds and who is granted them. The value and its hint never leave.
  const grants = await db
    .select({ id: secretGrants.id, envName: secretGrants.envName, name: secrets.name, kind: secrets.kind, deployTargetId: secretGrants.deployTargetId })
    .from(secretGrants)
    .innerJoin(secrets, eq(secrets.id, secretGrants.secretId))
    .where(eq(secretGrants.companyId, companyId));
  const grantAgents = grants.length ? await db.select().from(secretGrantAgents).where(inArray(secretGrantAgents.grantId, grants.map((g) => g.id))) : [];
  files["secrets.json"] = json(
    grants
      .filter((g) => !g.deployTargetId)
      .map((g) => ({ name: g.name, kind: g.kind, envName: g.envName, agents: grantAgents.filter((x) => x.grantId === g.id).map((x) => agentSlug.get(x.agentId)).filter(Boolean) })),
  );

  if (opts.wiki) {
    const pages = await db.select().from(wikiPages).where(eq(wikiPages.companyId, companyId)).orderBy(asc(wikiPages.slug));
    for (const p of pages) files[`wiki/${p.slug}.md`] = strToU8(`---\n${JSON.stringify({ slug: p.slug, title: p.title, folder: p.folder, ticket: p.ticketId })}\n---\n${p.body}`);
  }

  if (opts.tickets !== "none") {
    const rows = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), opts.tickets === "open" ? ne(tickets.systemState, "done") : undefined))
      .orderBy(asc(tickets.createdAt));
    const tids = rows.map((t) => t.id);
    const deps = tids.length ? await db.select().from(ticketDependencies).where(inArray(ticketDependencies.blockedTicketId, tids)) : [];
    const msgs = tids.length ? await db.select().from(ticketMessages).where(inArray(ticketMessages.ticketId, tids)).orderBy(asc(ticketMessages.createdAt)) : [];
    files["tickets.jsonl"] = strToU8(
      rows
        .map((t) =>
          JSON.stringify({
            ref: t.id,
            project: projectSlug.get(t.projectId) ?? null,
            title: t.title,
            body: t.body,
            state: t.systemState,
            outcome: t.outcome,
            risk: t.risk,
            parent: t.parentTicketId,
            feature: t.featureId,
            milestone: t.milestoneId,
            assignee: t.assigneeAgentId ? (agentSlug.get(t.assigneeAgentId) ?? null) : t.assignedToOwner ? "owner" : null,
            acceptanceCriteria: t.acceptanceCriteria,
            branch: t.branch,
            waitsOn: deps.filter((d) => d.blockedTicketId === t.id && d.blockerTicketId).map((d) => d.blockerTicketId),
            createdAt: t.createdAt,
            conversation: msgs.filter((m) => m.ticketId === t.id).map((m) => ({ author: m.author, agent: m.agentId ? (agentSlug.get(m.agentId) ?? null) : null, text: m.text, at: m.createdAt })),
          }),
        )
        .join("\n") + (rows.length ? "\n" : ""),
    );
  }

  files["manifest.json"] = json({ format: EXPORT_FORMAT, exportedAt: now.toISOString(), company: c.name, includes: { wiki: opts.wiki, tickets: opts.tickets }, counts: { agents: team.length, skills: library.length, projects: ps.length } });
  return { name: `${slugify(c.name) || "company"}.bossman.zip`, bytes: zipSync(files, { level: 6 }) };
}
