// The setup wizard (R56): where the owner is in it, and a checklist worked out from what's
// actually set up, so it's right however each thing got done (wizard, Settings, or the CEO).
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companies, projects, runners, secretGrants, settings, tickets } from "../db/schema.js";

export type SetupProgress = { dismissed: boolean; step: number; companyId: string | null };
const KEY = "setup";
/** The variables any agent can run on: a Claude setup-token or an API key. */
const RUN_CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

export function setupService(db: Db, deps: { isConnected: (runnerId: string) => boolean }) {
  return {
    async progress(): Promise<SetupProgress> {
      const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
      return { dismissed: false, step: 0, companyId: null, ...((row?.value as Partial<SetupProgress> | undefined) ?? {}) };
    },

    async save(patch: Partial<SetupProgress>) {
      const value = { ...(await this.progress()), ...patch };
      await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    /** The seven steps, each done or not, for the "Finish setting up" list. */
    async checklist(companyId: string) {
      const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
      if (!c) return null;
      const [project] = await db.select({ id: projects.id, verify: projects.verifyCommand }).from(projects).where(and(eq(projects.companyId, companyId), isNotNull(projects.repoUrl))).limit(1);
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
      const envs = (await db.select({ env: secretGrants.envName }).from(secretGrants).where(and(eq(secretGrants.companyId, companyId), inArray(secretGrants.envName, [...RUN_CREDENTIALS, "GIT_TOKEN"])))).map((g) => g.env);
      const [ceo] = await db.select({ fundingSourceId: agents.fundingSourceId }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
      const [ticketCount] = await db.select({ n: sql<number>`count(*)::int` }).from(tickets).where(eq(tickets.companyId, companyId));
      return [
        { id: "company", label: "Say what the company is for", done: !!c.mission?.trim() },
        { id: "project", label: "Add a project with its repo", done: !!project },
        { id: "runner", label: "Start the runner", done: !!runner && deps.isConnected(runner.id) },
        { id: "credential", label: "Add a Claude setup-token or API key", done: envs.some((e) => RUN_CREDENTIALS.includes(e)) },
        { id: "git", label: "Add a git token", done: envs.includes("GIT_TOKEN") },
        { id: "funding", label: "Choose what pays for the CEO", done: !!ceo?.fundingSourceId },
        { id: "ticket", label: "Write a first ticket", done: (ticketCount?.n ?? 0) > 0 },
      ];
    },
  };
}
