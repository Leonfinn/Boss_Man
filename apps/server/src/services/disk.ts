// Workspace clean-up and disk caps (R54). Each runner reports its disk use after its hourly
// clean-up pass. Worktrees of tickets that have been done for a while, or that no longer
// exist, are released (uncommitted work is kept as a patch and the branch stays), and the
// owner hears once a day while a company is over its disk cap.
import { eq, inArray } from "drizzle-orm";
import type { DiskReport, RunnerCommand } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, runners, tickets } from "../db/schema.js";

export type DiskLimits = { defaultCapBytes: number; retentionDays: number; warnPercent: number; warnBytes: number };
export const DEFAULT_DISK_LIMITS: DiskLimits = { defaultCapBytes: 20 * 1024 ** 3, retentionDays: 7, warnPercent: 0.1, warnBytes: 5 * 1024 ** 3 };

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function diskService(db: Db, deps: { send: (runnerId: string, command: RunnerCommand) => boolean; limits?: Partial<DiskLimits>; now?: () => Date }) {
  const limits = { ...DEFAULT_DISK_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());

  return {
    limits,

    async onReport(runner: { id: string; companyId: string }, report: DiskReport, at: Date) {
      await db.update(runners).set({ diskUsedBytes: report.usedBytes, diskCheckedAt: at }).where(eq(runners.id, runner.id));

      // Release worktrees whose ticket is long done, or gone.
      const ids = report.tickets.map((t) => t.ticketId);
      const known = ids.length
        ? await db.select({ id: tickets.id, companyId: tickets.companyId, state: tickets.systemState, lastActivityAt: tickets.lastActivityAt }).from(tickets).where(inArray(tickets.id, ids))
        : [];
      const byId = new Map(known.map((t) => [t.id, t]));
      const cutoff = now().getTime() - limits.retentionDays * 86_400_000;
      const released: string[] = [];
      for (const w of report.tickets) {
        const t = byId.get(w.ticketId);
        // A ticket of another company is never touched: the report doesn't get to choose.
        if (t && t.companyId !== runner.companyId) continue;
        if (t && !(t.state === "done" && t.lastActivityAt.getTime() < cutoff)) continue;
        if (deps.send(runner.id, { type: "workspace.release", projectId: w.projectId, ticketId: w.ticketId })) released.push(w.ticketId);
      }

      const [company] = await db.select({ name: companies.name, cap: companies.diskCapBytes }).from(companies).where(eq(companies.id, runner.companyId));
      const cap = company?.cap ?? limits.defaultCapBytes;
      let alerted = false;
      if (company && report.usedBytes > cap) {
        const biggest = [...report.tickets]
          .filter((t) => !released.includes(t.ticketId))
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 3);
        const titles = biggest.length ? await db.select({ id: tickets.id, title: tickets.title }).from(tickets).where(inArray(tickets.id, biggest.map((b) => b.ticketId))) : [];
        const named = biggest.map((b) => `"${titles.find((t) => t.id === b.ticketId)?.title ?? b.ticketId}" (${gb(b.bytes)})`);
        const rows = await db
          .insert(decisions)
          .values({
            companyId: runner.companyId,
            kind: "question",
            question:
              `${company.name}'s workspaces use ${gb(report.usedBytes)}, over its ${gb(cap)} disk cap.` +
              (named.length ? ` The biggest ticket workspaces are ${named.join(", ")}.` : "") +
              ` This is a warning: nothing is stopped by it. To raise it, open Settings → Server and runner → Runner → Workspace disk and set "Most disk to use (GB)" higher than its current ${gb(cap)}; it takes effect at the next hourly clean-up.` +
              ` Otherwise, finish or cancel tickets; the working files of tickets done more than ${limits.retentionDays} days ago are removed automatically.`,
            options: ["Got it"],
            recommendedOption: "Got it",
            // Once a day at most.
            dedupeKey: `disk:${runner.companyId}:${at.toISOString().slice(0, 10)}`,
            context: { type: "question" },
          })
          .onConflictDoNothing()
          .returning({ id: decisions.id });
        alerted = rows.length > 0;
      }
      // BOS-2182: the host's disk, not the cap. Warn below 10% free or 5 GB (the runner's own levels, via env), once a day.
      let lowSpaceAlerted = false;
      if (company && report.freeBytes !== undefined && report.totalBytes !== undefined && report.totalBytes > 0) {
        const warnAt = Math.max(report.totalBytes * limits.warnPercent, limits.warnBytes);
        if (report.freeBytes < warnAt) {
          const users: { label: string; bytes: number }[] = [
            ...report.tickets.map((t) => ({ label: `ticket workspace ${t.ticketId.slice(0, 8)}`, bytes: t.bytes })),
            ...report.repos.map((r) => ({ label: `shared repo ${r.projectId.slice(0, 8)}`, bytes: r.bytes })),
            ...(report.scratch ?? []).map((s) => ({ label: `kept scratch of ticket ${s.ticketId.slice(0, 8)}`, bytes: s.bytes })),
          ]
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 3);
          const mb = Math.floor(report.freeBytes / 1024 ** 2);
          const rows = await db
            .insert(decisions)
            .values({
              companyId: runner.companyId,
              kind: "question",
              question:
                `The runner's disk is running low: ${mb < 1024 ? `${mb} MB` : gb(report.freeBytes)} free of ${gb(report.totalBytes)}.` +
                (users.length ? ` Of Boss Man's own files, the biggest are ${users.map((u) => `${u.label} (${gb(u.bytes)})`).join(", ")}.` : "") +
                (report.holding ? ` New agent runs and checks are being held now (running ones carry on); they start again by itself once space is free.` : ` If it falls under the floor (1 GB by default), the runner holds new agent runs and checks (running ones carry on) and starts them again by itself once space is free.`) +
                ` Free space on the host's disk (old Docker images, logs or other files) and it recovers with nothing to press.`,
              options: ["Got it"],
              recommendedOption: "Got it",
              dedupeKey: `diskfree:${runner.companyId}:${at.toISOString().slice(0, 10)}`,
              context: { type: "question" },
            })
            .onConflictDoNothing()
            .returning({ id: decisions.id });
          lowSpaceAlerted = rows.length > 0;
        }
      }
      return { released, alerted, capBytes: cap, lowSpaceAlerted };
    },
  };
}
