import { useEffect, useState } from "react";
import { api, ApiError, type Company } from "../../api";
import { usePoll } from "../../hooks";
import { setHold, useHold } from "../../hold";
import { MoreAbout } from "../../components/MoreAbout";
import { when } from "../Runs";
import { DraftTextarea } from "../../components/DraftTextarea";
import { Section, useAction } from "./shared";
import { CheckWorkers, type CheckWorkerView } from "./CheckWorkers";
import { LiveState, atTime, historyTag, historyWhat, inAbout, updateStatus, type DeployWaitView, type HistoryRow, type MaintenanceView, type Report, type SelfDeployView, type UpdateStatus, type WrapUpRun, type WrapUpStatus } from "./updates";

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

/** A clock that ticks every 15 s, so a countdown on the page moves without waiting for the next poll (BOS-953). */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
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
  const shown = changes.slice(0, 5);
  return (
    <div style={{ fontSize: 14 }} data-testid="waiting-changes">
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
export function TrialLines({ trial, wait, now, queue, cancelled, held }: { trial?: { endsAt: string } | null; wait?: { until: string } | null; now: number; queue?: { startsAt: string | null; why: string } | null; cancelled?: { why: string } | null; held?: { commit: string } | null }) {
  const trialOver = trial ? Date.parse(trial.endsAt) <= now : false;
  const waitOver = wait ? Date.parse(wait.until) <= now : false;
  return (
    <>
      {trial && !trialOver && (
        <p className="muted" role="status" data-testid="runner-trial" style={{ fontSize: 14 }}>
          {queue
            ? `Runners will update at ${atTime(trial.endsAt)} (${inAbout(trial.endsAt, now)}), when this server update's trial ends. You don't need to press again.`
            : `The server update is in its trial until ${atTime(trial.endsAt)} (${inAbout(trial.endsAt, now)}). Press Build and update runners to queue the runner update; it then starts by itself when the trial ends.`}
        </p>
      )}
      {queue && !(trial && !trialOver) && (
        <p className="muted" role="status" data-testid="runner-queue" style={{ fontSize: 14 }}>
          The runner update is queued. It is waiting for {queue.why.replace(/\.$/, "")}, and starts by itself as soon as that is over.
        </p>
      )}
      {held && (
        <p className="muted" role="status" data-testid="deploy-held" style={{ fontSize: 14 }}>
          The server update you approved ({held.commit.slice(0, 8)}) waits for the runner update to finish, then goes by itself.
        </p>
      )}
      {cancelled && (
        <p className="error" role="status" data-testid="queue-cancelled" style={{ fontSize: 14 }}>
          {cancelled.why}
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
  const wait = usePoll((signal) => api<DeployWaitView>("/api/self-deploy/wait", { signal }), 10_000, "self-deploy-wait");
  const maint = usePoll((signal) => api<MaintenanceView>("/api/maintenance", { signal }), 5_000, "maintenance-updates");
  const report = usePoll((signal) => api<Report>("/api/runner-report", { signal }), 5_000, "runner-report");
  const history = usePoll((signal) => api<HistoryRow[]>("/api/self-deploy/history?limit=5", { signal }), 30_000, "self-deploy-history");
  const act = useAction();
  // A clock so the trial and rate-limit lines count down between polls (BOS-953).
  const now = useNow();
  const v = view.data;
  if (v && !v.enabled) {
    // BOS-1486: with no host deployer there is no Build and update runners button, but a hand-built image still needs the drain.
    return (
      <Section id="deploy-h" title="Updates">
        <p className="muted" style={{ fontSize: 14 }}>
          Building the image from here needs the host deployer, and this install doesn't have one, so there is no Build and update runners button. Build the image on the host with scripts/update-runner.sh, then use the button below. To get in-app updates, set up the host deployer (<a href="https://github.com/Leonfinn/Boss_Man/blob/main/docs/09-self-deploy.md" target="_blank" rel="noreferrer">how to set it up</a>).
        </p>
        <button
          type="button"
          className="btn"
          disabled={act.busy || !!maint.data?.on}
          onClick={() =>
            act.run(async () => {
              await api("/api/maintenance/start", { method: "POST", body: {} });
              maint.reload();
            })
          }
        >
          Update runners (finish runs first)
        </button>
        {act.view}
      </Section>
    );
  }
  const s =v?.status ?? null;
  const st = updateStatus(v, maint.data, wait.data, now, { runnersAt: report.data?.update?.at ?? null });
  const wrap = maint.data && maint.data.on && ((maint.data as WrapUpStatus).wrapAsked || maint.data.kind === "wrapup") ? (maint.data as WrapUpStatus) : null;
  const busy = act.busy || !v;
  const idle = !!v && !v.pending && s?.result !== "running";

  const deployLatest = () =>
    act.run(async () => {
      try {
        await api("/api/self-deploy/deploy-latest", { method: "POST", body: {} });
      } catch (err) {
        // Nothing new is not a failure: the server says so, and has asked the host to look at main again.
        if (err instanceof ApiError && err.status === 409) return err.message;
        throw err;
      }
      go("decisions");
    });
  const wrapUp = () =>
    act.run(async () => {
      await api("/api/maintenance/wrapup", { method: "POST", body: {} });
      maint.reload();
      return "Every running agent was asked to wrap up.";
    });
  const stopThem = (runIds: string[]) =>
    act.run(async () => {
      if (!window.confirm(`Stop ${runIds.length} run${runIds.length === 1 ? "" : "s"} and carry on with the update? They stop mid-step, so anything they have not saved is lost. They are not woken again afterwards: their tickets wait where they stopped.`)) return;
      const r = await api<{ stopped: number; skipped: number }>("/api/maintenance/stop-stragglers", { method: "POST", body: { runIds } });
      maint.reload();
      return `Stopped ${r.stopped}${r.skipped ? `; ${r.skipped} had already ended` : ""}. The update goes ahead once no run is left.`;
    });
  const press = (id: NonNullable<UpdateStatus["primary"]>["id"]) => {
    if (id === "ask-wrapup") return wrapUp();
    if (id === "stop-stragglers") return stopThem(st.primary?.runIds ?? []);
    return deployLatest(); // Try again, Review and deploy, Check for updates now: all are deploy-latest.
  };
  const normal = (id: UpdateStatus["normal"][number]["id"]) =>
    act.run(async () => {
      if (id === "cancel-queue") {
        await api("/api/self-deploy/cancel-runner-queue", { method: "POST", body: {} });
        view.reload();
        return "The queued runner update is cancelled.";
      }
      if (id === "cancel-update") {
        await api("/api/maintenance/cancel", { method: "POST", body: {} });
        maint.reload();
        return;
      }
      try {
        await api("/api/self-deploy/wait/cancel", { method: "POST", body: {} });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) return err.message;
        throw err;
      }
    });
  const stopOne = (run: WrapUpRun) =>
    act.run(async () => {
      if (!window.confirm(`Stop ${run.agent ?? "this agent"}'s run? It stops mid-step, so anything it has not committed yet can be lost.`)) return;
      await api(`/api/runs/${run.runId}/cancel`, { method: "POST", body: {} });
      maint.reload();
      return "Stopping that run.";
    });

  return (
    <Section id="deploy-h" title="Updates">
      {/* One status box in every state, at the same height while loading (BOS-1238). */}
      <div className={`upd-status ${st.tone}`} role={st.alert ? "alert" : "status"} aria-live={st.alert ? "assertive" : "polite"} data-testid="update-status" data-state={st.tag}>
        <span className={`tag ${st.tone}`} data-testid="update-tag">{st.tag}</span>
        <div className="upd-status-body">
          <p className="upd-say" data-testid="update-say">{st.tag === "Checking…" ? "" : st.say}</p>
          {st.progress && (
            <div className="upd-bar" role="img" aria-label={`Trial ${st.progress.doneMin} of ${st.progress.totalMin} minutes done`}>
              <span style={{ width: `${Math.round((st.progress.doneMin / st.progress.totalMin) * 100)}%` }} />
            </div>
          )}
          {st.more && <p className="muted" style={{ fontSize: 14 }}>{st.more}</p>}
          {st.next && <p style={{ fontSize: 14 }} data-testid="update-next">{st.next}</p>}
          {v && <TrialLines trial={v.trial ?? null} wait={v.deployWait ?? null} now={now} queue={v.runnerQueue ?? null} cancelled={v.queueCancelled ?? null} held={v.heldDeploy ?? null} />}
          {st.raw && (
            <details>
              <summary className="muted" style={{ fontSize: 13 }}>What the host said</summary>
              <p className="mono" style={{ fontSize: 13, overflowWrap: "anywhere" }} data-testid="host-said">{st.raw}</p>
            </details>
          )}
        </div>
      </div>
      {(st.primary || st.normal.length > 0) && (
        <div className="upd-main">
          {st.primary && (
            <>
              <button type="button" className={`btn${st.primary.blue ? " primary" : ""}`} data-testid="update-main" disabled={busy || st.primary.disabled || (st.primary.id !== "ask-wrapup" && st.primary.id !== "stop-stragglers" && !idle)} onClick={() => void press(st.primary!.id)}>
                {st.primary.label}
              </button>
              {st.primary.hint && <span className="muted" style={{ fontSize: 13 }}>{st.primary.hint}</span>}
            </>
          )}
          {st.normal.map((b) => (
            <button key={b.id} type="button" className="btn" disabled={act.busy} onClick={() => void normal(b.id)}>
              {b.label}
            </button>
          ))}
        </div>
      )}
      {act.view}
      <div className="upd-cols">
        <div className="upd-col">
          {wrap && wrap.runsList.length > 0 ? (
            <WrapUpRuns s={wrap} busy={act.busy} onStop={stopOne} />
          ) : (
            v?.available && st.tag === "Update ready" && <WaitingChanges commits={v.available.commits} />
          )}
          <NowRunning v={v} report={report.data} />
        </div>
        <RecentUpdates rows={history.data} />
      </div>
      {v && (
        <div className="upd-other" data-testid="other-actions">
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>Other actions</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button
              type="button"
              className="btn"
              disabled={act.busy || !idle}
              title="Builds a new runner image from the deployed code (for example new tools in apps/runner/Dockerfile), checks it, then swaps each runner when its company is idle."
              onClick={() =>
                act.run(async () => {
                  const r = await api<{ queued?: boolean; message?: string }>("/api/self-deploy/update-runners", { method: "POST", body: {} });
                  // BOS-1086: a press that cannot run yet is queued, not refused; the status box says when it starts.
                  if (r?.queued) {
                    view.reload();
                    return r.message ?? "The runner update is queued.";
                  }
                  go("decisions");
                })
              }
            >
              Build and update runners
            </button>
            <button type="button" className="btn" disabled={act.busy} onClick={() => void wrapUp()} title="Stop the running agents cleanly before an update, if any are going.">
              Ask agents to wrap up
            </button>
            <button
              type="button"
              className="btn"
              disabled={act.busy || !idle || !v.available?.deployed}
              title="Starts the server again at the version it runs now (BOS-647). Use it when a server-health card says memory is high or freezes are piling up and no update is waiting."
              onClick={() => {
                const bg = v.available?.bluegreen === true;
                const ask = bg
                  ? "Restart the server? It starts a fresh copy of the current version and switches over; pages keep working. The one-step rollback to the release before this one is lost. Continue?"
                  : "Restart the server? It stops for about a minute while it restarts; runs pick up again after. Continue?";
                if (!window.confirm(ask)) return;
                act.run(async () => {
                  await api("/api/self-deploy/restart", { method: "POST", body: {} });
                  return "Restart requested. The host picks it up within a minute; the status above shows how it went.";
                });
              }}
            >
              Restart the server…
            </button>
          </div>
          {wrap && (
            <div>
              <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await api("/api/maintenance/cancel-wrap", { method: "POST", body: {} }); maint.reload(); return "Wrap-up cancelled: runs already told still end by themselves; an update keeps waiting for them."; })}>
                Cancel wrap-up
              </button>
            </div>
          )}
          <details>
            <summary className="muted" style={{ fontSize: 13 }}>For a hand-built runner image</summary>
            <p className="muted" style={{ fontSize: 13 }}>
              Only after you ran scripts/update-runner.sh yourself: puts every company's runner on the newest image. Nothing new starts, runs in progress finish, and each runner is swapped as its company goes idle.
            </p>
            <button
              type="button"
              className="btn"
              disabled={act.busy || !!maint.data?.on}
              onClick={() =>
                act.run(async () => {
                  await api("/api/maintenance/start", { method: "POST", body: {} });
                  maint.reload();
                })
              }
            >
              Update runners (finish runs first)
            </button>
          </details>
        </div>
      )}
    </Section>
  );
}

/** The agents still running while an update or wrap-up waits, each with its ticket and, once stuck, a Stop (BOS-929, BOS-1238). */
export function WrapUpRuns({ s, busy, onStop }: { s: WrapUpStatus; busy: boolean; onStop: (run: WrapUpRun) => void }) {
  return (
    <div data-testid="wrapup-box">
      <p style={{ margin: 0, fontSize: 14 }}>{s.runsList.length === 1 ? "1 agent still running:" : `${s.runsList.length} agents still running:`}</p>
      <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }} data-testid="wrapup-runs">
        {s.runsList.map((run) => {
          const onCard = !!run.waitingOn;
          const late = !onCard && run.sinceWrapUpMinutes >= s.notRespondingAfter;
          // BOS-1016: a run inside one long step (a check, a build) is busy, not stuck.
          const step = run.step ?? null;
          return (
            <li key={run.runId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
              <strong title={run.agent ?? undefined}>{run.agent ? run.agent.split(/\s+[-–]\s+/)[0] : "An agent"}</strong>
              <span className="muted">
                {run.ticket ? `${run.ticket}${run.ticketTitle ? `: ${run.ticketTitle}` : ""}` : "no ticket"} · asked to wrap up {run.sinceWrapUpMinutes} min ago
                {step ? ` · running ${step.title} for ${step.sinceMinutes} min` : ""}
              </span>
              {onCard ? (
                <span className="tag amber" title={run.waitingOn!.question}>Waiting for an answer</span>
              ) : late ? (
                <span className="tag red" title={`Still going ${s.notRespondingAfter} minutes or more after being asked to wrap up.`}>Still going after {run.sinceWrapUpMinutes} min</span>
              ) : run.gotMessage ? (
                <span className="tag grey" title="It has the message and is saving its work.">Finishing up</span>
              ) : step ? (
                <span className="tag grey" title={`It is running ${step.title}. Some agents can only read the wrap-up message when this step ends, so if you want it to stop now use Stop this run.`}>In a long step: it will stop when this step ends</span>
              ) : (
                <span className="tag grey">Working</span>
              )}
              <button type="button" className="btn small" disabled={busy} onClick={() => onStop(run)}>
                Stop this run
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted" style={{ fontSize: 13 }} data-testid="wrapup-note">
        Stopping ends that agent where it got to, so anything it hasn't saved yet is lost. It isn't woken again afterwards: its ticket waits where it stopped.
      </p>
    </div>
  );
}

/** Now running: the server's version as a date and each company's runner (BOS-1238). Replaces the Runner update box's "Now" list. */
function NowRunning({ v, report }: { v: SelfDeployView | null; report: Report | null }) {
  const s = v?.status;
  const server = s && s.target === "server" && s.result === "deployed" ? when(s.ended || s.started) : null;
  return (
    <div role="status" data-testid="runner-live">
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Now running</h3>
      <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
        {server && (
          <li style={{ listStyle: "none" }}>
            <strong>Server</strong> <span className="muted">updated {server}</span>
          </li>
        )}
        {report?.live?.map((l) => <LiveState key={l.slug} r={l} />)}
      </ul>
      {report?.live && !report.live.length &&<p className="muted" style={{ fontSize: 14 }}>No company has a runner yet.</p>}
    </div>
  );
}

/** Recent updates: the last 5 server updates and runner rebuilds, newest first (BOS-1238). */
function RecentUpdates({ rows }: { rows: HistoryRow[] | null }) {
  return (
    <div className="upd-col" data-testid="recent-updates">
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Recent updates</h3>
      {rows === null ? (
        <p className="muted" style={{ fontSize: 14 }}>Checking…</p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>No update has gone in yet.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          {rows.map((r) => {
            const t = historyTag(r);
            return (
              <li key={r.id} className="upd-row" style={{ listStyle: "none" }}>
                <span>{when(r.at)}</span>
                <span>{historyWhat(r)}</span>
                <span className={`tag ${t.tone}`}>{t.tag}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p style={{ fontSize: 13 }}><a href="#/decisions">All updates</a></p>
    </div>
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

type CheckQueueView = { mode: "legacy" | "server"; slots: number; effectiveSlots?: number; runnerSlotsReported?: number | null; maxSlots: number; defaultSlots: number; runnersTooOld: string[]; train?: boolean; runnersTooOldForTrain?: string[]; cancelled?: number; applying?: boolean; runner?: { slots: number; memoryBytes: number; perCheckBytes?: number; reason: string | null; pending: number; applying: boolean; runnerCount?: number } | null; workers?: CheckWorkerView[] };

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
      <MoreAbout lead="Stops every company from starting new agent runs until you press Resume.">
        <li>Runs already going are not cut off. They finish by themselves. To end one now, use the Runs page.</li>
        <li>Wake-ups and messages wait in line, and start when you resume.</li>
        <li>While work is stopped, every page shows a banner at the top. Press Resume on it to start work again.</li>
      </MoreAbout>
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

/**
 * Settings → Server and runner → Private details to block (BOS-979): the owner's real IPs, host names, NAS paths and personal
 * email that the merge-line check must keep out of the repo. Write-only: the saved list is never shown again, only how many
 * entries of each kind it holds.
 */
export function PrivateDetails() {
  const view = usePoll((signal) => api<{ total: number; counts: Record<string, number> }>("/api/private-details", { signal }), 30_000, "private-details");
  const act = useAction();
  const [text, setText] = useState("");
  const d = view.data;
  // Drawn at once, before the count arrives: a box that appears late pushes "This host" down mid-jump (the On this page link then stops short).
  const total = d?.total ?? 0;
  const kinds = Object.entries(d?.counts ?? {}).map(([k, n]) => `${n} ${k}`).join(", ");
  return (
    <Section id="private-details-h" title="Private details to block">
      <p className="muted" style={{ fontSize: 14 }}>
        The merge check stops any change that adds one of these to the code, so they can't be published when the repository goes public. Paste your real home IP addresses, host names, NAS or host folder paths and personal email addresses, one per line. Start a line with ip:, host:, path: or email: to say what it is, or just paste it and Boss Man guesses. An address ending in a dot (192.168.7.) blocks the whole range. Made-up examples such as 192.168.1.50, example.com and myserver are never blocked unless you list them. An entry is matched as plain text, so write each value the way it appears in the code; use at least 3 characters, and avoid short words such as "nas" that would match inside other words. It is stored encrypted, never shown again and never put in the repository or in a check log, and it is only given to the runner's own scan, never to the branch's code. The check for keys, tokens and passwords runs whether or not you add anything here.
      </p>
      <p style={{ fontSize: 14 }} data-testid="private-details-state">
        {!d ? "Loading…" : total === 0 ? "Nothing listed yet." : `${total} entr${total === 1 ? "y" : "ies"} saved (${kinds}). Saving a new list replaces it.`}
      </p>
      <label htmlFor="private-details-text">New list (replaces the saved one; leave empty and save to clear it)</label>
      <DraftTextarea draftKey={null} noDraft="holds the owner's real home details, which must not be kept in the browser" id="private-details-text" rows={6} value={text} onChange={setText} autoComplete="off" spellCheck={false} style={{ width: "100%", maxWidth: 520, fontFamily: "monospace" }} />
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || !d || (text.trim() === "" && total === 0)}
          onClick={() =>
            void act.run(async () => {
              const r = await api<{ total: number }>("/api/private-details", { method: "PUT", body: { text } });
              setText("");
              view.reload();
              return r.total === 0 ? "List cleared." : `Saved ${r.total} entr${r.total === 1 ? "y" : "ies"}.`;
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

/** Settings → Server and runner → Checks (BOS-798): the owner's switch for the server-owned check queue (DR-003). */
export function CheckQueueSetting() {
  const view = usePoll((signal) => api<CheckQueueView>("/api/settings/check-queue", { signal }), 30_000, "check-queue");
  const act = useAction();
  const [edit, setEdit] = useState<{ mode: "legacy" | "server"; slots: string; train: boolean } | null>(null);
  const d = view.data;
  if (!d) return null;
  const v = edit ?? { mode: d.mode, slots: String(d.slots), train: !!d.train };
  const n = Number(v.slots);
  const valid = Number.isInteger(n) && n >= 1 && n <= d.maxSlots;
  const changed = v.mode !== d.mode || n !== d.slots || v.train !== !!d.train;
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
        {d.effectiveSlots !== undefined && d.mode === "server" && (
          <p style={{ fontSize: 14 }} data-testid="check-effective-slots">
            Checks running at once right now: <strong>{d.effectiveSlots}</strong>.
            {d.runnerSlotsReported !== null && d.runnerSlotsReported !== undefined && d.runnerSlotsReported < d.slots ? <> The runner says it runs {d.runnerSlotsReported} at once, so Boss Man starts no more than that until the runner is restarted with the new setting.</> : null}
          </p>
        )}
        {d.runner && (
          <p style={{ fontSize: 14 }} data-testid="check-runner-limit">
            Limit in force on the runners: <strong>{d.runner.slots} at once</strong> ({Math.round((d.runner.memoryBytes / 1024 ** 3) * 10) / 10} GB memory limit for the whole runner, shared by its agents and every check). That runner limit is a cap, not memory set aside: a runner only uses what its agents and checks need, and the machine's own free memory is never reserved.
            {d.runner.perCheckBytes ? <> Separately, each single check is stopped with a clear message if it uses more than {Math.round((d.runner.perCheckBytes / 1024 ** 3) * 10) / 10} GB, so one runaway check cannot starve the others.</> : null}
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
      <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <input type="checkbox" data-testid="merge-train" checked={v.train} onChange={(e) => setEdit({ ...v, train: e.target.checked })} />
        <span>
          <strong>Land approved merges in order (merge train).</strong>{" "}
          <span className="muted">Up to one approved ticket per check slot is checked on top of the tickets ahead of it, and they land in that order, so a merge landing ahead no longer spoils the long checks behind it. Main still only ever gets exactly what passed its check. Needs the server queue. Turning it off takes effect for the next merge.</span>
        </span>
      </label>
      {v.train && (d.runnersTooOldForTrain ?? []).length > 0 && (
        <p style={{ fontSize: 14 }} data-testid="merge-train-old-runner">
          <span className="tag red">Update needed</span> The runner for {d.runnersTooOldForTrain!.join(", ")} is too old for the merge train; its merges land one at a time as before until you update the runners (Updates → Build and update runners).
        </p>
      )}
      <CheckWorkers workers={d.workers ?? []} maxSlots={d.maxSlots} reload={view.reload} />
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
              const r = await api<CheckQueueView>("/api/settings/check-queue", { method: "PUT", body: { mode: v.mode, slots: n, train: v.train } });
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

type MainCiView = { on: boolean; projects: Array<{ projectId: string; project: string; status: { state: string; detail?: string } }> };

/** Settings → Server and runner → Main's CI (BOS-1072): the switch for the watcher that opens a ticket when GitHub CI fails on main, and its plain line per project. */
export function MainCiSetting() {  const view = usePoll((signal) => api<MainCiView>("/api/settings/main-ci", { signal }), 60_000, "main-ci");
  const act = useAction();
  const d = view.data;
  if (!d) return null;
  return (
    <Section id="main-ci-h" title="Main's CI">
      <p className="muted" style={{ fontSize: 14 }}>
        When GitHub's CI fails on a project's main branch (a push or the nightly run), Boss Man opens one ticket for each failing step, adds later failed runs to it instead of opening another, and says so on it when main is green again. It sends no cards and no alerts.
      </p>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={d.on}
          disabled={act.busy}
          onChange={(e) =>
            void act.run(async () => {
              await api<MainCiView>("/api/settings/main-ci", { method: "PUT", body: { on: e.target.checked } });
              view.reload();
              return e.target.checked ? "Watching main's CI." : "Stopped watching main's CI.";
            })
          }
        />
        Watch main's CI and open tickets for failures
      </label>
      {d.on && d.projects.length > 0 && (
        <ul style={{ fontSize: 14 }} data-testid="main-ci-status">
          {d.projects.map((p) => (
            <li key={p.projectId}>
              <strong>{p.project}:</strong> {p.status.detail ?? "Not checked yet."}
            </li>
          ))}
        </ul>
      )}
      {act.view}
    </Section>
  );
}

type EmailView = { settings: { host: string; port: number; security: "starttls" | "tls" | "none"; username: string | null; fromAddress: string; fromName: string | null; hasPassword: boolean } | null; configured: boolean };

/** Outgoing email (BOS-1387): plain authenticated SMTP. The password goes to the secret store and is never shown again. */
export function EmailSetting() {
  const view = usePoll((signal) => api<EmailView>("/api/settings/email", { signal }), 60_000, "email-settings");
  const act = useAction();
  const testAct = useAction();
  const [edit, setEdit] = useState<{ host: string; port: string; security: "starttls" | "tls" | "none"; username: string; fromAddress: string; fromName: string; password: string } | null>(null);
  const [testTo, setTestTo] = useState("");
  const d = view.data;
  if (!d) return null;
  const s = d.settings;
  const v = edit ?? { host: s?.host ?? "", port: String(s?.port ?? 587), security: s?.security ?? "starttls", username: s?.username ?? "", fromAddress: s?.fromAddress ?? "", fromName: s?.fromName ?? "", password: "" };
  const set = (patch: Partial<typeof v>) => setEdit({ ...v, ...patch });
  const port = Number(v.port);
  const valid = v.host.trim() !== "" && Number.isInteger(port) && port >= 1 && port <= 65535 && v.fromAddress.includes("@");
  const field = { display: "flex", flexDirection: "column", gap: 4 } as const;
  return (
    <Section id="email-h" title="Outgoing email">
      <p className="muted" style={{ fontSize: 14 }}>
        {d.configured ? "Outgoing email is on." : "Outgoing email is off: nothing that needs email (like the portal's confirmation emails) can send until you set it up."} Use the SMTP details your mail provider gives you (for Proton Mail: smtp.protonmail.ch, port 587, STARTTLS, your address and its SMTP token). The password is kept in Boss Man's secret store and is never shown again.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <div style={field}>
          <label htmlFor="email-host">Server</label>
          <input id="email-host" value={v.host} placeholder="smtp.example.com" onChange={(e) => set({ host: e.target.value })} />
        </div>
        <div style={field}>
          <label htmlFor="email-port">Port</label>
          <input id="email-port" type="number" min={1} max={65535} value={v.port} onChange={(e) => set({ port: e.target.value })} style={{ width: 100 }} />
        </div>
        <div style={field}>
          <label htmlFor="email-security">Security</label>
          <select id="email-security" value={v.security} onChange={(e) => set({ security: e.target.value as typeof v.security })}>
            <option value="starttls">STARTTLS (usually port 587)</option>
            <option value="tls">TLS from the start (usually port 465)</option>
            <option value="none">None (not encrypted)</option>
          </select>
        </div>
        <div style={field}>
          <label htmlFor="email-user">Username</label>
          <input id="email-user" value={v.username} autoComplete="off" onChange={(e) => set({ username: e.target.value })} />
        </div>
        <div style={field}>
          <label htmlFor="email-password">Password or token</label>
          <input id="email-password" type="password" value={v.password} autoComplete="new-password" placeholder={s?.hasPassword ? "Saved (type to replace)" : ""} onChange={(e) => set({ password: e.target.value })} />
        </div>
        <div style={field}>
          <label htmlFor="email-from">From address</label>
          <input id="email-from" type="email" value={v.fromAddress} placeholder="boss@example.com" onChange={(e) => set({ fromAddress: e.target.value })} />
        </div>
        <div style={field}>
          <label htmlFor="email-from-name">From name (optional)</label>
          <input id="email-from-name" value={v.fromName} onChange={(e) => set({ fromName: e.target.value })} />
        </div>
      </div>
      {v.security === "none" && <p role="note" className="error" style={{ fontSize: 14 }}>With no security the password and the mail cross the network in the clear. Use it only on a network you trust.</p>}
      <p className="muted" style={{ fontSize: 14 }}>
        The sending domain needs SPF, DKIM and DMARC records, or mail will land in spam. The Writer's guide has the details.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api("/api/settings/email", { method: "PUT", body: { host: v.host, port, security: v.security, username: v.username.trim() || null, fromAddress: v.fromAddress, fromName: v.fromName.trim() || null, ...(v.password ? { password: v.password } : {}) } });
              setEdit(null);
              view.reload();
              return "Saved.";
            })
          }
        >
          Save
        </button>
        {d.configured && (
          <button
            type="button"
            className="btn"
            disabled={act.busy}
            onClick={() =>
              void act.run(async () => {
                await api("/api/settings/email", { method: "DELETE" });
                setEdit(null);
                view.reload();
                return "Outgoing email is off and the password is removed.";
              })
            }
          >
            Turn off
          </button>
        )}
      </div>
      {act.view}
      {d.configured && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="email-test-to">Send a test email to</label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input id="email-test-to" type="email" value={testTo} placeholder="you@example.com" onChange={(e) => setTestTo(e.target.value)} />
            <button
              type="button"
              className="btn"
              disabled={testAct.busy || !testTo.includes("@")}
              onClick={() =>
                void testAct.run(async () => {
                  await api("/api/settings/email/test", { method: "POST", body: { to: testTo } });
                  return `Sent. Check ${testTo} (and its spam folder).`;
                })
              }
            >
              Send test email
            </button>
          </div>
          <p className="muted" style={{ fontSize: 14 }}>The test uses the saved settings, so save first.</p>
          {testAct.view}
        </div>
      )}
    </Section>
  );
}

