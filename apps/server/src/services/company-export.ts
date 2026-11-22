// Company export (docs/11, step 1): the company as one zip, format "bossman-company/1". It holds
// the set-up (agents, skills, projects, plan, tool servers, secret names and grants, the company's own settings) and, when
// asked, the wiki and tickets. Never in it: secret values or hints, owner login, runs, costs.
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { readWatchdogSettings } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { liveTagOf, type TargetRules } from "./deploys.js";
import { agentAvatars, agentSkills, agents, companies, deployTargets, policyRules, features, keyResults, mcpServers, milestones, objectives, projects, secretGrantAgents, secretGrants, secrets, skills, ticketDependencies, ticketMessages, tickets, wikiPages, workflowColumns } from "../db/schema.js";
import { liveWikiPage, slugify } from "./wiki.js";
import { exportSettings } from "./company-settings-package.js";

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

  // The watchdog's switch travels with the company (BOS-762), so a package can ask for it and the
  // import can say in plain words when it kept it on anyway. Its limits are left out and take the defaults.
  files["company.json"] = json({ name: c.name, mission: c.mission, reviewPolicy: c.reviewPolicy, goalCheckDays: c.goalCheckDays, ownerApprovesEngagements: c.ownerApprovesEngagements, ticketPrefix: c.ticketPrefix, ...(c.standingRules?.trim() ? { standingRules: c.standingRules } : {}), watchdog: { enabled: readWatchdogSettings(c.watchdog).enabled } });

  // Agents, by a folder name other files refer to them by.
  const team = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt))).orderBy(asc(agents.createdAt));
  // lost on restart, harmless because it lives only for this one export call.
  const agentSlug = new Map<string, string>();
  const nextAgent = slugger();
  for (const a of team) agentSlug.set(a.id, nextAgent(a.name));
  const avatars = team.length ? await db.select().from(agentAvatars).where(inArray(agentAvatars.agentId, team.map((a) => a.id))) : [];
  for (const a of team) {
    const dir = `agents/${agentSlug.get(a.id)}`;
    files[`${dir}/agent.json`] = json({ ref: a.id, name: a.name, role: a.role, title: a.title, template: a.template, duty: a.duty, agentKind: a.agentKind, model: a.model, thinking: a.thinking, reportsTo: a.reportsTo ? (agentSlug.get(a.reportsTo) ?? null) : null, paused: a.paused });
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
  const grantView = (g: (typeof grants)[number]) => ({ name: g.name, kind: g.kind, envName: g.envName, agents: grantAgents.filter((x) => x.grantId === g.id).map((x) => agentSlug.get(x.agentId)).filter(Boolean) });
  files["secrets.json"] = json(grants.filter((g) => !g.deployTargetId).map(grantView));

  // Deploy targets (BOS-2169), with the secrets granted to each by name only. The host's own staging lane is left
  // out: the host creates it. A live tag's project id means nothing on another server, so it travels as the project's folder name.
  const targetRows = await db.select().from(deployTargets).where(eq(deployTargets.companyId, companyId)).orderBy(asc(deployTargets.name));
  files["deploy-targets.json"] = json(
    targetRows
      .filter((t) => (t.rules as TargetRules | null)?.hostStaging !== true)
      .map((t) => {
        const r = (t.rules ?? {}) as TargetRules;
        const lt = liveTagOf(t);
        return {
          name: t.name,
          kind: t.kind,
          endpoint: t.endpoint,
          isProduction: t.isProduction,
          rules: { ...(r.requiresApproval === true ? { requiresApproval: true } : {}), ...(lt && projectSlug.has(lt.projectId) ? { liveTag: { project: projectSlug.get(lt.projectId), name: lt.name } } : {}) },
          secrets: grants.filter((g) => g.deployTargetId === t.id).map(grantView),
        };
      }),
  );

  // The company's own permission rules, in their order. Global rules (no company) never leave; a rule limited to agents names them, not their ids.
  // A timed rule is left out: the export has no expiry, so on import it would turn into a rule that never ends (BOS-2188).
  const ruleRows = await db.select().from(policyRules).where(and(eq(policyRules.companyId, companyId), isNull(policyRules.expiresAt))).orderBy(asc(policyRules.position), asc(policyRules.name));
  const agentName = new Map(team.map((a) => [a.id, a.name]));
  files["permission-rules.json"] = json(
    ruleRows.map((r) => {
      const { agentIds, ...rest } = (r.condition ?? {}) as Record<string, unknown> & { agentIds?: string[] };
      return { name: r.name, trigger: r.trigger, condition: { ...rest, ...(Array.isArray(agentIds) ? { agents: agentIds.map((id) => agentName.get(id) ?? "(unknown agent)") } : {}) }, outcome: r.outcome, position: r.position };
    }),
  );

  // The company's own choices kept in the settings table (BOS-2242): agent approvals, git templates, the retro agent and
  // the second opinion. The second opinion's key travels by its secret's name only.
  files["settings.json"] = json(await exportSettings(db, companyId, agentSlug));

  if (opts.wiki) {
    const pages = await db.select().from(wikiPages).where(and(eq(wikiPages.companyId, companyId), liveWikiPage)).orderBy(asc(wikiPages.slug));
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
            number: t.number,
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
            conversation: msgs.filter((m) => m.ticketId === t.id).map((m) => ({ author: m.author, agent: m.agentId ? (agentSlug.get(m.agentId) ?? null) : null, text: m.text, at: m.createdAt, ...(m.author === "system" && m.delivery?.startsWith("from:") ? { from: m.delivery.slice(5) } : {}) })),
          }),
        )
        .join("\n") + (rows.length ? "\n" : ""),
    );
  }

  files["manifest.json"] = json({ format: EXPORT_FORMAT, exportedAt: now.toISOString(), company: c.name, includes: { wiki: opts.wiki, tickets: opts.tickets }, counts: { agents: team.length, skills: library.length, projects: ps.length } });
  return { name: `${slugify(c.name) || "company"}.bossman.zip`, bytes: zipSync(files, { level: 6 }) };
}
