// Self-deploy, phase 1 (docs/09-self-deploy.md): Boss Man updating itself through the host deployer.
// The server never runs anything on the host. It reads what the host script publishes (outbox:
// available.json, status.json), raises an owner decision when main has moved, and on approval
// writes one small request file (inbox) that the host script validates and acts on.
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { companies, decisions, owners, settings } from "../db/schema.js";
import { record } from "./activity.js";
import { AnswerError, DEPLOY, NOT_NOW, UPDATE_RUNNERS, type DecisionContext } from "./decisions.js";
import type { NotifyInput } from "./notifications.js";

type SelfDeployContext = Extract<DecisionContext, { type: "self_deploy" }>;

const Available = z.object({
  checkedAt: z.string(),
  deployed: z.string(),
  tip: z.string(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string().optional() })).default([]),
  paths: z.array(z.string()).default([]),
  infraPaths: z.array(z.string()).default([]),
  runnerChanged: z.boolean().default(false),
});
export type Available = z.infer<typeof Available>;

const Status = z.object({
  id: z.string(),
  target: z.enum(["server", "runner"]),
  result: z.enum(["running", "deployed", "nothing_new", "rejected", "failed", "partial", "rolled_back"]),
  message: z.string(),
  from_commit: z.string(),
  to_commit: z.string(),
  started: z.string(),
  ended: z.string(),
  backup: z.string().default(""),
});
export type DeployStatus = z.infer<typeof Status>;

const short = (sha: string) => sha.slice(0, 8);
/** The ladder: success is a note, a refusal a flag, anything half-done or broken a page. */
const LEVEL = { deployed: "note", nothing_new: "note", rejected: "flag", failed: "page", partial: "page", rolled_back: "page", running: "note" } as const;

export function selfDeployService(db: Db, deps: { dir?: string; notify: (n: NotifyInput) => Promise<unknown>; log?: (msg: string) => void }) {
  const dir = deps.dir;
  const inboxFile = dir && path.join(dir, "inbox", "request.json");
  const readJson = async <T>(file: string, schema: z.ZodType<T>): Promise<T | null> => {
    try {
      return schema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch {
      return null; // missing, half-written or from a newer host script: treated as "nothing yet"
    }
  };
  const available = () => (dir ? readJson(path.join(dir, "outbox", "available.json"), Available) : Promise.resolve(null));
  const status = () => (dir ? readJson(path.join(dir, "outbox", "status.json"), Status) : Promise.resolve(null));
  const pending = async () => !!inboxFile && (await stat(inboxFile).then(() => true, () => false));

  /** Boss Man itself belongs to no company, but a decision needs one: the oldest. */
  async function homeCompany() {
    const [c] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
    return c?.id ?? null;
  }

  async function openFor(target: string) {
    return db
      .select()
      .from(decisions)
      .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'self_deploy'`, sql`${decisions.context}->>'target' = ${target}`));
  }

  /** Raises the decision for a commit. `again` lets the owner be asked about one they already put off. */
  async function raise(target: "server" | "runner", commit: string, fromCommit: string, a: Available | null, again = false) {
    const companyId = await homeCompany();
    if (!companyId) return null;
    const infra = target === "server" && (a?.infraPaths.length ?? 0) > 0;
    const ctx: SelfDeployContext = { type: "self_deploy", target, commit, fromCommit, ...(infra ? { infra: true } : {}), ...(a?.runnerChanged && target === "server" ? { runnerChanged: true } : {}) };
    const subjects = (a?.commits ?? []).slice(0, 5).map((c) => `- ${c.subject ?? short(c.sha)}`).join("\n");
    const n = a?.paths.length ?? 0;
    const migrations = (a?.paths ?? []).filter((p) => p.startsWith("apps/server/drizzle/")).length;
    const areas = `${n} file${n === 1 ? "" : "s"} changed${migrations ? `, ${migrations} database migration${migrations === 1 ? "" : "s"}` : ""}${a?.runnerChanged ? ", runner code changed (separate approval after this)" : ""}`;
    const question =
      target === "runner"
        ? `Update the runners to ${short(commit)}? The new image is built and checked first. Then nothing new starts in any company; runs in progress finish (you are asked after about 30 minutes if some are still going), and each company's runner is swapped as soon as it is idle. Without the launcher the runners restart at once and cut runs off.`
        : infra
          ? `Main has moved to ${short(commit)}, but the change touches deployment files (${a!.infraPaths.slice(0, 5).join(", ")}), so Boss Man cannot deploy it. Run scripts/deploy.sh at the NAS yourself.`
          : `Deploy Boss Man ${short(fromCommit)} -> ${short(commit)}? ${areas}.${subjects ? `\n${subjects}` : ""}\nThe database is backed up first, then Boss Man restarts (a minute or two).`;
    const options = infra ? ["Got it"] : target === "runner" ? [UPDATE_RUNNERS, NOT_NOW] : [DEPLOY, NOT_NOW];
    const [row] = await db
      .insert(decisions)
      .values({
        companyId,
        kind: "approval",
        question,
        options,
        recommendedOption: options[0]!,
        dedupeKey: `self-deploy:${target}:${commit}${again ? `:${randomBytes(3).toString("hex")}` : ""}`,
        context: ctx,
      })
      .onConflictDoNothing()
      .returning();
    if (row && target === "server") {
      // An older, still-open question about an earlier commit can no longer be answered: the host only deploys the tip.
      for (const d of await openFor("server")) if (d.id !== row.id) await db.update(decisions).set({ status: "withdrawn" }).where(eq(decisions.id, d.id));
    }
    return row ?? null;
  }

  async function saveSeen(key: string) {
    await db.insert(settings).values({ key: "self_deploy", value: { notified: key } }).onConflictDoUpdate({ target: settings.key, set: { value: { notified: key } } });
  }

  /** A deploy has ended: tell the owner once, record it on the decision, and offer the runner update when it is due. */
  async function finished(s: DeployStatus) {
    const [row] = await db.select().from(settings).where(eq(settings.key, "self_deploy"));
    const key = `${s.id}:${s.result}:${s.ended}`;
    if ((row?.value as { notified?: string } | undefined)?.notified === key) return;
    await saveSeen(key);
    // The host writes an empty id when it refused a file it could not read.
    const [d] = z.string().uuid().safeParse(s.id).success ? await db.select().from(decisions).where(eq(decisions.id, s.id)) : [];
    const ctx = d?.context as DecisionContext | undefined;
    const what = s.target === "runner" ? "The runners" : "Boss Man";
    // A runner "deploy" now only builds the image and asks for the drain; the swap's own result is reported by the drain (maintenance.ts).
    const title = s.result === "deployed" && s.target === "runner" ? `New runner image ready (${short(s.to_commit)}); update waiting for runs to finish` : s.result === "deployed" ? `${what} updated to ${short(s.to_commit)}` : s.result === "nothing_new" ? `${what} was already up to date` : `Update ${s.result === "rejected" ? "refused" : "failed"}: ${short(s.to_commit)}`;
    await deps.notify({ companyId: null, level: LEVEL[s.result], title, body: s.message, link: "#/settings" });
    if (d && ctx?.type === "self_deploy") {
      await db.update(decisions).set({ context: { ...ctx, result: { result: s.result, message: s.message, at: s.ended } } }).where(eq(decisions.id, d.id));
      await record(db, { companyId: d.companyId, kind: "self_deploy", summary: `${title}. ${s.message}` });
      // The server is deployed; the runners are a separate question the owner answers on its own.
      if (s.target === "server" && s.result === "deployed" && ctx.runnerChanged) await raise("runner", s.to_commit, s.from_commit, null);
    }
  }

  return {
    enabled: !!dir,

    /** One pass of the poller. // leader-only: phase 3 runs this on the leader alone. */
    async sync() {
      if (!dir) return;
      const s = await status();
      if (s && s.result !== "running") await finished(s);
      const a = await available();
      if (!a || !a.tip || s?.result === "running" || (await pending())) return;
      if (a.tip === a.deployed) {
        for (const d of await openFor("server")) await db.update(decisions).set({ status: "withdrawn" }).where(eq(decisions.id, d.id));
        return;
      }
      await raise("server", a.tip, a.deployed, a);
    },

    /** The "Deploy latest" button. Returns the open decision, or says why there is none. */
    async deployLatest() {
      const a = await available();
      if (!dir) return { error: "Self-deploy is not set up on this install." } as const;
      if (!a || !a.tip) return { error: "The host deployer has not reported yet. Check that its cron job is running." } as const;
      if (a.tip === a.deployed) return { error: `Already up to date (${short(a.deployed)}), checked ${a.checkedAt}.` } as const;
      const open = (await openFor("server")).find((d) => (d.context as SelfDeployContext).commit === a.tip);
      const d = open ?? (await raise("server", a.tip, a.deployed, a, true));
      return d ? ({ decisionId: d.id } as const) : ({ error: "Create a company first: decisions belong to one." } as const);
    },

    /** What Settings shows. */
    async overview() {
      return { enabled: !!dir, status: await status(), available: await available(), pending: await pending() };
    },

    /** Checked before an approval is recorded: one request at a time. */
    async check(ctx: SelfDeployContext) {
      if (!inboxFile) throw new AnswerError("Self-deploy is not set up on this install (BOSSMAN_DEPLOYER_DIR).");
      const s = await status();
      if (s?.result === "running") throw new AnswerError("A deploy is running now. Wait for it to finish.");
      if (await pending()) throw new AnswerError("A deploy request is already waiting for the host. Try again in a minute.");
      if (ctx.target === "runner" && s?.target === "server" && s.result !== "deployed") throw new AnswerError("The server deploy has not succeeded, so the runners are not updated.");
    },

    /** Hands the approved request to the host: written beside its final name, then renamed, so the host never reads half a file. // leader-only */
    async send(ctx: SelfDeployContext, decisionId: string) {
      const [o] = await db.select({ id: owners.id }).from(owners).limit(1);
      const body = { id: decisionId, target: ctx.target, commit: ctx.commit, requestedAt: new Date().toISOString(), approvedBy: o?.id ?? "owner" };
      const tmp = `${inboxFile}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o640 });
      await rename(tmp, inboxFile!);
    },
  };
}
export type SelfDeploy = ReturnType<typeof selfDeployService>;
