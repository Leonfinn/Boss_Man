// Deploy targets and deploys (R14, R15). A target is a named connection (an SSH host, a
// Docker endpoint or a git repo) with its own secrets. An agent asks to deploy a ref to a
// target; production targets wait for the owner. Only the run that carries out an approved
// deploy receives the target's secrets, and only while the deploy is running.
import { and, asc, eq } from "drizzle-orm";
import { findCredential } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, decisions, deploys, deployTargets, tickets } from "../db/schema.js";

export class DeployError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Target = typeof deployTargets.$inferSelect;
type Deploy = typeof deploys.$inferSelect;
export type TargetInput = { name: string; kind: Target["kind"]; endpoint: string; isProduction?: boolean; requiresApproval?: boolean };
type WakeHook = (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number; deployId?: string; causedByRunId?: string | null }) => Promise<unknown>;

const RAW_DOCKER_SOCKET = /(^|:\/\/)\/?(var\/)?run\/docker\.sock$/;

/** Rejects endpoints that would hand an agent root on the host, or that carry a credential. */
export function endpointProblem(kind: Target["kind"], endpoint: string): string | null {
  const e = endpoint.trim();
  if (RAW_DOCKER_SOCKET.test(e)) {
    return "The raw Docker socket gives root on the host. Put a Docker socket proxy in front of it (for example tecnativa/docker-socket-proxy) and use its tcp:// address.";
  }
  const cred = findCredential(e);
  if (cred) return `The endpoint looks like it contains ${cred}. Store credentials as secrets and grant them to the target instead.`;
  const ok =
    kind === "ssh" ? /^(ssh:\/\/)?[a-z_][a-z0-9_.-]*@[A-Za-z0-9.-]+(:\d+)?$/.test(e) : kind === "docker" ? /^(tcp|https?):\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(e) : /^(https:\/\/\S+|ssh:\/\/\S+|git@[A-Za-z0-9.-]+:\S+)$/.test(e);
  if (!ok) {
    return kind === "ssh"
      ? "Give an SSH target as user@host or ssh://user@host:port, with a restricted deploy user."
      : kind === "docker"
        ? "Give a Docker endpoint as tcp://host:port or https://host:port, such as a socket proxy."
        : "Give a git remote as an https://, ssh:// or git@host:repo address.";
  }
  return null;
}

export function deploysService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  let wake: WakeHook | null = null;

  const needsApproval = (t: Target) => t.isProduction || (t.rules as { requiresApproval?: boolean }).requiresApproval === true;

  async function load(id: string) {
    const [d] = await db.select().from(deploys).where(eq(deploys.id, id));
    if (!d) throw new DeployError(404, "No such deploy.");
    return d;
  }

  async function target(id: string) {
    const [t] = await db.select().from(deployTargets).where(eq(deployTargets.id, id));
    if (!t) throw new DeployError(404, "No such deploy target.");
    return t;
  }

  async function startWhenApproved(d: Deploy, t: Target, causedByRunId?: string | null) {
    const [row] = await db.update(deploys).set({ status: "approved" }).where(eq(deploys.id, d.id)).returning();
    if (d.agentId && wake) {
      await wake({
        agentId: d.agentId,
        ticketId: d.ticketId,
        reason: "deploy approved",
        priority: 3,
        deployId: d.id,
        causedByRunId,
        note: `Deploy ${d.id} is approved: ship ${d.ref} to ${t.name} (${t.kind} ${t.endpoint}). This run has the target's secrets in its environment, and only this run. When you've finished, report the result with the deploy tool (action "report", outcome succeeded or failed).`,
      });
    }
    return row!;
  }

  return {
    setWakeHook(hook: WakeHook) {
      wake = hook;
    },

    async createTarget(companyId: string, input: TargetInput) {
      const problem = endpointProblem(input.kind, input.endpoint);
      if (problem) throw new DeployError(422, problem);
      const [t] = await db
        .insert(deployTargets)
        .values({ companyId, name: input.name, kind: input.kind, endpoint: input.endpoint.trim(), isProduction: input.isProduction ?? false, rules: { requiresApproval: input.requiresApproval ?? false } })
        .returning();
      return t!;
    },

    async updateTarget(id: string, patch: Partial<TargetInput>) {
      const t = await target(id);
      const kind = patch.kind ?? t.kind;
      const endpoint = patch.endpoint ?? t.endpoint;
      const problem = endpointProblem(kind, endpoint);
      if (problem) throw new DeployError(422, problem);
      const [row] = await db
        .update(deployTargets)
        .set({
          ...(patch.name ? { name: patch.name } : {}),
          kind,
          endpoint: endpoint.trim(),
          ...(patch.isProduction != null ? { isProduction: patch.isProduction } : {}),
          ...(patch.requiresApproval != null ? { rules: { ...(t.rules as object), requiresApproval: patch.requiresApproval } } : {}),
        })
        .where(eq(deployTargets.id, id))
        .returning();
      return row!;
    },

    async deleteTarget(id: string) {
      const rows = await db.delete(deployTargets).where(eq(deployTargets.id, id)).returning({ id: deployTargets.id });
      return rows.length > 0;
    },

    async listTargets(companyId: string) {
      return db.select().from(deployTargets).where(eq(deployTargets.companyId, companyId)).orderBy(asc(deployTargets.name));
    },

    /** An agent asks to ship a ref. Production (or a target that asks for it) waits for the owner (R15). */
    async request(actor: { companyId: string; agentId: string | null; runId?: string | null }, input: { target: string; ref: string; notes?: string; ticketId?: string }) {
      const all = await db.select().from(deployTargets).where(eq(deployTargets.companyId, actor.companyId));
      const t = all.find((x) => x.id === input.target || x.name.toLowerCase() === input.target.toLowerCase());
      if (!t) throw new DeployError(404, all.length ? `No deploy target called "${input.target}". Targets: ${all.map((x) => x.name).join(", ")}.` : "Your company has no deploy targets; ask the owner to add one.");
      const cred = findCredential(`${input.ref} ${input.notes ?? ""}`);
      if (cred) throw new DeployError(422, `That looks like it contains ${cred}. Deploy requests never carry credentials.`);
      if (input.ticketId) {
        const [tk] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, actor.companyId)));
        if (!tk) throw new DeployError(422, "No ticket with that ID in your company.");
      }
      const [d] = await db
        .insert(deploys)
        .values({ companyId: actor.companyId, targetId: t.id, agentId: actor.agentId, ticketId: input.ticketId ?? null, ref: input.ref, notes: input.notes ?? null, createdAt: now() })
        .returning();
      if (!needsApproval(t)) return { deploy: await startWhenApproved(d!, t, actor.runId), note: "Approved; you'll be woken in a run that holds the target's secrets." };

      const [agent] = actor.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, actor.agentId)) : [];
      await db.insert(decisions).values({
        companyId: actor.companyId,
        kind: "approval",
        question: `${agent?.name ?? "An agent"} wants to deploy ${input.ref} to ${t.name}${t.isProduction ? " (production)" : ""}.${input.notes ? ` Notes: ${input.notes}` : ""}`,
        options: ["Approve", "Reject"],
        recommendedOption: "Approve",
        raisedByAgentId: actor.agentId,
        tier: "owner",
        context: { type: "deploy", deployId: d!.id },
      });
      return { deploy: d!, note: "Waiting for the owner to approve. You'll be woken with the answer; don't wait in this turn." };
    },

    /** The owner's answer to a deploy approval. */
    async approve(id: string, approved: boolean) {
      const d = await load(id);
      if (d.status !== "pending_approval") return d;
      const t = await target(d.targetId);
      if (approved) return startWhenApproved(d, t);
      const [row] = await db.update(deploys).set({ status: "rejected", finishedAt: now() }).where(eq(deploys.id, id)).returning();
      if (d.agentId && wake) await wake({ agentId: d.agentId, ticketId: d.ticketId, reason: "deploy rejected", note: `The owner rejected deploying ${d.ref} to ${t.name}. Don't deploy it; raise a decision if you need another way forward.` });
      return row!;
    },

    /** Called by the scheduler before it starts the run, so the run's first secrets fetch includes the target. */
    async bindRun(deployId: string, runId: string) {
      await db.update(deploys).set({ status: "running", runId }).where(and(eq(deploys.id, deployId), eq(deploys.status, "approved")));
    },

    async unbindRun(deployId: string) {
      await db.update(deploys).set({ status: "approved", runId: null }).where(and(eq(deploys.id, deployId), eq(deploys.status, "running")));
    },

    /** The run carrying out the deploy reports how it went; its secrets stop with it. */
    async report(actor: { companyId: string; runId?: string | null }, input: { deployId: string; outcome: "succeeded" | "failed"; notes?: string }) {
      const d = await load(input.deployId);
      if (d.companyId !== actor.companyId) throw new DeployError(404, "No such deploy.");
      if (d.status !== "running") throw new DeployError(409, `That deploy is ${d.status.replace("_", " ")}, not running.`);
      if (actor.runId && d.runId !== actor.runId) throw new DeployError(403, "Only the run carrying out the deploy can report it.");
      const [row] = await db
        .update(deploys)
        .set({ status: input.outcome, outcome: input.notes ?? null, finishedAt: now() })
        .where(eq(deploys.id, d.id))
        .returning();
      return row!;
    },

    /** A run that ends without reporting leaves the deploy failed, which also ends its access to secrets. */
    async onRunEnded(runId: string) {
      await db
        .update(deploys)
        .set({ status: "failed", outcome: "The run ended without reporting a result.", finishedAt: now() })
        .where(and(eq(deploys.runId, runId), eq(deploys.status, "running")));
    },

    async list(companyId?: string) {
      return db
        .select({ deploy: deploys, target: deployTargets.name, isProduction: deployTargets.isProduction })
        .from(deploys)
        .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
        .where(companyId ? eq(deploys.companyId, companyId) : undefined)
        .orderBy(asc(deploys.createdAt));
    },
  };
}
