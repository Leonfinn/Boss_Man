// The setup wizard (R56): where the owner is in it, and a checklist worked out from what's
// actually set up, so it's right however each thing got done (wizard, Settings, or the CEO).
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companies, owners, projects, runners, secretGrants, settings, tickets } from "../db/schema.js";

/** The first merge, stored once when first seen so a later revert or delete doesn't change it. `minutes` runs from the owner account's creation (setup start) to the merge. */
export type FirstMerge = { ref: string; ticketId: string; mergedAt: string; minutes: number };
export type SetupProgress = { dismissed: boolean; step: number; companyId: string | null; firstMerge: FirstMerge | null };
const KEY = "setup";

/** "2 h 40 min", "35 min", "3 h", "2 d 4 h". */
export function formatSetupDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}
/** The variables any agent can run on: a Claude setup-token, an API key, or a Bedrock, Foundry or gateway credential. */
const RUN_CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export function setupService(db: Db, deps: { isConnected: (runnerId: string) => boolean }) {
  return {
    async progress(): Promise<SetupProgress> {
      const read = async (): Promise<SetupProgress> => {
        const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
        return { dismissed: false, step: 0, companyId: null, firstMerge: null, ...((row?.value as Partial<SetupProgress> | undefined) ?? {}) };
      };
      const cur = await read();
      if (cur.firstMerge) return cur;
      // Not recorded yet: the earliest merged ticket in any company (also covers an install that merged before this existed).
      const [t] = await db
        .select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix, mergedAt: tickets.mergedAt })
        .from(tickets)
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .where(isNotNull(tickets.mergedAt))
        .orderBy(asc(tickets.mergedAt))
        .limit(1);
      if (!t?.mergedAt) return cur;
      const [o] = await db.select({ at: sql<Date | string | null>`min(${owners.createdAt})` }).from(owners);
      const start = o?.at ? new Date(o.at).getTime() : t.mergedAt.getTime();
      const firstMerge: FirstMerge = { ref: t.number != null ? `${t.prefix ?? "T"}-${t.number}` : (t.prefix ?? "A ticket"), ticketId: t.id, mergedAt: t.mergedAt.toISOString(), minutes: Math.max(0, Math.round((t.mergedAt.getTime() - start) / 60000)) };
      const value = { ...cur, firstMerge };
      await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    async save(patch: Partial<SetupProgress>) {
      const value = { ...(await this.progress()), ...patch };
      await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    /** The eight steps, each done or not, for the "Finish setting up" list. */
    async checklist(companyId: string) {
      const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
      if (!c) return null;
      const withRepo = await db.select({ id: projects.id, verify: projects.verifyCommand }).from(projects).where(and(eq(projects.companyId, companyId), isNotNull(projects.repoUrl)));
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
      const envs = (await db.select({ env: secretGrants.envName }).from(secretGrants).where(and(eq(secretGrants.companyId, companyId), inArray(secretGrants.envName, [...RUN_CREDENTIALS, "GIT_TOKEN"])))).map((g) => g.env);
      const [ceo] = await db.select({ fundingSourceId: agents.fundingSourceId }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
      const [ticketCount] = await db.select({ n: sql<number>`count(*)::int` }).from(tickets).where(eq(tickets.companyId, companyId));
      const { firstMerge } = await this.progress();
      return [
        { id: "company", label: "Say what the company is for", done: !!c.mission?.trim() },
        { id: "project", label: "Add a project with its repo", done: withRepo.length > 0 },
        { id: "runner", label: "Start the runner", done: !!runner && deps.isConnected(runner.id) },
        { id: "credential", label: "Add a Claude setup-token or API key", done: envs.some((e) => RUN_CREDENTIALS.includes(e)) },
        { id: "git", label: "Add a git token", done: envs.includes("GIT_TOKEN") },
        { id: "checks", label: "Choose the check before merging", done: withRepo.length > 0 && withRepo.every((p) => !!p.verify?.trim()) },
        { id: "funding", label: "Choose what pays for the CEO", done: !!ceo?.fundingSourceId },
        { id: "ticket", label: "Write a first ticket", done: (ticketCount?.n ?? 0) > 0 },
        { id: "merged", label: firstMerge ? `First ticket merged: ${firstMerge.ref}, ${formatSetupDuration(firstMerge.minutes)} after setup started` : "First ticket merged", done: !!firstMerge },
      ];
    },
  };
}
