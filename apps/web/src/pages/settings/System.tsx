import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Company } from "../../api";
import { usePoll } from "../../hooks";
import { setHold, useHold } from "../../hold";
import { when } from "../Runs";
import { Section, useAction } from "./shared";
import { LiveState, UpdateHistory, type MaintenanceView, type Report, type WrapUpRun, type WrapUpStatus } from "./updates";

/** The company's workspace disk cap (R54, BOS-274): over it, the owner hears once a day; nothing is stopped. */
export function WorkspaceDisk({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [gb, setGb] = useState(company.diskCapBytes != null ? String(+(company.diskCapBytes / 1024 ** 3).toFixed(1)) : "");
  const act = useAction();
  const n = Number(gb);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100_000;
  return (
    <Section id="workspace-disk-h" title="Workspace disk">
      <p className="muted" style={{ fontSize: 14 }}>
        Each ticket keeps its working files on the runner's disk until it has been done for a while. When the company's workspaces grow past this cap, Boss Man tells you once a day with the biggest ones named. It is a warning only: it never stops runs or refuses new workspaces. Worktrees of tickets done more than 7 days ago are released automatically.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="disk-cap">Disk cap (GB)</label>
        <input id="disk-cap" type="number" min={1} max={100000} step={1} placeholder="20" value={gb} onChange={(e) => setGb(e.target.value)} style={{ width: 100 }} />
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { diskCapGb: n } });
              onChanged();
              return "Saved. It applies at the next hourly clean-up.";
            })
          }
        >
          Save
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {company.diskCapBytes != null ? `Currently ${(company.diskCapBytes / 1024 ** 3).toFixed(1)} GB.` : "Currently the server default, 20 GB."}
      </p>
      {act.view}
    </Section>
  );
}

type SelfDeployView = {
  enabled: boolean;
  pending: boolean;
  status: { result: string; message: string; target: string; to_commit: string; ended: string; started: string } | null;
  available: { tip: string; deployed: string; checkedAt: string; commits?: { sha: string; subject?: string }[]; runnerChanged?: boolean; bluegreen?: boolean } | null;
  /** When the host deployer last showed it is alive, and whether that is overdue (BOS-753). Absent from an older server. */
  deployer?: { reportedAt: string | null; late: boolean };
  lateAfterMinutes?: number;
  /** The runner trial, with the real time it ends (BOS-953). Null/absent when no trial is running. */
  trial?: { endsAt: string; seconds: number } | null;
  /** A rate-limit refusal counted from its own time (BOS-953): the panel counts down to `until`, then says you can deploy now. */
  deployWait?: { until: string } | null;
};

/** "15:33", in the reader's own clock, from an ISO instant (BOS-953). */
function atTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
/** "in about 6 minutes", or "in less than a minute", from now to an instant (BOS-953). */
function inAbout(iso: string, now: number): string {
  const mins = Math.ceil((Date.parse(iso) - now) / 60_000);
  return mins <= 0 ? "now" : mins === 1 ? "in about 1 minute" : `in about ${mins} minutes`;
}
/** A clock that ticks every 15 s, so a countdown on the page moves without waiting for the next poll (BOS-953). */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The line under "Last deploy" when the host has no offer to show (BOS-753): "not reported" only when it really is overdue. */
function deployerLine(v: SelfDeployView): string {
  const d = v.deployer;
  if (!d) return "The host deployer has not reported yet.";
  if (!d.reportedAt) return "The host deployer has not reported yet. Check that its cron job is running.";
  if (d.late) return `The host deployer last reported ${when(d.reportedAt)}, more than ${v.lateAfterMinutes ?? 10} minutes ago; it should report every minute. Check that its cron job is running.`;
  return `The host deployer last reported ${when(d.reportedAt)}. It is reading main again and shows what is waiting within a few minutes.`;
}

/** Boss Man's merges record the ticket as `Merge "<title>" (<ticket id>)` (BOS-213). */
const MERGE_SUBJECT = /^Merge "(.*)" \(([^)]*)\)$/;
/** A ticket id, as the brackets of a merge subject hold it (BOS-883); anything else in them is not one. */
const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The merges waiting to go live, newest first (BOS-875), each with the ticket id from its subject's brackets, or null
 * when they hold no ticket id (BOS-883). Non-merge commits and untitled ones are left out.
 */
function waitingMerges(commits: { subject?: string }[] | undefined): { title: string; ticketId: string | null }[] {
  return (commits ?? []).flatMap((c) => {
    const m = c.subject?.match(MERGE_SUBJECT);
    if (!m?.[1]) return [];
    const id = m[2] ?? "";
    return [{ title: m[1], ticketId: TICKET_ID.test(id) ? id : null }];
  });
}

/** What is waiting to go live, by ticket title, each opening its ticket (BOS-875, BOS-883). Nothing when no merges are waiting. */
function WaitingChanges({ commits }: { commits: { subject?: string }[] | undefined }) {
  const changes = waitingMerges(commits);
  if (!changes.length) return null;
  const shown = changes.slice(0, 10);
  return (
    <div style={{ fontSize: 14 }}>
      <p style={{ margin: 0 }}>{changes.length === 1 ? "1 change waiting:" : `${changes.length} changes waiting:`}</p>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {shown.map((c, i) => (
          <li key={`${i}:${c.title}`}>
            {c.ticketId ? <a href={`#/tickets/${c.ticketId}`}>{c.title}</a> : c.title}
          </li>
        ))}
      </ul>
      {changes.length > shown.length && <p style={{ margin: "4px 0 0" }}>and {changes.length - shown.length} more</p>}
    </div>
  );
}

/**
 * The runner trial and any rate-limit wait (BOS-953), both counted from their own time so they never show the
 * host's frozen text and never disagree with the BLUE/GREEN rows (the trial comes from the same colour probe).
 * Pure, so a layout test can render it on its own.
 */
export function TrialLines({ trial, wait, now }: { trial?: { endsAt: string } | null; wait?: { until: string } | null; now: number }) {
  const trialOver = trial ? Date.parse(trial.endsAt) <= now : false;
  const waitOver = wait ? Date.parse(wait.until) <= now : false;
  return (
    <>
      {trial && !trialOver && (
        <p className="error" role="status" data-testid="runner-trial" style={{ fontSize: 14 }}>
          The server update is still in its trial, so the runners can't be updated yet. Runners can be updated from {atTime(trial.endsAt)}, {inAbout(trial.endsAt, now)}.
          Boss Man offers the runner update by itself then, so you don't need to press again.
        </p>
      )}
      {wait && (
        <p className={waitOver ? "muted" : "error"} role="status" data-testid="deploy-wait" style={{ fontSize: 14 }}>
          {waitOver ? "You can deploy now." : `A server deploy was refused to keep one every 10 minutes. You can deploy again from ${atTime(wait.until)}, ${inAbout(wait.until, now)}.`}
        </p>
      )}
    </>
  );
}

/** What the host deployer last did, and a button to ask for the newest main (docs/09-self-deploy.md). Hidden when self-deploy is off. */
export function SelfDeploy({ go }: { go: (to: string) => void }) {
  const view = usePoll((signal) => api<SelfDeployView>("/api/self-deploy", { signal }), 10_000, "self-deploy");
  const maint = usePoll((signal) => api<MaintenanceView>("/api/maintenance", { signal }), 5_000, "maintenance-updates");
  const act = useAction();
  // A clock so the trial and rate-limit lines count down between polls (BOS-953).
  const now = useNow();
  const v = view.data;
  if (!v?.enabled) return null;
  const s = v.status;
  // Right after a deploy the host's offer still names the old commit for a few minutes.
  const waiting = v.available && v.available.tip && v.available.tip !== v.available.deployed && !(s?.result === "deployed" && s.to_commit === v.available.tip);
  return (
    <Section id="deploy-h" title="Updates">
      {/* "Ask agents to wrap up", inside the update box (BOS-988): the main action while an update or rebuild waits on runs. */}
      <WrapUpAction m={maint.data} reload={maint.reload} />
      <p style={{ fontSize: 14 }}>
        {s ? `Last deploy: ${s.result.replace(/_/g, " ")}, ${s.target} ${s.to_commit.slice(0, 8)}, ${when(s.ended || s.started)}. ${s.message}` : "No deploy yet."}
      </p>
      <p className="muted" style={{ fontSize: 14 }}>
        {v.pending ? "A request is waiting for the host (it checks every minute)." : v.available ? (waiting ? `Main is ahead: ${v.available.deployed.slice(0, 8)} to ${v.available.tip.slice(0, 8)}.` : `Up to date as of ${when(v.available.checkedAt)}.`) : deployerLine(v)}
      </p>
      <TrialLines trial={v.trial ?? null} wait={v.deployWait ?? null} now={now} />
      {waiting && <WaitingChanges commits={v.available?.commits} />}
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || v.pending || s?.result === "running"}
          title="Updates the server only. If the update changed the runners, press Build and update runners afterwards."
          onClick={() =>
            act.run(async () => {
              try {
                await api("/api/self-deploy/deploy-latest", { method: "POST", body: {} });
              } catch (err) {
                // Nothing new is not a failure: the server says so, and has asked the host to look at main again.
                if (err instanceof ApiError && err.status === 409) return err.message;
                throw err;
              }
              go("decisions");
            })
          }
        >
          Deploy latest
        </button>{" "}
        <button
          type="button"
          className="btn"
          disabled={act.busy || v.pending || s?.result === "running"}
          title="Builds a new runner image from the deployed code (for example new tools in apps/runner/Dockerfile), checks it, then swaps each runner when its company is idle."
          onClick={() =>
            act.run(async () => {
              await api("/api/self-deploy/update-runners", { method: "POST", body: {} });
              go("decisions");
            })
          }
        >
          Build and update runners
        </button>{" "}
        <button
          type="button"
          className="btn"
          disabled={act.busy || v.pending || s?.result === "running" || !v.available?.deployed}
          title="Starts the server again at the version it runs now (BOS-647). Use it when a server-health card says memory is high or freezes are piling up and no update is waiting."
          onClick={() => {
            const bg = v.available?.bluegreen === true;
            const ask = bg
              ? "Restart the server? It starts a fresh copy of the current version and switches over; pages keep working. The one-step rollback to the release before this one is lost. Continue?"
              : "Restart the server? It stops for about a minute while it restarts; runs pick up again after. Continue?";
            if (!window.confirm(ask)) return;
            act.run(async () => {
              await api("/api/self-deploy/restart", { method: "POST", body: {} });
              return "Restart requested. The host picks it up within a minute; the line above shows how it went.";
            });
          }}
        >
          Restart the server
        </button>
      </div>
      {v.available?.runnerChanged && (
        <p style={{ fontSize: 14 }}>This update changes the runners: after Deploy latest, press Build and update runners.</p>
      )}
      <p className="muted" style={{ fontSize: 14 }}>
        Deploy latest updates the server only. If an update changed the runners, press Build and update runners afterwards.
      </p>
      {act.view}
    </Section>
  );
}

/**
 * How many agents may run at once, in total and per company, plus the separate background slots for
 * Infinite-mode agents (BOS-279); the per-agent limit is fixed at one.
 */
export function RunLimits() {
  const view = usePoll((signal) => api<{ instance: number; company: number; background: number; defaults: { instance: number; company: number; background: number } }>("/api/run-limits", { signal }), 30_000, "run-limits");
  const act = useAction();
  const [edit, setEdit] = useState<{ instance: string; company: string; background: string } | null>(null);
  const d = view.data;
  if (!d) return null;
  const v = edit ?? { instance: String(d.instance), company: String(d.company), background: String(d.background) };
  const [i, c, g] = [Number(v.instance), Number(v.company), Number(v.background)];
  const valid = Number.isInteger(i) && i >= 1 && i <= 32 && Number.isInteger(c) && c >= 1 && c <= 16 && c <= i && Number.isInteger(g) && g >= 0 && g <= 16;
  return (
    <Section id="run-limits-h" title="Agents at once">
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="limit-instance">Across all companies (1 to 32)</label>
        <input id="limit-instance" type="number" min={1} max={32} value={v.instance} onChange={(e) => setEdit({ ...v, instance: e.target.value })} style={{ width: 80 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          Agents running at once, across all companies (default {d.defaults.instance}). Each running agent uses memory and CPU on this machine and spends from its funding source. Higher: more work happens in parallel, but more spend at once and more load on the server. Lower: work queues for longer (you'll see "at a concurrency limit: all companies"). When a slot frees, a company with nothing running gets it first, so one busy company can't keep the others waiting.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="limit-company">In one company (1 to 16, no more than the number above)</label>
        <input id="limit-company" type="number" min={1} max={16} value={v.company} onChange={(e) => setEdit({ ...v, company: e.target.value })} style={{ width: 80 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          Agents running at once in one company (default {d.defaults.company}). Stops one busy company from using every slot. Higher: that company's tickets and reviews start sooner; spend can rise faster. Lower: tickets wait in the queue (you'll see "at a concurrency limit: this company").
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="limit-background">Background (infinite mode) runs at once (0 to 16)</label>
        <input id="limit-background" type="number" min={0} max={16} value={v.background} onChange={(e) => setEdit({ ...v, background: e.target.value })} style={{ width: 80 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          Agents on Synthetic's Infinite mode ("free, slow" models) get their own slots (default {d.defaults.background}), separate from the two numbers above. They don't spend your Synthetic plan's credits, so they never wait for the quota; keeping them on their own small number means a slow free run can't take a normal slot or hold up paid work. 0 stops background runs starting.
        </p>
      </div>
      <p className="muted" style={{ fontSize: 14 }}>
        Each agent always does one piece of work at a time (it has one working folder), plus one chat with you. Your chats are never held by these limits.
      </p>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api("/api/run-limits", { method: "PUT", body: { instance: i, company: c, background: g } });
              setEdit(null);
              view.reload();
              return "Saved.";
            })
          }
        >
          Save
        </button>
      </div>
      {act.view}
    </Section>
  );
}

/**
 * Tickets in progress per agent (BOS-1029): an agent finishes before it starts more. Only in-progress tickets
 * count (review, blocked and done don't). Empty box = No limit.
 */
export function WipLimits() {
  const view = usePoll((signal) => api<{ agent: number | null; company: number | null; defaultAgent: number }>("/api/wip-limits", { signal }), 30_000, "wip-limits");
  const act = useAction();
  const [edit, setEdit] = useState<{ agent: string; company: string } | null>(null);
  const d = view.data;
  if (!d) return null;
  const v = edit ?? { agent: d.agent == null ? "" : String(d.agent), company: d.company == null ? "" : String(d.company) };
  const parse = (s: string) => (s.trim() === "" ? null : Number(s));
  const [a, c] = [parse(v.agent), parse(v.company)];
  const valid = (a === null || (Number.isInteger(a) && a >= 1 && a <= 50)) && (c === null || (Number.isInteger(c) && c >= 1 && c <= 1000));
  return (
    <Section id="wip-limits-h" title="Tickets in progress">
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="wip-agent">Tickets in progress per agent (leave empty for no limit)</label>
        <input id="wip-agent" type="number" min={1} max={50} placeholder="No limit" value={v.agent} onChange={(e) => setEdit({ ...v, agent: e.target.value })} style={{ width: 100 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          How many tickets one agent may have in progress at once (default {d.defaultAgent}: one being worked, one waiting on its check). At the limit, a new ticket for that agent waits in Ready and starts by itself when one of their tickets goes to review, done or blocked. Only in-progress tickets count. Work already started is never held (changes requested, a failed merge check), and an urgent ticket may start one over. Agents already over the limit are not interrupted; they just start nothing new until they are back under.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="wip-company">Tickets in progress, whole company (leave empty for no limit)</label>
        <input id="wip-company" type="number" min={1} max={1000} placeholder="No limit" value={v.company} onChange={(e) => setEdit({ ...v, company: e.target.value })} style={{ width: 100 }} />
        <p className="muted" style={{ fontSize: 14 }}>Off by default. A ceiling on all in-progress tickets together; new starts wait in Ready the same way.</p>
      </div>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api("/api/wip-limits", { method: "PUT", body: { agent: a, company: c } });
              setEdit(null);
              view.reload();
              return "Saved.";
            })
          }
        >
          Save
        </button>
      </div>
      {act.view}
    </Section>
  );
}

type CheckQueueView = { mode: "legacy" | "server"; slots: number; maxSlots: number; defaultSlots: number; runnersTooOld: string[]; cancelled?: number; applying?: boolean; runner?: { slots: number; memoryBytes: number; reason: string | null; pending: number; applying: boolean; runnerCount?: number } | null };

/**
 * Settings → Server and runner → Stop all work (BOS-836): the server-wide hold the scheduler already honours. It only
 * stops new runs; ending the ones going is on the Runs page. Resume is on the banner every page shows while it's on.
 */
export function StopAllWork() {
  const hold = useHold();
  const act = useAction();
  const paused = hold.data?.paused;
  return (
    <Section id="stop-all-h" title="Stop all work">
      <p className="muted" style={{ fontSize: 14 }}>
        Stops new work in every company at once: while it is on, Boss Man starts no new agent runs. Wake-ups and messages wait in line and start when you resume. Runs already going are not cut off; they finish by themselves. To end them now, use the Runs page. Press Resume on the banner at the top of any page to start work again.
      </p>
      {paused === true ? (
        <p style={{ fontSize: 14 }} data-testid="stop-all-on">
          <span className="tag red">On</span> All work is stopped.
        </p>
      ) : (
        <div>
          <button
            type="button"
            className="btn"
            disabled={act.busy || paused !== false}
            onClick={() =>
              void act.run(async () => {
                if (!window.confirm("Stop all work? Nothing new starts in any company until you press Resume. Runs already going finish by themselves.")) return;
                await setHold(true);
              })
            }
          >
            Stop all work
          </button>
        </div>
      )}
      {act.view}
    </Section>
  );
}

/** Settings → Server and runner → Checks (BOS-798): the owner's switch for the server-owned check queue (DR-003). */
export function CheckQueueSetting() {
  const view = usePoll((signal) => api<CheckQueueView>("/api/settings/check-queue", { signal }), 30_000, "check-queue");
  const act = useAction();
  const [edit, setEdit] = useState<{ mode: "legacy" | "server"; slots: string } | null>(null);
  const d = view.data;
  if (!d) return null;
  const v = edit ?? { mode: d.mode, slots: String(d.slots) };
  const n = Number(v.slots);
  const valid = Number.isInteger(n) && n >= 1 && n <= d.maxSlots;
  const changed = v.mode !== d.mode || n !== d.slots;
  return (
    <Section id="check-queue-h" title="Checks">
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <legend>Who runs agents' checks</legend>
        <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <input type="radio" name="check-queue-mode" value="legacy" checked={v.mode === "legacy"} onChange={() => setEdit({ ...v, mode: "legacy" })} />
          <span>
            <strong>Agents run their own (legacy).</strong> <span className="muted">Each agent runs the quick check inside its own session. A check dies if the session ends or the runner restarts, and agents wait in line for a free slot.</span>
          </span>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <input type="radio" name="check-queue-mode" value="server" checked={v.mode === "server"} onChange={() => setEdit({ ...v, mode: "server" })} />
          <span>
            <strong>Boss Man runs them (server queue).</strong> <span className="muted">Agents ask for a check and Boss Man runs it on the runner. The check keeps going after the agent's session ends or the runner restarts, a pass on the same code is reused, and the agent is woken with the result. The merge check before each merge uses this queue too.</span>
          </span>
        </label>
      </fieldset>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="check-slots">Checks at once (1 to {d.maxSlots})</label>
        <input id="check-slots" type="number" min={1} max={d.maxSlots} value={v.slots} onChange={(e) => setEdit({ ...v, slots: e.target.value })} style={{ width: 80 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          How many queued checks one company's runner runs at the same time (default {d.defaultSlots}). Only used by the server queue. Each check uses a lot of memory and CPU: raise it only if the runner's machine has room, or checks start failing with out-of-memory errors. The runners' memory follows this number; there is nothing to edit on the host.
        </p>
        {d.runner && (
          <p style={{ fontSize: 14 }} data-testid="check-runner-limit">
            Limit in force on the runners: <strong>{d.runner.slots} at once</strong> ({Math.round((d.runner.memoryBytes / 1024 ** 3) * 10) / 10} GB memory ceiling per runner). The ceiling is a cap, not memory set aside: a runner only uses what its agents and checks need, and the machine's own free memory is never reserved.
            {d.runner.reason && <> <span className="tag red">Lower than the setting</span> {d.runner.reason}</>}
            {d.runner.applying || d.runner.pending > 0 ? <> <span className="tag">Applying</span> {d.runner.pending} runner{d.runner.pending === 1 ? "" : "s"} still on the old limit. Each is restarted when its company has no run going, and agents are woken afterwards.</> : null}
          </p>
        )}
        {d.runner && (d.runner.runnerCount ?? 0) > 1 && (
          <p className="muted" style={{ fontSize: 14 }} data-testid="check-runner-shared-host">
            This machine runs {d.runner.runnerCount} runners (one per company). Each is sized from the machine's whole memory, not a share of it, so together they can be promised more than the machine has. If several companies run checks at once, keep the number low.
          </p>
        )}
      </div>
      {d.runnersTooOld.length > 0 && (
        <p style={{ fontSize: 14 }} data-testid="check-queue-old-runner">
          <span className="tag red">Update needed</span> The runner for {d.runnersTooOld.join(", ")} is too old to run queued checks; their checks would wait until you update the runners (Updates → Build and update runners).
        </p>
      )}
      <p className="muted" style={{ fontSize: 14 }}>
        Switching back to legacy cancels checks that are still waiting (their agents are told to run the check themselves); checks already running finish.
      </p>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid || !changed}
          onClick={() =>
            void act.run(async () => {
              const r = await api<CheckQueueView>("/api/settings/check-queue", { method: "PUT", body: { mode: v.mode, slots: n } });
              setEdit(null);
              view.reload();
              const applied = r.applying ? " The runners are restarted with the new limit as each company goes idle." : "";
              return r.cancelled ? `Saved. ${r.cancelled} waiting check${r.cancelled === 1 ? " was" : "s were"} cancelled.${applied}` : `Saved.${applied}`;
            })
          }
        >
          Save
        </button>
      </div>
      {act.view}
    </Section>
  );
}

/** Drain-then-swap for runner updates: start it by hand (after scripts/update-runner.sh built the image) or cancel one that is running. */
export function RunnerUpdate() {
  const view = usePoll((signal) => api<MaintenanceView>("/api/maintenance", { signal }), 5_000, "maintenance-settings");
  const report = usePoll((signal) => api<Report>("/api/runner-report", { signal }), 5_000, "runner-report");
  const act = useAction();
  const m = view.data;
  if (!m) return null;
  const r = report.data;
  return (
    <Section id="drain-h" title="Runner update">
      {r && (
        <div role="status" data-testid="runner-live">
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Now</h3>
          {r.live.length ? (
            <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {r.live.map((l) => (
                <LiveState key={l.slug} r={l} />
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: 14 }}>No company has a runner yet.</p>
          )}
        </div>
      )}
      <p className="muted" style={{ fontSize: 14 }}>
        {m.on
          ? m.kind === "wrapup"
            ? "Agents were asked to wrap up. Press Cancel wrap-up once you are done to let new work start again."
            : `Update pending: ${m.runs > 0 ? `waiting for ${m.runs} run${m.runs === 1 ? "" : "s"} in ${m.companies} ${m.companies === 1 ? "company" : "companies"}; you are asked at ${when(m.deadline)} if some are still going` : "swapping the runners now"}. Nothing new starts until it is done. To end the runs sooner, use "Ask agents to wrap up" at the top of Settings → Server and runner.`
          : "Puts every company's runner on the newest image: nothing new starts, runs in progress finish, and each runner is swapped as its company goes idle. Build the image first with Build and update runners under Updates, which also starts this; use this button only after scripts/update-runner.sh."}
      </p>
      <div>
        {r?.update ? (
          <UpdateHistory r={r.update} />
        ) : (
          <p className="muted" style={{ fontSize: 14 }}>
            No runner update has finished here yet.
          </p>
        )}
      </div>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy}
          onClick={() =>
            act.run(async () => {
              await api(m.on ? "/api/maintenance/cancel" : "/api/maintenance/start", { method: "POST", body: {} });
              view.reload();
            })
          }
        >
          {m.on ? "Cancel the update" : "Update runners (finish runs first)"}
        </button>
      </div>
      {act.view}
    </Section>
  );
}

/**
 * "Ask agents to wrap up" (BOS-929, BOS-988), inside the top Runner update box. It tells every running agent to
 * finish its step, save its work and stop cleanly, so an update or a runner rebuild can go ahead. Unlike "Stop all
 * work" it also messages the runs going now, so they end by themselves. While an update waits it is the main action
 * and the still-running list shows here; the update keeps waiting and goes ahead when the runs end. Nothing is ever
 * stopped for you: the not-responding flag only offers a Stop for that one run.
 */
export function WrapUpAction({ m, reload, children }: { m: MaintenanceView | null; reload: () => void; children?: ReactNode }) {
  const act = useAction();
  if (!m) return null;
  const s = m.on && (m.kind === "wrapup" || (m as WrapUpStatus).wrapAsked) ? (m as WrapUpStatus) : null;
  const waiting = m.on && !s;
  const start = () =>
    act.run(async () => {
      await api("/api/maintenance/wrapup", { method: "POST", body: {} });
      reload();
      return "Every running agent was asked to wrap up.";
    });
  const cancel = () =>
    act.run(async () => {
      await api("/api/maintenance/cancel-wrap", { method: "POST", body: {} });
      reload();
      return "Wrap-up cancelled: runs already told still end by themselves; the update keeps waiting for them.";
    });
  const stopOne = (run: WrapUpRun) =>
    act.run(async () => {
      if (!window.confirm(`Stop ${run.agent ?? "this agent"}'s run? It stops mid-step, so anything it has not committed yet can be lost.`)) return;
      await api(`/api/runs/${run.runId}/cancel`, { method: "POST", body: {} });
      reload();
      return "Stopping that run.";
    });
  const n = s ? s.runsList.length : m.on ? m.runs : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="wrapup-box">
      {s ? (
        <>
          <p style={{ fontSize: 14 }} data-testid="wrapup-on">
            <span className="tag">Wrap-up on</span>{" "}
            {n === 0
              ? "Every agent has finished; the update can go ahead."
              : `${n} agent${n === 1 ? " is" : "s are"} still running and ${n === 1 ? "has" : "have"} been asked to finish the step they are on. Nothing new starts; the update starts when they have finished.`}
          </p>
          {s.runsList.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }} data-testid="wrapup-runs">
              {s.runsList.map((run) => {
                const onCard = !!run.waitingOn;
                const late = !onCard && run.sinceWrapUpMinutes >= s.notRespondingAfter;
                return (
                  <li key={run.runId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
                    <strong>{run.agent ?? "An agent"}</strong>
                    <span className="muted">
                      {run.ticket ? `${run.ticket}${run.ticketTitle ? `: ${run.ticketTitle}` : ""}` : "no ticket"} · asked to wrap up {run.sinceWrapUpMinutes} min ago
                    </span>
                    {onCard ? (
                      <span className="tag amber" title={run.waitingOn!.question}>
                        Waiting for an answer
                      </span>
                    ) : late ? (
                      <span className="tag red" title={`Still going ${s.notRespondingAfter} minutes after being asked to wrap up.`}>
                        Not responding
                      </span>
                    ) : (
                      <span className="tag grey">Working</span>
                    )}
                    {(late || onCard) && (
                      <button type="button" className="btn small" disabled={act.busy} onClick={() => void stopOne(run)}>
                        Stop this run
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {s.runsList.length > 0 && (
            <p className="muted" style={{ fontSize: 13 }} data-testid="wrapup-note">
              Agents have been asked to save their work and finish; most finish within a few minutes. One still going {s.notRespondingAfter} minutes after being asked shows Not responding next to its name. Boss Man won't stop an agent for you: if you want one to end now, press Stop this run next to it, and the others carry on. Stopping ends that agent where it got to, so anything it hasn't saved yet is lost, and it isn't woken again when this is over: its ticket waits where it stopped.{" "}
              {s.kind === "wrapup"
                ? "If you do nothing, nothing new starts until you press Cancel wrap-up."
                : `If you do nothing, the update keeps waiting; at ${when(s.deadline)} you'll be asked whether to stop the agents still running.`}
            </p>
          )}
          <div>
            <button type="button" className="btn" disabled={act.busy} onClick={() => void cancel()}>
              Cancel wrap-up
            </button>
          </div>
        </>
      ) : waiting ? (
        <>
          <p style={{ fontSize: 14 }} data-testid="wrapup-waiting">
            <span className="tag amber">Update waiting</span>{" "}
            {n === 0 ? "No agents are running now; the update can go ahead." : `${n} agent${n === 1 ? " is" : "s are"} still running. The update starts when they have finished: press Ask agents to wrap up to have them finish their step and stop by themselves.`}
          </p>
          <div>{children ?? (
            <button type="button" className="btn" disabled={act.busy} onClick={() => void start()}>
              Ask agents to wrap up
            </button>
          )}</div>
        </>
      ) : (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void start()}>
            Ask agents to wrap up
          </button>
          <span className="muted" style={{ fontSize: 13 }}>Stop the running agents cleanly before an update, if any are going.</span>
        </div>
      )}
      {act.view}
    </div>
  );
}
