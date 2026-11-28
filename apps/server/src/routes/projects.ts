// Projects and the setup wizard (R16, R56–R58), owner only. Moved out of app.ts unchanged (BOS-298 step 15).
// The caller passes its owner scope, so requireOwner and the app's error handler still apply:
// this registers routes on that instance rather than through app.register, which would add a new scope.
// The board and a project's ticket routes stay in app.ts with the other ticket routes.
import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { NO_CHECK, STANDARD_CHECKS, SYSTEM_STATES, findCredential, parseRepoUrl, repoUrlAllowed, usdToMicros, type DetectResult } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, costEvents, fundingSources, projects, runners as runnersTable, runs as runsTable, secretGrants, tickets } from "../db/schema.js";
import type { gitHostService } from "../services/git-hosts.js";
import { DEFAULT_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, WATCH_TOKEN_ENV, type githubWatchService } from "../services/github-watch.js";
import type { launcherService } from "../services/launcher.js";
import { record } from "../services/activity.js";
import { liveCheckWaitSql } from "../services/go-live-note.js";
import { BRIEF_TITLES, briefSlug, briefTicketBody, findBrief, openBriefTicket } from "../services/project-brief.js";
import { summarizeCostChecks } from "../services/cost-check.js";
import { monthStartUtc, projectMonthlyTrend, projectPlanUse, projectSpendMicros } from "../services/project-spend.js";
import { validZone } from "../services/spend-report.js";
import type { checkPolicy as checkPolicyIn } from "../services/review-policy.js";
import type { runnersService } from "../services/runners.js";
import type { secretsService } from "../services/secrets.js";
import type { setupService } from "../services/setup.js";
import { WorkError, type workService } from "../services/work.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });
const State = z.enum(SYSTEM_STATES);
const Column = z.object({ name: z.string().trim().min(1).max(60), systemState: State, wipLimit: z.number().int().positive().nullable().optional() });

export function projectRoutes(
  owner: FastifyInstance,
  db: Db,
  deps: {
    work: ReturnType<typeof workService>;
    launch: ReturnType<typeof launcherService>;
    gitHosts: ReturnType<typeof gitHostService>;
    setup: ReturnType<typeof setupService>;
    runners: ReturnType<typeof runnersService>;
    secretsSvc: ReturnType<typeof secretsService>;
    /** The company review-policy check, bound to the db (app.ts uses it for the company routes too). */
    checkPolicy: (companyId: string, body: unknown) => ReturnType<typeof checkPolicyIn>;
    /** Notes new scope for the CEO's next run; app.ts uses it for objectives and milestones too. */
    teamCheck: (companyId: string, what: string) => Promise<void>;
    githubWatch: ReturnType<typeof githubWatchService>;
    now?: () => Date;
  },
) {
  const { work, launch, gitHosts, setup, runners, secretsSvc, checkPolicy, teamCheck, githubWatch } = deps;

  /** The project's own policy, or null when it uses the company's. */
  owner.get("/api/projects/:id/review-policy", async (req, reply) => {
    const [p] = await db.select({ policy: projects.reviewPolicy }).from(projects).where(eq(projects.id, IdParam.parse(req.params).id));
    return p ? { policy: p.policy } : reply.code(404).send({ error: "not_found" });
  });
  owner.put("/api/projects/:id/review-policy", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [proj] = await db.select({ companyId: projects.companyId, name: projects.name }).from(projects).where(eq(projects.id, id));
    if (!proj) return reply.code(404).send({ error: "not_found" });
    const p = await checkPolicy(proj.companyId, req.body);
    if (typeof p === "string") return reply.code(400).send({ error: "invalid_review_policy", message: p });
    await db.update(projects).set({ reviewPolicy: p }).where(eq(projects.id, id));
    // Logged like the company's policy (routes/policy.ts), so a change in who reviews can be traced (BOS-1969).
    await record(db, { companyId: proj.companyId, kind: "settings", summary: `Owner changed the review policy for project ${proj.name}` });
    return { policy: p };
  });
  owner.delete("/api/projects/:id/review-policy", async (req, reply) => {
    const [p] = await db.update(projects).set({ reviewPolicy: null }).where(eq(projects.id, IdParam.parse(req.params).id)).returning({ companyId: projects.companyId, name: projects.name });
    if (!p) return reply.code(404).send({ error: "not_found" });
    await record(db, { companyId: p.companyId, kind: "settings", summary: `Owner reset project ${p.name} to the company review policy` });
    return { policy: null };
  });

  // The GitHub watcher's setting (BOS-1393): owner only, never an agent tool. The token is a company secret
  // (GITHUB_WATCH_TOKEN); only whether it is there is shown, never its value.
  const WatchBody = z
    .object({
      enabled: z.boolean(),
      repo: z.string().trim().max(140).regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, "The repository must look like owner/name."),
      intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES, `Check at most every ${MIN_INTERVAL_MINUTES} minutes.`).max(MAX_INTERVAL_MINUTES),
      watchAlerts: z.boolean(),
      watchIssues: z.boolean(),
      watchDiscussions: z.boolean(),
      skipLogins: z.array(z.string().trim().max(45)).max(20),
    })
    .partial();
  const watchView = async (projectId: string, companyId: string) => {
    const w = await githubWatch.get(projectId);
    // The grant's name only: reading it doesn't decrypt the token.
    const hasToken = (await secretsSvc.grantsForCompany(companyId)).some((g) => g.envName === WATCH_TOKEN_ENV && !g.deployTargetId);
    return {
      enabled: w?.enabled ?? false,
      repo: w?.repo ?? "",
      intervalMinutes: w?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
      watchAlerts: w?.watchAlerts ?? true,
      // BOS-2126: the other project that holds this repo's alert watching (old data only), so the choice is never silent.
      alertsHeldBy: await githubWatch.alertsHeldBy(projectId, companyId),
      watchIssues: w?.watchIssues ?? true,
      watchDiscussions: w?.watchDiscussions ?? true,
      skipLogins: w?.skipLogins ?? [],
      status: w?.status ?? "idle",
      lastError: w?.lastError ?? null,
      lastRunAt: w?.lastRunAt ?? null,
      lastNewNotes: w?.lastNewNotes ?? 0,
      backoffUntil: w?.backoffUntil ?? null,
      hasToken,
      tokenName: WATCH_TOKEN_ENV,
    };
  };
  owner.get("/api/projects/:id/github-watch", async (req, reply) => {
    const [p] = await db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, IdParam.parse(req.params).id));
    return p ? watchView(p.id, p.companyId) : reply.code(404).send({ error: "not_found" });
  });
  owner.put("/api/projects/:id/github-watch", async (req, reply) => {
    const [p] = await db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, IdParam.parse(req.params).id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    await githubWatch.save(p.id, p.companyId, WatchBody.parse(req.body));
    return watchView(p.id, p.companyId);
  });
  owner.post("/api/projects/:id/github-watch/check-now", async (req, reply) => {
    const [p] = await db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, IdParam.parse(req.params).id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    await githubWatch.runOne(p.id, { force: true });
    return watchView(p.id, p.companyId);
  });

  owner.get("/api/companies/:id/projects", async (req) => {
    const { id } = IdParam.parse(req.params);
    return db.select().from(projects).where(eq(projects.companyId, id)).orderBy(projects.name);
  });

  // One summary per project for the Projects list in settings (BOS-2421): open work, points left, finished in 30 days, this month's spend
  // (the same projectSpendMicros the budget page uses), and the last merge. One request for the whole company.
  owner.get("/api/companies/:id/projects-summary", async (req) => {
    const { id } = IdParam.parse(req.params);
    const t = deps.now ? deps.now() : new Date();
    const monthStart = monthStartUtc(t);
    const since = new Date(t.getTime() - 30 * 86_400_000);
    const open = sql`${tickets.systemState} <> 'done'`;
    const rows = await db
      .select({
        projectId: projects.id,
        monthlyCap: projects.monthlyCapMicros,
        open: sql<string>`count(${tickets.id}) filter (where ${open})`,
        inReview: sql<string>`count(${tickets.id}) filter (where ${tickets.systemState} = 'review')`,
        // BOS-2463: really blocked, leaving out merged work only waiting for a live check (the Dashboard's split).
        // BOS-2532 (G2): points and unsized count the same set, so a task saved with a size of 0 is unsized here too, not
        // "no points and not unsized" (the forecast reads it the same way, via effectiveSize in planning.ts).
        blocked: sql<string>`count(${tickets.id}) filter (where ${tickets.systemState} = 'blocked' and not ${liveCheckWaitSql})`,
        points: sql<string>`coalesce(sum(greatest(${tickets.size}, 1)) filter (where ${open} and ${tickets.size} > 0), 0)`,
        unsized: sql<string>`count(${tickets.id}) filter (where ${open} and (${tickets.size} is null or ${tickets.size} <= 0))`,
        finished: sql<string>`count(${tickets.id}) filter (where ${tickets.systemState} = 'done' and ${tickets.outcome} is distinct from 'cancelled' and ${tickets.stateChangedAt} >= ${since})`,
        lastMergeAt: sql<Date | null>`max(${tickets.mergedAt})`,
      })
      .from(projects)
      .leftJoin(tickets, eq(tickets.projectId, projects.id))
      .where(eq(projects.companyId, id))
      .groupBy(projects.id, projects.monthlyCapMicros);
    const out = [];
    for (const r of rows) {
      out.push({
        projectId: r.projectId,
        open: Number(r.open),
        inReview: Number(r.inReview),
        blocked: Number(r.blocked),
        pointsLeft: Number(r.points),
        unsized: Number(r.unsized),
        finishedLast30Days: Number(r.finished),
        monthMicros: await projectSpendMicros(db, r.projectId, monthStart),
        monthlyCapMicros: r.monthlyCap,
        lastMergeAt: r.lastMergeAt ? new Date(r.lastMergeAt).toISOString() : null,
      });
    }
    return { projects: out };
  });

  owner.post("/api/companies/:id/projects", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z.object({ name: z.string().trim().min(1).max(80), columns: z.array(Column).optional() }).parse(req.body);
    const p = await work.createProject(id, body.name, body.columns);
    await teamCheck(id, `created a project, "${p.name}" (${p.id})`);
    return reply.code(201).send(p);
  });

  owner.patch("/api/projects/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z
      .object({
        name: z.string().trim().min(1).max(80),
        repoUrl: z
          .string()
          .trim()
          .max(500)
          .refine(repoUrlAllowed, "Give an https://, ssh://, git@ or local path address. Plain http:// works for a LAN address such as http://192.0.2.10:3003/you/repo.git.")
          .refine((u) => !findCredential(u), "The address looks like it contains a credential. Grant a GIT_TOKEN secret to the company instead.")
          .nullable(),
        defaultBranch: z.string().trim().min(1).max(200),
        verifyCommand: z.string().trim().min(1).max(1000).nullable(),
        deepVerifyCommand: z.string().trim().min(1).max(1000).nullable(),
        ticketCostCapUsd: z.number().positive().nullable(),
        starred: z.boolean(),
        monthlyCapUsd: z.number().positive().nullable(),
        archived: z.boolean(),
        landing: z.enum(["merge", "pull_request"]),
        gitHost: z.enum(["github", "gitea"]).nullable(),
        gitApiBase: z
          .string()
          .trim()
          .max(500)
          .refine((u) => /^https:\/\//.test(u) || (u.startsWith("http://") && repoUrlAllowed(u)), "Give the API's https:// address, or http:// on a LAN address.")
          .nullable(),
      })
      .partial()
      .parse(req.body);
    const { ticketCostCapUsd, monthlyCapUsd, archived, ...fields } = b;
    // Archiving hides the project from agents, so work still open in it would be stranded.
    if (archived) {
      const [open] = await db.select({ n: count() }).from(tickets).where(and(eq(tickets.projectId, id), ne(tickets.systemState, "done")));
      if (open!.n) return reply.code(409).send({ error: "open_tickets", message: `This project has ${open!.n} open task${open!.n === 1 ? "" : "s"}. Finish or cancel ${open!.n === 1 ? "it" : "them"} before archiving.` });
    }
    if (archived !== undefined) Object.assign(fields, { archivedAt: archived ? new Date() : null, ...(archived ? { starred: false } : {}) });
    // A new repo address finds its host (R59), unless the owner set one with it.
    if (fields.repoUrl !== undefined && fields.gitHost === undefined) {
      const found = fields.repoUrl ? await gitHosts.detect(fields.repoUrl) : null;
      Object.assign(fields, { gitHost: found?.gitHost ?? null, gitApiBase: found?.gitApiBase ?? null });
    }
    // The owner set this git address themselves, so its private address is meant (a LAN git server); the guard keeps it (BOS-708).
    if (fields.repoUrl !== undefined) Object.assign(fields, { allowPrivate: !!fields.repoUrl });
    const [p] = await db
      .update(projects)
      .set({ ...fields, ...(ticketCostCapUsd !== undefined ? { ticketCostCapMicros: ticketCostCapUsd === null ? null : usdToMicros(ticketCostCapUsd) } : {}), ...(monthlyCapUsd !== undefined ? { monthlyCapMicros: monthlyCapUsd === null ? null : usdToMicros(monthlyCapUsd) } : {}) })
      .where(eq(projects.id, id))
      .returning();
    // A new repo address (or archiving) changes which git host the company's runner may reach.
    if (p && (fields.repoUrl !== undefined || archived !== undefined)) void launch.syncAllow(p.companyId);
    if (!p) return reply.code(404).send({ error: "not_found" });
    // Names the fields only, never their values: a repo address or command could carry something private (BOS-1987).
    const changed = Object.keys(b);
    if (changed.length) await record(db, { companyId: p.companyId, kind: "settings", summary: `Owner changed project ${p.name}: ${changed.join(", ")}` });
    return p;
  });

  // What a project has cost (money only, as on the dashboard: subscription use is excluded). "This month" is the UTC calendar month.
  owner.get("/api/projects/:id/spend", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [p] = await db.select({ cap: projects.ticketCostCapMicros, monthlyCap: projects.monthlyCapMicros }).from(projects).where(eq(projects.id, id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    const t = deps.now ? deps.now() : new Date();
    const monthStart = monthStartUtc(t);
    const month = await projectSpendMicros(db, id, monthStart);
    const all = await projectSpendMicros(db, id);
    // Costliest tasks: pay-as-you-go money and plan (subscription) list-price estimate, ranked by the two together (BOS-1563).
    const sum = sql<string>`sum(${costEvents.costMicros})`;
    const paygSum = sql<string>`coalesce(sum(${costEvents.costMicros}) filter (where ${fundingSources.kind} <> 'subscription'), 0)`;
    const planSum = sql<string>`coalesce(sum(${costEvents.costMicros}) filter (where ${fundingSources.kind} = 'subscription'), 0)`;
    const top = await db
      .select({ id: tickets.id, title: tickets.title, micros: paygSum, planMicros: planSum })
      .from(costEvents)
      .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
      .innerJoin(runsTable, eq(runsTable.id, costEvents.runId))
      .innerJoin(tickets, eq(tickets.id, runsTable.ticketId))
      .where(eq(tickets.projectId, id))
      .groupBy(tickets.id, tickets.title)
      .orderBy(desc(sum))
      .limit(10);
    const plan = await projectPlanUse(db, id, monthStart);
    // Tokens from every run on the project's tasks, subscription runs included (they have no money cost but still use the plan).
    const tokenSum = (since?: Date) =>
      db
        .select({ input: sql<string>`coalesce(sum(${runsTable.inputTokens}), 0)`, output: sql<string>`coalesce(sum(${runsTable.outputTokens}), 0)`, cacheRead: sql<string>`coalesce(sum(${runsTable.cachedReadTokens}), 0)`, cacheWrite: sql<string>`coalesce(sum(${runsTable.cachedWriteTokens}), 0)` })
        .from(runsTable)
        .innerJoin(tickets, eq(tickets.id, runsTable.ticketId))
        .where(since ? and(eq(tickets.projectId, id), gte(runsTable.startedAt, since)) : eq(tickets.projectId, id))
        .then(([r]) => ({ input: Number(r?.input ?? 0), output: Number(r?.output ?? 0), cacheRead: Number(r?.cacheRead ?? 0), cacheWrite: Number(r?.cacheWrite ?? 0) }));
    const tokens = { month: await tokenSum(monthStart), total: await tokenSum() };
    // The cost sanity check (BOS-1866): runs on this project's tasks whose recorded cost disagrees with their tokens at list price, and runs not checked.
    const costCheck = await summarizeCostChecks(db, sql`${runsTable.ticketId} in (select ${tickets.id} from ${tickets} where ${tickets.projectId} = ${id})` as ReturnType<typeof and>);
    // Month by month for the last 6 months, in the owner's time zone (the browser sends ?tz=, as the Spend page does; BOS-2369).
    const tz = (req.query as { tz?: string }).tz;
    const months = await projectMonthlyTrend(db, id, { timeZone: validZone(typeof tz === "string" ? tz : undefined), now: t });
    return { months, costCheck, tokens, monthMicros: month, totalMicros: all, ticketCostCapMicros: p.cap, monthlyCapMicros: p.monthlyCap, monthStart: monthStart.toISOString(), plan, topTickets: top.map((r) => ({ id: r.id, title: r.title, micros: Number(r.micros), planMicros: Number(r.planMicros) })) };
  });

  // The setup wizard (R56): where the owner is in it, and what's still to do for a company.
  owner.get("/api/setup-progress", async () => setup.progress());
  owner.put("/api/setup-progress", async (req) => setup.save(z.object({ dismissed: z.boolean(), left: z.boolean(), step: z.number().int().min(0).max(10), companyId: Uuid.nullable(), work: z.enum(["docs", "code"]) }).partial().parse(req.body)));
  owner.get("/api/companies/:id/setup-checklist", async (req, reply) => (await setup.checklist(IdParam.parse(req.params).id)) ?? reply.code(404).send({ error: "not_found" }));

  // BOS-2814: what keeps this company's agents from starting (a Claude account, who pays for the CEO, a running workspace).
  owner.get("/api/companies/:id/start-block", async (req, reply) => (await setup.startBlock(IdParam.parse(req.params).id)) ?? reply.code(404).send({ error: "not_found" }));

  // Is the company's git token good for this repo (R58, R56)? One read of the repo, with its permissions.
  owner.post("/api/projects/:id/check-git-token", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [p] = await db.select().from(projects).where(eq(projects.id, id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    const a = p.repoUrl ? parseRepoUrl(p.repoUrl) : null;
    if (!a || (p.gitHost !== "github" && p.gitHost !== "gitea") || !p.gitApiBase) return { ok: false, canPush: false, message: "Boss Man doesn't know this project's git host yet; save its repo address first." };
    const token = (await secretsSvc.resolveCompanyEnv(p.companyId, "check")).GIT_TOKEN;
    if (!token) return { ok: false, canPush: false, message: "The company has no GIT_TOKEN yet." };
    try {
      return await gitHosts.checkAccess({ kind: p.gitHost, apiBase: p.gitApiBase, owner: a.owner, repo: a.repo }, token);
    } catch (err) {
      return { ok: false, canPush: false, message: `Couldn't reach the host: ${(err as Error).message}` };
    }
  });

  // Does the company's Claude setup-token work (R58)? Only Claude Code can tell, so the runner
  // runs one tiny prompt with it, which uses a little of the subscription allowance.
  owner.post("/api/companies/:id/check-claude", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
    if (!c) return reply.code(404).send({ error: "not_found" });
    const [grant] = await db.select({ id: secretGrants.id }).from(secretGrants).where(and(eq(secretGrants.companyId, id), eq(secretGrants.envName, "CLAUDE_CODE_OAUTH_TOKEN")));
    if (!grant) return { ok: false, message: "The company has no Claude setup-token yet." };
    const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, id));
    if (!runner || !runners.isConnected(runner.id)) return { ok: false, message: "The company's runner isn't connected, and the check runs there." };
    try {
      return await runners.request<{ ok: boolean; message: string }>(runner.id, (requestId) => ({ type: "credential.check", requestId }), 2 * 60_000);
    } catch (err) {
      return { ok: false, message: `The runner couldn't run the check: ${(err as Error).message}` };
    }
  });

  // Merge check presets (R57): the runner proposes checks from the repo, alongside the standard ones.
  owner.post("/api/projects/:id/check-presets", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [p] = await db.select().from(projects).where(eq(projects.id, id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    const base = { standard: STANDARD_CHECKS, none: NO_CHECK };
    if (!p.repoUrl) return { ...base, detected: [], tools: null, error: "Set the project's git repo first." };
    const [runner] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, p.companyId));
    if (!runner || !runners.isConnected(runner.id)) return { ...base, detected: [], tools: null, error: "The company's runner isn't connected, so it can't look at the repo." };
    try {
      const r = await runners.request<DetectResult>(runner.id, (requestId) => ({ type: "workspace.detect", requestId, projectId: p.id, repoUrl: p.repoUrl!, baseRef: p.defaultBranch }), 2 * 60_000);
      return { ...base, detected: r.checks, tools: r.tools, error: null };
    } catch (err) {
      return { ...base, detected: [], tools: null, error: `The runner couldn't read the repo: ${(err as Error).message}` };
    }
  });

  owner.put("/api/projects/:id/columns", async (req) => {
    const { id } = IdParam.parse(req.params);
    return work.setColumns(id, z.array(Column).parse(req.body));
  });

  // The project brief: a wiki page the CEO writes from the code. One open brief ticket at a time.
  const briefStatus = async (projectId: string) => {
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!p) return null;
    const b = await findBrief(db, p.companyId, p.id);
    return { p, exists: !!b, status: { slug: briefSlug(p.id), exists: !!b, commit: b?.commit ?? null, branch: b?.branch ?? null, updatedAt: b?.updatedAt ?? null, ticketId: (await openBriefTicket(db, p.id))?.id ?? null } };
  };
  owner.get("/api/projects/:id/brief", async (req, reply) => (await briefStatus(IdParam.parse(req.params).id))?.status ?? reply.code(404).send({ error: "not_found" }));
  owner.post("/api/projects/:id/brief", async (req, reply) => {
    const b = await briefStatus(IdParam.parse(req.params).id);
    if (!b) return reply.code(404).send({ error: "not_found" });
    const open = await openBriefTicket(db, b.p.id);
    if (open) return open;
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, b.p.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (!ceo) throw new WorkError(400, "This company has no CEO to write the brief. Add one first.");
    const ticket = await work.createTicket(b.p.id, { title: b.exists ? BRIEF_TITLES[1]! : BRIEF_TITLES[0]!, body: briefTicketBody(b.p, b.exists), assigneeAgentId: ceo.id, noCode: true });
    return reply.code(201).send(ticket);
  });
}
