import { useEffect, useState } from "react";
import { api, ApiError, type Company } from "../../api";
import { stopRun } from "../../stop-run";
import { useOlder, usePoll } from "../../hooks";
import { ShowOlder } from "../../components/ShowOlder";
import { inForceHeadline, inForceReason, type LimitInForce } from "../../limit-in-force";
import { setHold, useHold } from "../../hold";
import { MoreAbout } from "../../components/MoreAbout";
import { Loader } from "../../components/Loader";
import { LoadError } from "../../components/LoadError";
import { when } from "../Runs";
import { DraftTextarea } from "../../components/DraftTextarea";
import { SaveButton } from "../../components/SaveButton";
import { Section, useAction } from "./shared";
import { GuideLink } from "../../guide-links";
import { CheckWorkers, type CheckWorkerView } from "./CheckWorkers";
import { ReleaseNotice, type ReleaseWatchView } from "./ReleaseNotice";
import { DEFAULT_POLICY, policyLine, policyValid, SlotSplitFields, type SlotPolicy } from "./SlotSplit";
import { LiveState, RUNNER_APPROVED_REPLY, RUNNER_QUEUED_REPLY, atTime, historyTag, historyWaitingOn, historyWhat, inAbout, runnerProgress, updateStatus, type RunnerProgress, type DeployWaitView, type HistoryRow, type MaintenanceView, type Report, type SelfDeployView, type UpdateStatus, type WrapUpRun, type WrapUpStatus } from "./updates";

/**
 * BOS-2701: why "Build and update runners" can't take a press now, or null when it can. The server queues a press at
 * every stage of an update, including the minute after a deploy when the host's offer is gone; it refuses only when the
 * deployer never reported or is late. Then the button is disabled with this one line, and nothing on the panel says "press".
 * Kept here, not in updates.tsx, because App.tsx loads updates.tsx on first load and this belongs to the lazy Settings page.
 */
export function runnerPressBlocked(v: SelfDeployView): string | null {
  const d = v.deployer;
  if (v.available || (d?.reportedAt && !d.late)) return null;
  return d?.reportedAt
    ? `Build and update runners is ready again once the host deployer reports; it last reported ${when(d.reportedAt)}.`
    : "Build and update runners is ready once the host deployer has reported for the first time.";
}

/** The company's workspace disk cap (R54, BOS-274): over it, the owner hears once a day; nothing is stopped. */
export function WorkspaceDisk({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [gb, setGb] = useState(company.diskCapBytes != null ? String(+(company.diskCapBytes / 1024 ** 3).toFixed(1)) : "");
  const [base, setBase] = useState(gb);
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const n = Number(gb);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100_000;
  return (
    <Section id="workspace-disk-h" title="Workspace disk">
      <p className="muted" style={{ fontSize: 14 }}>
        Each ticket keeps its working files on the runner's disk until it has been done for a while. When the company's workspaces grow past this amount, Boss Man tells you once a day with the biggest ones named. It is a warning only: it never stops runs or refuses new workspaces. The working files of tickets done more than 7 days ago are cleared automatically.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="disk-cap">
          Most disk to use (GB)
        </label>
        <input id="disk-cap" type="number" min={1} max={100000} step={1} placeholder="20" value={gb} onChange={(e) => setGb(e.target.value)} style={{ width: 100 }} />
        <SaveButton
          dirty={gb !== base}
          saved={saved}
          busy={act.busy}
          disabled={!valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { diskCapGb: n } });
              setBase(gb);
              setSaved(true);
              onChanged();
              return "Saved. It applies at the next hourly clean-up.";
            })
          }
        />
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {company.diskCapBytes != null ? `Currently ${(company.diskCapBytes / 1024 ** 3).toFixed(1)} GB.` : "Currently the server default, 20 GB."}
      </p>
      {act.view}
    </Section>
  );
}

type ServerHealthView = {
  disk: { freeBytes: number; totalBytes: number; freePercent: number } | null;
  database: { bytes: number | null; dayAgoBytes: number | null; weekAgoBytes: number | null; growthPercent7d: number | null };
  history?: { day: string; bytes: number }[];
  limits: { statementTimeouts: number; poolFull: number };
  slowQueries: { seconds: number; query: string }[];
  warnings: string[];
};
const healthGb = (b: number | null) => (b === null ? "not available" : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(0)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`);
const healthChange = (diff: number) => `${diff < 0 ? "−" : "+"}${healthGb(Math.abs(diff))}`;
const DAY_MS = 86_400_000;

/** BOS-2487: one row per recorded day with the change from the day before; a day that grew over 10% is marked. */
export function DbHistory({ history }: { history: { day: string; bytes: number }[] | undefined }) {
  const rows = history ?? [];
  if (!rows.length) return null;
  return (
    <details data-testid="health-db-history" style={{ fontSize: 14, marginTop: 6 }}>
      <summary>Database size, last 14 days</summary>
      {rows.length < 14 && <p className="muted" style={{ margin: "4px 0" }}>{rows.length === 1 ? "1 day recorded so far" : `${rows.length} days recorded so far`}</p>}
      <table style={{ borderCollapse: "collapse" }}>
        <tbody>
          {rows.map((r, i) => {
            const prev = rows[i - 1];
            const consecutive = prev && Date.parse(r.day) - Date.parse(prev.day) === DAY_MS;
            const diff = consecutive ? r.bytes - prev.bytes : null;
            const jump = consecutive && prev.bytes > 0 && r.bytes / prev.bytes - 1 > 0.1;
            return (
              <tr key={r.day} data-testid={jump ? "health-db-jump" : undefined} style={jump ? { fontWeight: 600 } : undefined}>
                <td style={{ paddingRight: 16 }}>{r.day}</td>
                <td style={{ paddingRight: 16 }}>{healthGb(r.bytes)}</td>
                <td className={jump ? "error" : "muted"}>{diff === null ? "" : healthChange(diff)}{jump ? " (grew over 10%)" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

/** BOS-2380: the server's own disk, database size and query limits, read when the page loads. Read-only: no buttons. */
export function ServerHealth() {
  const view = usePoll((signal) => api<ServerHealthView>("/api/data-health", { signal }), 60_000, "data-health");
  // An answer without the expected parts (an old server, a stub) shows the loader, not a blank page.
  const v = view.data && view.data.database && view.data.limits ? view.data : undefined;
  return (
    <Section id="server-health-h" title="Server health">
      <p className="muted" style={{ fontSize: 14 }}>
        Free space on the disk holding the server's data, the size of the database, and queries that were cut off or are running long. You get one notice a day when free space drops below 10% or 5 GB, or the database grows more than 50% in 7 days. Nothing is stopped by it.
      </p>
      {view.error && !v ? <LoadError what="server health" message={view.error.message} onRetry={view.reload} /> : !v ? <Loader /> : (
        <>
          {(v.warnings ?? []).map((w) => (
            <p key={w} className="error" role="alert">{w}</p>
          ))}
          <ul style={{ fontSize: 14, margin: 0, paddingLeft: 18 }}>
            <li data-testid="health-disk">Data disk: {v.disk ? `${healthGb(v.disk.freeBytes)} free of ${healthGb(v.disk.totalBytes)} (${v.disk.freePercent.toFixed(0)}% free)` : "not available"}</li>
            <li data-testid="health-db">
              Database: {healthGb(v.database.bytes)}. 1 day ago {healthGb(v.database.dayAgoBytes)}, 7 days ago {healthGb(v.database.weekAgoBytes)}
              {v.database.growthPercent7d !== null ? ` (growth: ${v.database.growthPercent7d > 0 ? "+" : ""}${v.database.growthPercent7d}% in 7 days)` : " (growth: not enough history yet)"}. Earlier days fill in as the server keeps one reading a day.
              <DbHistory history={v.history} />
            </li>
            <li data-testid="health-limits">Last 24 hours (since the server started, if less): {v.limits.statementTimeouts} queries cut off for running too long, {v.limits.poolFull} times the connection pool was full.</li>
            <li data-testid="health-slow">
              {v.slowQueries?.length ? "Running over 60 seconds now:" : "No query is running over 60 seconds."}
              {(v.slowQueries ?? []).map((q, i) => (
                <div key={i} className="mono" style={{ fontSize: 13 }}>{q.seconds} s: {q.query}</div>
              ))}
            </li>
          </ul>
        </>
      )}
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
export function TrialLines({ trial, wait, now, queue, cancelled, held, failureHolds, wrapNamesRunner, pressBlocked }: { trial?: { endsAt: string } | null; wait?: { until: string; target?: string } | null; now: number; queue?: { startsAt: string | null; why: string } | null; cancelled?: { why: string } | null; held?: { commit: string } | null; failureHolds?: { subject: string; words: string }[]; /** BOS-2672: the wrap-up line above already names the runner update and its time, so it isn't said twice. */ wrapNamesRunner?: boolean; /** BOS-2701: the button can't take a press now, so the trial line doesn't invite one. */ pressBlocked?: boolean }) {
  const trialOver = wrapNamesRunner || (trial ? Date.parse(trial.endsAt) <= now : false);
  if (wrapNamesRunner) queue = null;
  const waitOver = wait ? Date.parse(wait.until) <= now : false;
  return (
    <>
      {/* BOS-2562: a failed update is held while its failure is looked into, so no Deploy card is on the queue. The server's words, one line per hold. */}
      {(failureHolds ?? []).map((h) => (
        <p className="muted" role="status" key={h.subject} data-testid="failure-hold" style={{ fontSize: 14, overflowWrap: "anywhere" }}>
          {h.words}
        </p>
      ))}
      {trial && !trialOver && (
        <p className="muted" role="status" data-testid="runner-trial" style={{ fontSize: 14 }}>
          {queue
            ? `Runners will update at ${atTime(trial.endsAt)} (${inAbout(trial.endsAt, now)}), when this server update's trial ends. You don't need to press again.`
            : pressBlocked
              ? `The server update is in its trial until ${atTime(trial.endsAt)} (${inAbout(trial.endsAt, now)}).`
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
          {waitOver ? "You can deploy now." : `A ${wait.target === "runner" ? "runner" : "server"} deploy was refused to keep one every 10 minutes. You can deploy again from ${atTime(wait.until)}, ${inAbout(wait.until, now)}.`}
        </p>
      )}
    </>
  );
}

/** What the host deployer last did, and a button to ask for the newest main (docs/09-self-deploy.md). Hidden when self-deploy is off. */
export function SelfDeploy({ go }: { go: (to: string) => void }) {
  const view = usePoll((signal) => api<SelfDeployView>("/api/self-deploy", { signal }), 10_000, "self-deploy");
  // BOS-2821: an image install (the updater is present) has no host deployer, so the no-deployer text does not apply; tell
  // it apart from a build-from-source install by the release watch, which only runs on an image install.
  const releaseWatch = usePoll((signal) => api<ReleaseWatchView>("/api/release-watch", { signal }), 10_000, "release-watch");
  const wait = usePoll((signal) => api<DeployWaitView>("/api/self-deploy/wait", { signal }), 10_000, "self-deploy-wait");
  const maint = usePoll((signal) => api<MaintenanceView>("/api/maintenance", { signal }), 5_000, "maintenance-updates");
  const report = usePoll((signal) => api<Report>("/api/runner-report", { signal }), 5_000, "runner-report");
  const history = usePoll((signal) => api<HistoryRow[]>(`/api/self-deploy/history?limit=${HISTORY_FIRST}`, { signal }), 30_000, "self-deploy-history");
  // "Show older" (BOS-2277): 10 more rows each press, after the newest 5.
  const newestHistory = Array.isArray(history.data) ? history.data : null; // a non-list reply (a stub, an error body) is no rows
  const olderHistory = useOlder(newestHistory, HISTORY_FIRST, (before) => api<HistoryRow[]>(`/api/self-deploy/history?limit=${HISTORY_MORE}&before=${before}`), "self-deploy-history", HISTORY_MORE);
  const act = useAction();
  // A clock so the trial and rate-limit lines count down between polls (BOS-953).
  const now = useNow();
  const v = view.data;
  if (v && !v.enabled) {
    const rw = releaseWatch.data;
    // BOS-2821 (F27): on an image install the updater delivers releases, so there is no deployer, no scripts/update-runner.sh
    // and nothing to press here. The release notice above already says what is new; one plain line says whether to act.
    if (rw?.active === true) {
      return (
        <Section id="deploy-h" title="Updates">
          <ReleaseNotice />
          <p className="muted" style={{ fontSize: 14 }} data-testid="updates-image-line">
            You run {rw.current}. New releases appear here; nothing to do now.
          </p>
          <p style={{ fontSize: 14 }}>
            <GuideLink slug="how-updates-work">What happens in an update?</GuideLink>
          </p>
        </Section>
      );
    }
    // While the release watch loads, show only the release notice: never flash the host-deployer words on an image install.
    if (!rw) {
      return (
        <Section id="deploy-h" title="Updates">
          <ReleaseNotice />
        </Section>
      );
    }
    // BOS-1486: a build-from-source install with no host deployer keeps the hand-built image steps (no updater here).
    return (
      <Section id="deploy-h" title="Updates">
        <ReleaseNotice />
        <p className="muted" style={{ fontSize: 14 }}>
          Building the image from here needs the host deployer, and this install doesn't have one, so there is no Build and update runners button. Build the image on the host with scripts/update-runner.sh, then use the button below. To get in-app updates, set up the host deployer (<a href="https://github.com/Leonfinn/Boss_Man/blob/main/docs/30-in-app-updates.md" target="_blank" rel="noreferrer">how to set it up</a>).
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
  const progress = runnerProgress(report.data?.live, maint.data, v?.runnerImage?.needed);
  const st = updateStatus(v, maint.data, wait.data, now, { runnersAt: report.data?.update?.at ?? null });
  const wrap = maint.data && maint.data.on && ((maint.data as WrapUpStatus).wrapAsked || maint.data.kind === "wrapup") ? (maint.data as WrapUpStatus) : null;
  const busy = act.busy || !v;
  const idle = !!v && !v.pending && s?.result !== "running";
  // BOS-2701: the server queues every press except while the deployer never reported or is late; then say so and disable.
  const runnersBlocked = v ? runnerPressBlocked(v) : null;

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
  const updateNow = () =>
    act.run(async () => {
      if (!window.confirm("Stop the running checks and update the runners now? Each check starts again from the beginning afterwards, so the time it has already spent is lost.")) return;
      try {
        await api("/api/maintenance/update-now", { method: "POST", body: {} });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) return err.message;
        throw err;
      }
      maint.reload();
      // BOS-2531: the press only lets the swap go ahead; the status above says "being swapped now" once a runner is.
      return "The checks are stopped and the runners are swapped next. The checks start again afterwards.";
    });
  const press = (id: NonNullable<UpdateStatus["primary"]>["id"]) => {
    if (id === "ask-wrapup") return wrapUp();
    if (id === "update-now") return updateNow();
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
      const said = await stopRun(run.runId, run.agent);
      if (!said) return;
      maint.reload();
      return said;
    });

  return (
    <Section id="deploy-h" title="Updates">
      <ReleaseNotice />
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
          {v && <TrialLines trial={v.trial ?? null} wait={v.deployWait ?? null} now={now} queue={v.runnerQueue ?? null} cancelled={v.queueCancelled ?? null} held={v.heldDeploy ?? null} failureHolds={v.failureHolds ?? []} wrapNamesRunner={!!wrap?.wrapTie?.runner} pressBlocked={!!runnersBlocked} />}
          {st.raw && (
            <details>
              <summary className="muted" style={{ fontSize: 13 }}>What the host said</summary>
              <p className="mono" style={{ fontSize: 13, overflowWrap: "anywhere" }} data-testid="host-said">{st.raw}</p>
            </details>
          )}
        </div>
      </div>
      <p style={{ margin: 0 }}>
        <GuideLink slug="how-updates-work">What happens in an update?</GuideLink>
      </p>
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
          <NowRunning v={v} report={report.data} progress={progress} />
        </div>
        <RecentUpdates rows={olderHistory.rows} liveRows={newestHistory} older={olderHistory} progress={progress} wait={wait.data} maint={maint.data} queued={!!v?.runnerQueue} />
      </div>
      {v && (
        <div className="upd-other" data-testid="other-actions">
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>Other actions</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button
              type="button"
              className="btn"
              disabled={act.busy || !idle || !!runnersBlocked}
              title="Builds a new runner image from the deployed code (for example new tools in apps/runner/Dockerfile), checks it, then swaps each runner when its company is idle."
              onClick={() =>
                act.run(async () => {
                  const r = await api<{ queued?: boolean; approved?: boolean; message?: string; note?: string | null }>("/api/self-deploy/update-runners", { method: "POST", body: {} });
                  // BOS-2859: the press is the approval, so the page stays here and the status box above shows how it goes.
                  view.reload();
                  maint.reload();
                  // BOS-1086: a press that cannot run yet is queued, not refused; the status box says when it starts.
                  // BOS-2672: the status box above says when it starts; repeating the time here put it on screen twice.
                  // BOS-1644: when Boss Man could not confirm a fix is live and went ahead, the note says why.
                  const said = r?.queued ? RUNNER_QUEUED_REPLY : r?.approved === false ? `${r.message ?? "The runner update could not start."} Its card is in Decisions.` : RUNNER_APPROVED_REPLY;
                  return r?.note ? `${said} ${r.note}` : said;
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
          {runnersBlocked && (
            <p className="muted" data-testid="runners-not-ready" style={{ fontSize: 13, margin: "6px 0 0" }}>
              {runnersBlocked}
            </p>
          )}
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
      {v?.staging?.configured && (
        <div data-testid="staging-lane" style={{ marginTop: 8 }}>
          <p style={{ margin: "0 0 4px", fontSize: 14 }}>
            <strong>Staging</strong>
            {v.staging.last
              ? v.staging.last.result === "deployed"
                ? `: runs ${v.staging.last.commit.slice(0, 8)}${v.staging.last.runnerImage ? ` (runner image ${v.staging.last.runnerImage})` : ""}. Smoke checks: ${v.staging.last.smoke ?? "not run"}.`
                : `: the last staging request ${v.staging.last.result === "running" || v.staging.last.result === "held" ? "is" : "was"} ${v.staging.last.result}. ${v.staging.last.message}`
              : ": no staging deploy yet."}
          </p>
          {v.staging.last && v.staging.last.checks.length > 0 && (
            <ul className="muted" style={{ margin: "0 0 4px", paddingLeft: 18, fontSize: 14 }}>
              {v.staging.last.checks.map((c) => (
                <li key={c.name}>
                  {c.name}: {c.result}
                  {c.result !== "pass" && c.why ? ` (${c.why})` : ""}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn"
            disabled={act.busy || v.staging.pending || v.staging.last?.result === "running"}
            title="Deploys main's newest commit to staging and runs the smoke checks. Staging isn't production: no card, nothing to approve."
            onClick={() =>
              act.run(async () => {
                try {
                  await api("/api/self-deploy/deploy-staging", { method: "POST", body: {} });
                } catch (err) {
                  if (err instanceof ApiError && err.status === 409) return err.message;
                  throw err;
                }
                return "Staging deploy requested. The host picks it up within a minute; the result shows here.";
              })
            }
          >
            Deploy to staging
          </button>
          <p className="muted" data-testid="staging-help" style={{ margin: "6px 0 0", fontSize: 14 }}>
            Optional: agents deploy to staging themselves. Press this to put the newest merged code on staging and re-run the checks, for example before you allow a deploy to your real server.
          </p>
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
                {run.ticket ? `${run.ticket}${run.ticketTitle ? `: ${run.ticketTitle}` : ""}` : "no ticket"} · {run.askAt ? `Boss Man asks it to finish at ${atTime(run.askAt)}` : `asked to wrap up ${run.sinceWrapUpMinutes} min ago`}
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
function NowRunning({ v, report, progress }: { v: SelfDeployView | null; report: Report | null; progress: RunnerProgress }) {
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
        {report?.live?.map((l) => <LiveState key={l.slug} r={l} progress={progress} />)}
      </ul>
      {report?.live && !report.live.length &&<p className="muted" style={{ fontSize: 14 }}>No company has a runner yet.</p>}
    </div>
  );
}

/** Recent updates: the last 5 server updates and runner rebuilds, newest first (BOS-1238). */
const HISTORY_FIRST = 5;
const HISTORY_MORE = 10;
function RecentUpdates({ rows, liveRows, older, progress, wait, maint, queued }: { rows: HistoryRow[] | null; liveRows: HistoryRow[] | null; older: React.ComponentProps<typeof ShowOlder>["older"]; progress: RunnerProgress; wait: DeployWaitView | null; maint: MaintenanceView | null; queued: boolean }) {
  // Only the newest runner row can be mid-swap; older ones are history. BOS-2277: only the newest page (`liveRows`)
  // can hold it, so rows loaded by "Show older" never show as swapping or waiting.
  const newestRunner = liveRows?.find((r) => r.target === "runner")?.id;
  const newestServer = liveRows?.find((r) => r.target !== "runner")?.id;
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
            const t = historyTag(r, r.id === newestRunner ? progress : null);
            // BOS-2056: only the newest row of each kind can be the one that is live; older "Waiting" rows are history.
            const waitsOn = r.id === newestRunner || r.id === newestServer ? historyWaitingOn(r, wait, maint, queued) : null;
            return (
              <li key={r.id} className="upd-row" style={{ listStyle: "none" }}>
                <span>{when(r.at)}</span>
                <span>{historyWhat(r)}</span>
                <span className={`tag ${t.tone}`}>{t.tag}</span>
                {waitsOn && <span className="muted" style={{ fontSize: 13, gridColumn: "1 / -1" }} data-testid="waiting-on">{waitsOn}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <ShowOlder older={older} />
      <PastWaits />
      <p style={{ fontSize: 13 }}><a href="#/decisions">All updates</a></p>
    </div>
  );
}

/** BOS-2408: what each runner-update wait did, kept in the database so a restart doesn't erase it. */
export type PastWait = { id: string; startedAt: string; kind: string; endedAt: string | null; endOk: boolean | null; endTitle: string | null; swapTries: { slug: string; n: number; at: string; outcome: string; error?: string }[]; events: { at: string; text: string }[] };
export function pastWaitLine(w: PastWait): string {
  const failed = w.swapTries.filter((t) => t.outcome === "failed").length;
  const how = w.endedAt ? (w.endTitle ?? "ended") : "still going";
  return `${how}${failed ? `, ${failed} swap ${failed === 1 ? "try" : "tries"} failed` : ""}${w.events.length ? `, ${w.events.length} noted ${w.events.length === 1 ? "moment" : "moments"}` : ""}`;
}
function PastWaits() {
  const view = usePoll((signal) => api<{ holds: PastWait[] }>("/api/maintenance/history?limit=10", { signal }), 60_000, "maintenance-history");
  const holds = Array.isArray(view.data?.holds) ? view.data.holds : [];
  if (!holds.length) return null;
  return (
    <details data-testid="past-waits" style={{ fontSize: 13, margin: "6px 0" }}>
      <summary>Past update waits ({holds.length})</summary>
      <ul style={{ margin: 0, padding: 0 }}>
        {holds.map((w) => (
          <li key={w.id} style={{ listStyle: "none", marginTop: 6 }}>
            <strong>{when(w.startedAt)}</strong> ({w.kind}): {pastWaitLine(w)}
            {[...w.swapTries.map((t) => ({ at: t.at, text: `${t.slug} try ${t.n}: ${t.outcome}${t.error ? ` (${t.error})` : ""}` })), ...w.events]
              .sort((a, b) => a.at.localeCompare(b.at))
              .map((e, i) => (
                <div key={i} className="muted">{atTime(e.at)} {e.text}</div>
              ))}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * How many agents may run at once, in total and per company, plus the separate background slots for
 * Infinite-mode agents (BOS-279); the per-agent limit is fixed at one.
 */
/** BOS-1634: one limit's "Saved X · in force Y" line with its reason and a link to the update holding it; nothing when they match. */
function InForceLine({ limit, testId, updatesHref }: { limit: LimitInForce | undefined; testId: string; updatesHref?: string }) {
  const head = inForceHeadline(limit);
  if (!head || !limit) return null;
  return (
    <p role="status" data-testid={testId} style={{ fontSize: 14 }}>
      <strong>{head}</strong>. {inForceReason(limit)} {updatesHref ? <a href={updatesHref}>See the waiting update</a> : null}
    </p>
  );
}

export function RunLimits({ updatesHref }: { updatesHref?: string } = {}) {
  const view = usePoll(
    (signal) =>
      api<{
        instance: number;
        company: number;
        background: number;
        defaults: { instance: number; company: number; background: number };
        // BOS-1634: absent from an older server.
        inForce?: { allCompanies: LimitInForce; background: LimitInForce; mergeChecks: { paused: boolean; because: string | null; since: string | null; until: string | null } };
      }>("/api/run-limits", { signal }),
    30_000,
    "run-limits",
  );
  const act = useAction();
  const [edit, setEdit] = useState<{ instance: string; company: string; background: string } | null>(null);
  const [saved, setSaved] = useState(false);
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
        {/* BOS-1634: never a silent difference between the saved number and the one in force. */}
        <InForceLine limit={d.inForce?.allCompanies} testId="run-limits-in-force" updatesHref={updatesHref} />
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
        <label htmlFor="limit-background">
          Background agents at once (0 to 16) <code className="mono">infinite mode</code>
        </label>
        <input id="limit-background" type="number" min={0} max={16} value={v.background} onChange={(e) => setEdit({ ...v, background: e.target.value })} style={{ width: 80 }} />
        <InForceLine limit={d.inForce?.background} testId="run-limits-background-in-force" updatesHref={updatesHref} />
        <p className="muted" style={{ fontSize: 14 }}>
          Agents on Synthetic's Infinite mode ("free, slow" models) get their own slots (default {d.defaults.background}), separate from the two numbers above. They don't spend your Synthetic plan's credits, so they never wait for the quota; keeping them on their own small number means a slow free run can't take a normal slot or hold up paid work. 0 stops background runs starting.
        </p>
      </div>
      {d.inForce?.mergeChecks.paused && d.inForce.mergeChecks.because ? (
        <p role="status" data-testid="run-limits-merge-checks" style={{ fontSize: 14 }}>
          New merge checks wait too, because {d.inForce.mergeChecks.because}; they start by themselves once it is done. Quick checks on a separate check worker keep going; on the company's own runner they wait too.
        </p>
      ) : null}
      <p className="muted" style={{ fontSize: 14 }}>
        Each agent always does one piece of work at a time (it has one working folder), plus one chat with you. Your chats are never held by these limits. A company's runner is given memory to match: 2 GB, plus 1 GB for each agent it can run at once (one company's number plus the background number), plus 3 GB for each check; a change reaches each runner the next time it restarts.
      </p>
      <div>
        <SaveButton
          dirty={!!edit && (v.instance !== String(d.instance) || v.company !== String(d.company) || v.background !== String(d.background))}
          saved={saved}
          busy={act.busy}
          disabled={!valid}
          onClick={() =>
            void act.run(async () => {
              await api("/api/run-limits", { method: "PUT", body: { instance: i, company: c, background: g } });
              setEdit(null);
              setSaved(true);
              view.reload();
              return "Saved.";
            })
          }
        />
      </div>
      {act.view}
    </Section>
  );
}

/**
 * Hold new starts while the merge line or the quick-check queue is long (BOS-1489), per company. Empty = off. Only the
 * fields: WipLimits saves them together with the in-progress limits (BOS-1944), one Save for the section.
 */
function HoldStarts({ v, onChange }: { v: { merges: string; checks: string; owner: string }; onChange: (next: { merges: string; checks: string; owner: string }) => void }) {
  const setEdit = onChange;
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="hold-merges">Hold new starts while this many merges are waiting (leave empty for off)</label>
        <input id="hold-merges" type="number" min={1} max={1000} placeholder="Off" value={v.merges} onChange={(e) => setEdit({ ...v, merges: e.target.value })} style={{ width: 100 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          Off by default. While at least this many approved tickets wait in the merge line (the figure on the Merge queue page), a Ready ticket is not started: it shows "Held: 31 merges waiting (limit 20)" and starts by itself when the line is shorter. Work already in progress, reviews, sent-back work, merges, after-merge checks, urgent and live-fix tickets, and the CEO's own tickets carry on.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="hold-checks">Hold new starts while this many quick checks are queued (leave empty for off)</label>
        <input id="hold-checks" type="number" min={1} max={1000} placeholder="Off" value={v.checks} onChange={(e) => setEdit({ ...v, checks: e.target.value })} style={{ width: 100 }} />
        <p className="muted" style={{ fontSize: 14 }}>Off by default. The same hold, for quick checks waiting in the check queue. If both limits are set, either one holds new starts.</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="hold-owner">Hold new starts when this many need you (leave empty for off)</label>
        <input id="hold-owner" type="number" min={1} max={1000} placeholder="Off" value={v.owner} onChange={(e) => setEdit({ ...v, owner: e.target.value })} style={{ width: 100 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          Off by default. Counts what Needs you counts on the Dashboard: reviews, sign-offs and other cards waiting for your answer. While at least this many need you, a Ready ticket is not started: it shows "Held: 6 need you (limit 5)" and starts by itself when fewer need you. Work already started, urgent and live-fix tickets, and the CEO's own tickets carry on.
        </p>
      </div>
    </>
  );
}

/**
 * Tickets in progress per agent (BOS-1029): an agent finishes before it starts more. Only in-progress tickets
 * count (review, blocked and done don't). Empty box = No limit.
 */
export function WipLimits({ company, onChanged }: { company?: Company; onChanged?: () => void } = {}) {
  const view = usePoll((signal) => api<{ agent: number | null; company: number | null; defaultAgent: number }>("/api/wip-limits", { signal }), 30_000, "wip-limits");
  const act = useAction();
  const [edit, setEdit] = useState<{ agent: string; company: string; merges: string; checks: string; owner: string } | null>(null);
  const [saved, setSaved] = useState(false);
  // Right after a save, show what was just saved until the refetch brings the same values back (no stale numbers in between).
  const [last, setLast] = useState<{ agent: string; company: string; merges: string; checks: string; owner: string } | null>(null);
  const d = view.data;
  useEffect(() => setLast(null), [d, company?.holdStartsMergesWaiting, company?.holdStartsQuickChecksQueued, company?.holdStartsOwnerWaiting]);
  if (!d) return null;
  const text = (n: number | null | undefined) => (n == null ? "" : String(n));
  const base = last ?? { agent: text(d.agent), company: text(d.company), merges: text(company?.holdStartsMergesWaiting), checks: text(company?.holdStartsQuickChecksQueued), owner: text(company?.holdStartsOwnerWaiting) };
  const v = edit ?? base;
  const parse = (s: string) => (s.trim() === "" ? null : Number(s));
  const [a, c, m, q, o] = [parse(v.agent), parse(v.company), parse(v.merges), parse(v.checks), parse(v.owner)];
  const okHold = (n: number | null) => n === null || (Number.isInteger(n) && n >= 1 && n <= 1000);
  const valid = (a === null || (Number.isInteger(a) && a >= 1 && a <= 50)) && (c === null || (Number.isInteger(c) && c >= 1 && c <= 1000)) && (!company || (okHold(m) && okHold(q) && okHold(o)));
  const dirty = !!edit && (v.agent !== base.agent || v.company !== base.company || (!!company && (v.merges !== base.merges || v.checks !== base.checks || v.owner !== base.owner)));
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
      {company ? <HoldStarts v={v} onChange={(next) => setEdit({ ...v, ...next })} /> : null}
      <div>
        <SaveButton
          dirty={dirty}
          saved={saved}
          busy={act.busy}
          disabled={!valid}
          onClick={() =>
            void act.run(async () => {
              await api("/api/wip-limits", { method: "PUT", body: { agent: a, company: c } });
              if (company) {
                await api(`/api/companies/${company.id}`, { method: "PATCH", body: { holdStartsMergesWaiting: m, holdStartsQuickChecksQueued: q, holdStartsOwnerWaiting: o } });
                onChanged?.();
              }
              setLast(v);
              setEdit(null);
              setSaved(true);
              view.reload();
              return "Saved.";
            })
          }
        />
      </div>
      {act.view}
    </Section>
  );
}

type CheckQueueView = { mode: "legacy" | "server"; slots: number; effectiveSlots?: number; runnerSlotsReported?: number | null; maxSlots: number; defaultSlots: number; runnersTooOld: string[]; train?: boolean; runnersTooOldForTrain?: string[]; cancelled?: number; applying?: boolean; runner?: { slots: number; memoryBytes: number; perCheckBytes?: number; reason: string | null; pending: number; applying: boolean; runnerCount?: number; memoryLine?: string | null } | null; workers?: CheckWorkerView[]; runnerPolicy?: SlotPolicy; laneAgeMinutes?: number; defaultLaneAgeMinutes?: number };
/** BOS-1803: the server's MAX_BACKGROUND_LANE_AGE_MINUTES (a day); the server refuses anything above it. */
const MAX_LANE_AGE_MINUTES = 1440;

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

/** Settings → Server and runner → Limits and checks (BOS-798): the owner's switch for the server-owned check queue (DR-003). */
export function CheckQueueSetting({ companyId }: { companyId?: string } = {}) {
  const view = usePoll((signal) => api<CheckQueueView>("/api/settings/check-queue", { signal }), 30_000, "check-queue");
  const act = useAction();
  const [edit, setEdit] = useState<{ mode: "legacy" | "server"; slots: string; train: boolean; policy: SlotPolicy; laneAge: string } | null>(null);
  const [savedQueue, setSavedQueue] = useState(false);
  const d = view.data;
  if (!d) return null;
  const hasLaneAge = d.laneAgeMinutes !== undefined;
  const v = edit ?? { mode: d.mode, slots: String(d.slots), train: !!d.train, policy: d.runnerPolicy ?? DEFAULT_POLICY, laneAge: String(d.laneAgeMinutes ?? "") };
  const n = Number(v.slots);
  const lane = Number(v.laneAge);
  const laneValid = !hasLaneAge || (v.laneAge.trim() !== "" && Number.isInteger(lane) && lane >= 0 && lane <= MAX_LANE_AGE_MINUTES);
  const valid = Number.isInteger(n) && n >= 1 && n <= d.maxSlots && policyValid(v.policy, n) && laneValid;
  const was = d.runnerPolicy ?? DEFAULT_POLICY;
  const changed = v.mode !== d.mode || n !== d.slots || v.train !== !!d.train || v.policy.takes !== was.takes || v.policy.mergeKept !== was.mergeKept || (hasLaneAge && lane !== d.laneAgeMinutes);
  return (
    <Section id="check-queue-h" title="Checks">
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <legend>Who runs the checks</legend>
        <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <input type="radio" name="check-queue-mode" value="legacy" checked={v.mode === "legacy"} onChange={() => setEdit({ ...v, mode: "legacy" })} />
          <span>
            <strong>Each agent runs its own.</strong> <code className="mono">legacy</code> <span className="muted">Each agent runs the quick check inside its own session. A check dies if the session ends or the runner restarts, and agents wait in line for a free slot.</span>
          </span>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <input type="radio" name="check-queue-mode" value="server" checked={v.mode === "server"} onChange={() => setEdit({ ...v, mode: "server" })} />
          <span>
            <strong>Boss Man runs them.</strong> <code className="mono">server queue</code> <span className="muted">Agents ask for a check and Boss Man runs it on the runner. The check keeps going after the agent's session ends or the runner restarts, a pass on the same code is reused, and the agent is woken with the result. The merge check before each merge uses this queue too.</span>
          </span>
        </label>
      </fieldset>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="check-slots">Checks at once (1 to {d.maxSlots})</label>
        <input id="check-slots" type="number" min={1} max={d.maxSlots} value={v.slots} onChange={(e) => setEdit({ ...v, slots: e.target.value })} style={{ width: 80 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          How many queued checks one company's runner runs at the same time (default {d.defaultSlots}). Only used by the server queue. Each check uses a lot of memory and CPU: raise it only if the runner's machine has room, or checks start failing with out-of-memory errors. The runners' memory follows this number; there is nothing to edit on the host.
        </p>
        {/* BOS-1602: what the company runner's slots take; shown only to a server that knows the setting. */}
        {d.runnerPolicy && (
          <>
            <p style={{ fontSize: 14, margin: 0 }} data-testid="check-runner-split">
              Company runner: <strong>{policyLine(d.runnerPolicy, d.slots)}</strong>.
            </p>
            <SlotSplitFields value={v.policy} onChange={(policy) => setEdit({ ...v, policy })} slots={Number.isInteger(n) && n >= 1 ? n : 1} idPrefix="check-runner" />
          </>
        )}
        {d.effectiveSlots !== undefined && d.mode === "server" && (
          <p style={{ fontSize: 14 }} data-testid="check-effective-slots">
            Checks running at once right now: <strong>{d.effectiveSlots}</strong>.
            {d.runnerSlotsReported !== null && d.runnerSlotsReported !== undefined && d.runnerSlotsReported < d.slots ? <> The runner says it runs {d.runnerSlotsReported} at once, so Boss Man starts no more than that until the runner is restarted with the new setting.</> : null}
          </p>
        )}
        {d.runner && (
          <p style={{ fontSize: 14 }} data-testid="check-runner-limit">
            Limit in force on the runners: <strong>{d.runner.slots} at once</strong> ({Math.round((d.runner.memoryBytes / 1024 ** 3) * 10) / 10} GB memory limit for the whole runner, shared by its agents and every check).
            {/* BOS-1498: what the runner is given and why, from Agents at once and Checks at once. */}
            {d.runner.memoryLine ? <> Runner memory: <span data-testid="runner-memory-line">{d.runner.memoryLine}</span></> : null} That runner limit is a cap, not memory set aside: a runner only uses what its agents and checks need, and the machine's own free memory is never reserved.
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
          <strong>Merge approved work in the order it was approved.</strong> <code className="mono">merge train</code>{" "}
          <span className="muted">Up to one approved ticket per check slot is checked on top of the tickets ahead of it, and they land in that order, so a merge landing ahead no longer spoils the long checks behind it. Main still only ever gets exactly what passed its check. With "Wait for GitHub CI" on, each one also runs on GitHub, and a GitHub pass on a ticket further back lets the tickets ahead of it land too. Needs the server queue. Turning it off takes effect for the next merge.</span>
        </span>
      </label>
      {v.train && (d.runnersTooOldForTrain ?? []).length > 0 && (
        <p style={{ fontSize: 14 }} data-testid="merge-train-old-runner">
          <span className="tag red">Update needed</span> The runner for {d.runnersTooOldForTrain!.join(", ")} is too old for the merge train; its merges land one at a time as before until you update the runners (Updates → Build and update runners).
        </p>
      )}
      {/* BOS-1803: how long a background-lane merge lets newer ordinary work go first, then it waits by when it joined. */}
      {hasLaneAge && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="check-lane-age">Background lane gives way for (minutes, 0 to {MAX_LANE_AGE_MINUTES})</label>
          <input id="check-lane-age" type="number" min={0} max={MAX_LANE_AGE_MINUTES} value={v.laneAge} onChange={(e) => setEdit({ ...v, laneAge: e.target.value })} style={{ width: 80 }} />
          <p className="muted" style={{ fontSize: 14 }}>
            Approved work from background-lane agents lets newer ordinary work merge first for this long; after that it takes its place by when it joined the line (default {d.defaultLaneAgeMinutes ?? 120}). 0 means it always goes after ordinary work.
          </p>
        </div>
      )}
      <CheckWorkers workers={d.workers ?? []} maxSlots={d.maxSlots} reload={view.reload} companyId={companyId} />
      <p className="muted" style={{ fontSize: 14 }}>
        Switching back to legacy cancels checks that are still waiting (their agents are told to run the check themselves); checks already running finish.
      </p>
      <div>
        <SaveButton
          dirty={changed}
          saved={savedQueue}
          busy={act.busy}
          disabled={!valid}
          onClick={() =>
            void act.run(async () => {
              const r = await api<CheckQueueView>("/api/settings/check-queue", { method: "PUT", body: { mode: v.mode, slots: n, train: v.train, ...(d.runnerPolicy ? { runnerPolicy: v.policy } : {}), ...(hasLaneAge ? { laneAgeMinutes: lane } : {}) } });
              setSavedQueue(true);
              setEdit(null);
              view.reload();
              const applied = r.applying ? " The runners are restarted with the new limit as each company goes idle." : "";
              return r.cancelled ? `Saved. ${r.cancelled} waiting check${r.cancelled === 1 ? " was" : "s were"} cancelled.${applied}` : `Saved.${applied}`;
            })
          }
        />
      </div>
      {act.view}
      <WaitForCiSetting />
      <MergeCarrySetting />
    </Section>
  );
}

/** BOS-1070: the owner's switch for the merge gate waiting on GitHub CI. Off by default. */
export function WaitForCiSetting() {
  const view = usePoll((signal) => api<{ on: boolean }>("/api/settings/wait-for-ci", { signal }), 60_000, "wait-for-ci");
  const act = useAction();
  const on = view.data?.on;
  if (on === undefined) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="wait-for-ci">
      <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <input
          type="checkbox"
          checked={on}
          disabled={act.busy}
          onChange={(e) => {
            const next = e.target.checked;
            void act.run(async () => {
              await api("/api/settings/wait-for-ci", { method: "PUT", body: { on: next } });
              view.reload();
              return next ? "Saved. Merges now wait for GitHub CI." : "Saved. Merges no longer wait for GitHub CI.";
            });
          }}
        />
        <span>
          <strong>Wait for GitHub CI before merging</strong> <span className="tag">GitHub only</span>{" "}
          <span className="muted">
            Before each merge Boss Man pushes the exact merged result to a bossman-ci/ branch on GitHub and merges only once GitHub CI passes on it, while its own check runs at the same time. A CI failure goes back to the agent with the failing jobs and tests. Each merge uses GitHub Actions minutes, which a private repo pays for. Projects on other git hosts, or whose CI doesn't run on bossman-ci/ branches, merge on Boss Man's own check as before.
          </span>
        </span>
      </label>
      {act.view}
    </div>
  );
}

/** BOS-1762: land a passed merge when main's newer changes touch none of its files, and the landing turn's cap. Both on by default. */
export function MergeCarrySetting() {
  const view = usePoll((signal) => api<{ on: boolean; turnMinutes: number; refresh?: boolean }>("/api/settings/merge-carry", { signal }), 60_000, "merge-carry");
  const act = useAction();
  const [minutes, setMinutes] = useState<string | null>(null);
  const [savedTurn, setSavedTurn] = useState(false);
  const d = view.data;
  if (!d) return null;
  const shown = minutes ?? String(d.turnMinutes);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="merge-carry">
      <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <input
          type="checkbox"
          checked={d.on}
          disabled={act.busy}
          onChange={(e) => {
            const next = e.target.checked;
            void act.run(async () => {
              await api("/api/settings/merge-carry", { method: "PUT", body: { on: next } });
              view.reload();
              return next ? "Saved. A passed merge now lands when main's newer changes touch none of its files." : "Saved. A merge is tested again whenever main moves.";
            });
          }}
        />
        <span>
          <strong>Land passed merges when main moved elsewhere</strong>{" "}
          <span className="muted">
            When a change has passed its checks but main moved meanwhile, Boss Man lands it anyway if main's newer changes touch none of its files and none of the project's dependency, container or check-script files. A new database migration, CI workflow or build setting on main still means testing again, but only for a change that touches the same kind of file (or the same app's code). Main's own CI checks the result. Off: every main move means testing the change again.
          </span>
        </span>
      </label>
      {d.refresh === undefined ? null : (
        <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <input
            type="checkbox"
            checked={d.refresh}
            disabled={act.busy}
            onChange={(e) => {
              const next = e.target.checked;
              void act.run(async () => {
                await api("/api/settings/merge-carry", { method: "PUT", body: { refresh: next } });
                view.reload();
                return next ? "Saved. A waiting merge is now rebuilt as soon as main moves under it." : "Saved. A waiting merge is now rebuilt only when it comes to land.";
              });
            }}
          />
          <span>
            <strong>Rebuild waiting merges when main moves</strong>{" "}
            <span className="muted">
              When main moves while an approved change waits for its check or for another change's landing turn, Boss Man rebuilds it on the new main straight away instead of when it comes to land. With GitHub CI on, only a change that couldn't land across the move is rebuilt, and its GitHub run starts again. Off: a waiting merge is rebuilt only when it comes to land.
            </span>
          </span>
        </label>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span>
          <strong>Landing turn</strong>{" "}
          <span className="muted">A change rebuilt twice because main moved gets a turn: other changes wait to land for up to this many minutes. 0 turns it off.</span>
        </span>
        <input type="number" min={0} max={240} step={5} value={shown} style={{ width: 80 }} disabled={act.busy} onChange={(e) => setMinutes(e.target.value)} aria-label="Landing turn in minutes" />
        <SaveButton
          dirty={shown !== String(d.turnMinutes)}
          ariaLabel="Save landing turn"
          saved={savedTurn}
          busy={act.busy}
          disabled={!/^\d+$/.test(shown) || Number(shown) > 240}
          onClick={() =>
            void act.run(async () => {
              await api("/api/settings/merge-carry", { method: "PUT", body: { turnMinutes: Number(shown) } });
              setMinutes(null);
              setSavedTurn(true);
              view.reload();
              return Number(shown) === 0 ? "Saved. No landing turns." : `Saved. Landing turns last up to ${shown} minutes.`;
            })
          }
        />
      </label>
      {act.view}
    </div>
  );
}

type MainCiView = { on: boolean; projects: Array<{ projectId: string; project: string; status: { state: string; detail?: string } }> };

/** Settings → Server and runner → Main's CI (BOS-1072): the switch for the watcher that opens a ticket when GitHub CI fails on main, and its plain line per project. */
export function MainCiSetting() {  const view = usePoll((signal) => api<MainCiView>("/api/settings/main-ci", { signal }), 60_000, "main-ci");
  const act = useAction();
  const d = view.data;
  if (!d) {
    return (
      <Section id="main-ci-h" title="Main's CI">
        {view.error ? <LoadError what="the Main's CI setting" message={view.error.message} onRetry={view.reload} /> : <Loader label="Loading the Main's CI setting" />}
      </Section>
    );
  }
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
  const [savedEmail, setSavedEmail] = useState(false);
  const d = view.data;
  if (!d) {
    return (
      <Section id="email-h" title="Outgoing email">
        {view.error ? <LoadError what="the email setting" message={view.error.message} onRetry={view.reload} /> : <Loader label="Loading the email setting" />}
      </Section>
    );
  }
  const s = d.settings;
  const base = { host: s?.host ?? "", port: String(s?.port ?? 587), security: s?.security ?? "starttls", username: s?.username ?? "", fromAddress: s?.fromAddress ?? "", fromName: s?.fromName ?? "", password: "" };
  const v = edit ?? base;
  const dirty = (Object.keys(base) as (keyof typeof base)[]).some((k) => v[k] !== base[k]);
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
        <SaveButton
          dirty={dirty}
          saved={savedEmail}
          busy={act.busy}
          disabled={!valid}
          onClick={() =>
            void act.run(async () => {
              await api("/api/settings/email", { method: "PUT", body: { host: v.host, port, security: v.security, username: v.username.trim() || null, fromAddress: v.fromAddress, fromName: v.fromName.trim() || null, ...(v.password ? { password: v.password } : {}) } });
              setEdit(null);
              setSavedEmail(true);
              view.reload();
              return "Saved.";
            })
          }
        />
        {d.configured && (
          <button
            type="button"
            className="btn"
            disabled={act.busy}
            onClick={() => {
              if (!window.confirm("Turn off outgoing email? The mail server details and password are deleted, and you would need to enter them again.")) return;
              void act.run(async () => {
                await api("/api/settings/email", { method: "DELETE" });
                setEdit(null);
                view.reload();
                return "Outgoing email is off and the password is removed.";
              });
            }}
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

