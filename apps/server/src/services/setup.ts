// The setup wizard (R56): where the owner is in it, and a checklist worked out from what's
// actually set up, so it's right however each thing got done (wizard, Settings, or the CEO).
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { CONNECT_ENV_NAMES } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, owners, projects, runners, secretGrants, settings, tickets } from "../db/schema.js";

/** The first merge, stored once when first seen so a later revert or delete doesn't change it. `minutes` runs from the owner account's creation (setup start) to the merge. */
export type FirstMerge = { ref: string; ticketId: string; mergedAt: string; minutes: number };
/** What the owner said the team works on (step 2): written documents and research, or code in a git repository. Not set until they choose. */
export type SetupWork = "docs" | "code";
/** `left`: the owner closed the wizard (Leave setup for now); the checklist stays until `dismissed` or everything is done. */
export type SetupProgress = { dismissed: boolean; left?: boolean; step: number; companyId: string | null; firstMerge: FirstMerge | null; work?: SetupWork };
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
/**
 * The variables any agent can run on: a Claude setup-token, an API key, or a Bedrock, Foundry or gateway
 * credential. The keys the connect step saves (CONNECT_ENV_NAMES, BOS-2815) are added too, so OpenRouter,
 * Ollama Cloud and Synthetic keys count as well.
 */
const RUN_CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_AUTH_TOKEN", ...CONNECT_ENV_NAMES];

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

    /**
     * BOS-2814: why an agent can't start yet, from the same facts the checklist reads. `items` are the must-haves
     * still missing (a Claude account, what pays for the CEO, a connected runner); `noFunding` are the agents with
     * nothing paying for them. Both empty means every agent can start.
     */
    async startBlock(companyId: string) {
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
      if (!c) return null;
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
      const envs = (await db.select({ env: secretGrants.envName }).from(secretGrants).where(and(eq(secretGrants.companyId, companyId), inArray(secretGrants.envName, RUN_CREDENTIALS)))).map((g) => g.env);
      const team = await db.select({ id: agents.id, role: agents.role, name: agents.name, fundingSourceId: agents.fundingSourceId }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt)));
      const ceo = team.find((a) => a.role === "ceo");
      const items: Array<{ id: "claude" | "funding" | "runner"; label: string; reason: string }> = [];
      if (envs.length === 0) items.push({ id: "claude", label: "a Claude account", reason: "the company has no Claude account to run on yet" });
      if (ceo && !ceo.fundingSourceId) {
        // What an agent's "Not started" line says, and its button: the CEO's account is the one the wizard's step 7 sets.
        const who = ceo.name === "CEO" ? "the CEO" : ceo.name;
        items.push({ id: "funding", label: "what pays for the CEO", reason: `${who} has no Claude account to run on yet` });
      }
      if (!runner || !deps.isConnected(runner.id)) items.push({ id: "runner", label: "a connected runner", reason: "the runner isn't connected" });
      return { items, noFunding: team.filter((a) => !a.fundingSourceId).map((a) => a.id) };
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
      const { firstMerge, work } = await this.progress();
      const [anyProject] = await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId)).limit(1);
      const base = [
        { id: "company", label: "Say what the company is for", done: !!c.mission?.trim() },
        { id: "runner", label: "Start the runner", done: !!runner && deps.isConnected(runner.id) },
        { id: "credential", label: "Add a Claude setup-token or API key", done: envs.some((e) => RUN_CREDENTIALS.includes(e)) },
        { id: "funding", label: "Choose what pays for the CEO", done: !!ceo?.fundingSourceId },
        { id: "ticket", label: "Write a first ticket", done: (ticketCount?.n ?? 0) > 0 },
      ];
      const at = (id: string) => base.findIndex((i) => i.id === id);
      // A company with a repo (or one that chose "Code") keeps the code items. Otherwise it gets a path that can finish:
      // whether a no-repo task sets mergedAt doesn't matter, "First task finished" counts tasks in the done state.
      if (withRepo.length > 0 || work === "code") {
        return [
          base[at("company")]!,
          { id: "project", label: "Add a project with its repo", done: withRepo.length > 0 },
          base[at("runner")]!,
          base[at("credential")]!,
          { id: "git", label: "Add a git token", done: envs.includes("GIT_TOKEN") },
          { id: "checks", label: "Choose the check before merging", done: withRepo.length > 0 && withRepo.every((p) => !!p.verify?.trim()) },
          base[at("funding")]!,
          base[at("ticket")]!,
          { id: "merged", label: firstMerge ? `First ticket merged: ${firstMerge.ref}, ${formatSetupDuration(firstMerge.minutes)} after setup started` : "First ticket merged", done: !!firstMerge },
        ];
      }
      const [finished] = await db.select({ n: sql<number>`count(*)::int` }).from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done"), sql`${tickets.outcome} is distinct from 'cancelled'`));
      return [
        base[at("company")]!,
        { id: "project", label: "Choose what you work on", done: !!anyProject },
        base[at("runner")]!,
        base[at("credential")]!,
        base[at("funding")]!,
        base[at("ticket")]!,
        { id: "merged", label: "First task finished", done: (finished?.n ?? 0) > 0 },
      ];
    },
  };
}
