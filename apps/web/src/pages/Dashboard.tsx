// The home screen (R74): what the company's agents are doing, the headline numbers, the last
// 14 days at a glance, and what happened recently.
import { setCompanyPause } from "./settings/Team";
import { api, type Company, type Decision, type DecisionTally, type RunRow } from "../api";
import { NoCompany } from "../components/NoCompany";
import { raisedAgo } from "../age";
import { usePoll } from "../hooks";
import { away } from "../server-watch";
import { Avatar } from "../components/Avatar";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { WorkStands } from "../components/WorkStands";
import { NeedsYou, RightNow, healthLines, type HealthData } from "../components/DashboardPanels";
import { MergesStuckBanner, brakeOffSummary, pausedSummary, slowSummary, stuckSummary, type MergeHealthView } from "../components/MergesStuckBanner";
import { RunLabelLink } from "./Runs";

type Result = "running" | "succeeded" | "failed" | "other";
type AgentCard = {
  id: string;
  name: string;
  role: "ceo" | "manager" | "worker";
  paused: boolean;
  duty: string | null;
  run: (RunRow & { result: Result }) | null;
};
type Day = { day: string } & Record<string, number | string>;
type DashboardData = {
  agents: AgentCard[];
  stats: { agents: number; running: number; paused: number; inProgress: number; inReview: number; /** inReview split (BOS-667); missing from an older server. */ awaitingReview?: number; approvedToMerge?: number; /** BOS-1909: in progress without the work that can't move, and the groups that move by themselves; missing from an older server. */ inProgressCounted?: number; nextUp?: number; beingChecked?: number; watching?: number; open: number; blocked: number; /** Merged work in Blocked that only waits for its live check, not counted in blocked (BOS-1636); missing from an older server. */ waitingLiveCheck?: number; decisionsWaiting: number; monthCostMicros: number; monthSubscriptionTokens: { input: number; output: number }; monthSubscriptionRuns: number; monthSubscriptionUnrecorded: number };
  runsByDay: Day[];
  ticketsByDay: Day[];
  recentTickets: Array<{ id: string; title: string; state: string; outcome: string | null; assignee: string | null; lastActivityAt: string }>;
  /** The "Right now" lines the server reads (BOS-1507); absent on an older server, so those lines say "not known". */
  health?: HealthData;
};

/** "just now", "5 min ago", "3h ago", "2d ago": age.ts's words, so every page agrees. */
export function ago(iso: string, now = Date.now()) {
  return raisedAgo(iso, now);
}

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const RESULT: Record<Result, { icon: string; label: string; tone: string }> = {
  running: { icon: "●", label: "Running", tone: "blue" },
  succeeded: { icon: "✓", label: "Finished", tone: "green" },
  failed: { icon: "⊖", label: "Failed", tone: "red" },
  other: { icon: "◻", label: "Stopped", tone: "" },
};
const STATE_TONE: Record<string, string> = { backlog: "grey", ready: "amber", in_progress: "blue", blocked: "red", review: "purple", done: "green" };

/** Words in the middle of a chart with nothing to draw, so it isn't just bare axes (BOS-1125). */
function NoData({ children }: { children: string }) {
  return <span className="chart-empty muted">{children}</span>;
}

function Chart({ title, days, series, emptyText }: { title: string; days: Day[]; series: Array<{ key: string; label: string; tone: string }>; emptyText: string }) {
  const totals = days.map((d) => series.reduce((n, s) => n + Number(d[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const label = (d: string) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
  return (
    <figure className="card chart">
      <figcaption>
        <strong>{title}</strong>
        <small className="muted">Last 14 days</small>
      </figcaption>
      <div className="dbars" role="img" aria-label={`${title}: ${totals.reduce((a, b) => a + b, 0)} in the last 14 days`}>
        {days.map((d, i) => (
          <div key={d.day} className="dbar" title={`${label(String(d.day))}: ${series.map((s) => `${s.label} ${d[s.key] ?? 0}`).join(", ")}`}>
            {series.map((s) => {
              const v = Number(d[s.key] ?? 0);
              return v ? <span key={s.key} className={`seg ${s.tone}`} style={{ height: `${(v / max) * 100}%` }} /> : null;
            })}
            {totals[i] === 0 && <span className="seg empty" />}
          </div>
        ))}
        {totals.every((n) => n === 0) && <NoData>{emptyText}</NoData>}
      </div>
      <div className="axis">
        <span>{label(String(days[0]?.day ?? ""))}</span>
        <span>{label(String(days[Math.floor(days.length / 2)]?.day ?? ""))}</span>
        <span>{label(String(days.at(-1)?.day ?? ""))}</span>
      </div>
      <ul className="legend">
        {series.map((s) => (
          <li key={s.key}>
            <span className={`swatch ${s.tone}`} aria-hidden="true" /> {s.label}
          </li>
        ))}
      </ul>
    </figure>
  );
}

function SuccessChart({ days }: { days: Day[] }) {
  const rates = days.map((d) => {
    const all = Number(d.succeeded ?? 0) + Number(d.failed ?? 0) + Number(d.other ?? 0);
    return { day: d.day, rate: all ? Number(d.succeeded ?? 0) / all : null };
  });
  const label = (d: string) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
  return (
    <figure className="card chart">
      <figcaption>
        <strong>Success rate</strong>
        <small className="muted">Runs that finished their turn, last 14 days</small>
      </figcaption>
      <div className="dbars" role="img" aria-label="Success rate by day">
        {rates.map((r) => (
          <div key={String(r.day)} className="dbar" title={`${label(String(r.day))}: ${r.rate === null ? "no runs" : `${Math.round(r.rate * 100)}%`}`}>
            {r.rate === null ? <span className="seg empty" /> : <span className={`seg ${r.rate >= 0.8 ? "green" : r.rate >= 0.5 ? "amber" : "red"}`} style={{ height: `${Math.max(4, r.rate * 100)}%` }} />}
          </div>
        ))}
        {rates.every((r) => r.rate === null) && <NoData>No runs in the last 14 days</NoData>}
      </div>
      <div className="axis">
        <span>{label(String(rates[0]?.day ?? ""))}</span>
        <span>{label(String(rates[Math.floor(rates.length / 2)]?.day ?? ""))}</span>
        <span>{label(String(rates.at(-1)?.day ?? ""))}</span>
      </div>
    </figure>
  );
}

export function Dashboard({ company, decisions = null, tally = null, onChanged }: { company: Company | undefined; /** Reloads the company list after a Resume. */ onChanged?: () => void; /** The owner's open items for this company (null until loaded). */ decisions?: Decision[] | null; tally?: DecisionTally | null }) {
  const data = usePoll((signal) => (company ? api<DashboardData>(`/api/companies/${company.id}/dashboard`, { signal }) : Promise.resolve(null)), 10_000, company?.id ?? "none");
  // The Merges line and the banner share one read of the Merge queue; a failed read leaves the line "couldn't check".
  const merges = usePoll((signal) => (company ? api<MergeHealthView>(`/api/companies/${company.id}/merge-queue`, { signal }).catch(() => null) : Promise.resolve(null)), 20_000, `dash-merges-${company?.id ?? "none"}`);
  if (!company) return <NoCompany />;
  if (data.error && !away(data.error)) return <LoadError what="the dashboard" message={data.error.message} onRetry={data.reload} />;
  const d = data.data;
  if (!d) return <Loader label="Loading the dashboard" />;
  const s = d.stats;
  const tokens = s.monthSubscriptionTokens.input + s.monthSubscriptionTokens.output;
  // While the company is paused nothing moves, so a stuck-merges banner would only be noise.
  const stuck = merges.data && !company.paused ? stuckSummary(merges.data) : null;
  const slow = merges.data && !company.paused ? slowSummary(merges.data) : null;
  const paused = merges.data && !company.paused ? pausedSummary(merges.data) : null;
  const lines = healthLines({ health: d.health ?? {}, merges: merges.data, stuck, slow, running: s.running, companyId: company.id });
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company.name}</p>
          <h1>Dashboard</h1>
        </div>
      </header>

      <MergesStuckBanner stuck={stuck} slow={slow} paused={paused} brakeOff={merges.data && !company.paused ? brakeOffSummary(merges.data) : null} companyId={company.id} />


      {s.inProgressCounted != null && <WorkStands counts={{ inProgress: s.inProgressCounted, nextUp: s.nextUp ?? 0, beingChecked: s.beingChecked ?? 0, watching: s.watching ?? 0 }} hrefFor="#/board" />}

      <div className="dash-lead">
        <RightNow lines={lines} paused={company.paused} companyId={company.id} onResume={onChanged ? async () => { await setCompanyPause(company.id, false); onChanged(); } : undefined} />
        <NeedsYou decisions={decisions} tally={tally} />
      </div>

      <section aria-labelledby="dash-agents">
        <h2 id="dash-agents" className="section-label">
          Agents
        </h2>
        <ul className="dash-agents">
          {d.agents.map((a) => {
            const r = a.run;
            const res = a.paused ? null : r ? RESULT[r.result] : null;
            return (
              <li key={a.id} className={`card dash-agent${r?.result === "running" ? " live" : ""}`}>
                <p className="who">
                  <Avatar agent={company.agents.find((x) => x.id === a.id) ?? a} className={a.role} />
                  <a href={`#/chat/${company.id}/${a.id}`}>{a.name}</a>
                </p>
                <p className="what">
                  {a.paused ? (
                    <span className="muted">Paused{a.duty === "wiki" ? ": start it in Settings to keep the wiki tidy" : ""}</span>
                  ) : r ? (
                    <>
                      <span className={`rstate ${res!.tone}`} aria-label={res!.label}>
                        {res!.icon}
                      </span>
                      {r.ticketId ? <a href={`#/tickets/${r.ticketId}`}>{r.ticket}</a> : <RunLabelLink run={r} />}
                    </>
                  ) : (
                    <span className="muted">Hasn't run yet</span>
                  )}
                </p>
                {r && !a.paused && <p className="muted when">{r.endedAt ? `Finished ${ago(r.endedAt)}` : `Started ${ago(r.startedAt)}`}</p>}
              </li>
            );
          })}
        </ul>
        <p style={{ textAlign: "right" }}>
          <a href="#/runs">View all runs</a>
        </p>
      </section>

      <section className="dash-stats" aria-label="Headline numbers">
        <a className="card stat" href="#/settings">
          <strong>{s.agents}</strong>
          <span>Agents</span>
          <small className="muted">
            {s.running} running, {s.paused} paused
          </small>
        </a>
        <a className="card stat" href="#/board">
          <strong>{s.inProgressCounted ?? s.inProgress}</strong>
          <span>Tasks in progress</span>
          {s.inProgressCounted != null && (
            <small className="muted" data-testid="dash-uncounted">
              {[s.nextUp ? `${s.nextUp} next up` : "", s.beingChecked ? `${s.beingChecked} being checked` : "", s.watching ? `${s.watching} merged, watching` : ""].filter(Boolean).join(" · ") || "Nothing else is waiting"}
              {" · none counted"}
            </small>
          )}
          <small className="muted">
            {s.awaitingReview != null && s.approvedToMerge != null ? `${s.awaitingReview} awaiting review, ${s.approvedToMerge} approved, waiting to merge` : `${s.inReview} in review`}, {s.open} open, {s.blocked} blocked{s.waitingLiveCheck ? `, ${s.waitingLiveCheck} merged, waiting for a live check` : ""}
          </small>
        </a>
        {/* The API-money card opens the Spend page (BOS-2194); the subscription-tokens card still opens Funding. */}
        <a className="card stat" href={s.monthSubscriptionRuns > 0 ? "#/funding" : `#/spend/${company.id}`}>
          {/* Subscription use is tokens, not money (R67); money is only what API use cost. */}
          {s.monthSubscriptionRuns > 0 ? (
            <>
              <strong>{tokens > 0 ? compact(tokens) : "–"}</strong>
              <span>Subscription tokens this month</span>
              <small className="muted">
                {[
                  tokens > 0 ? `${compact(s.monthSubscriptionTokens.input)} in, ${compact(s.monthSubscriptionTokens.output)} out` : null,
                  s.monthSubscriptionUnrecorded > 0 ? `${s.monthSubscriptionUnrecorded} earlier run${s.monthSubscriptionUnrecorded === 1 ? "" : "s"} not counted` : null,
                  s.monthCostMicros > 0 ? `plus $${(s.monthCostMicros / 1_000_000).toFixed(2)} on API` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </>
          ) : (
            <>
              <strong>${(s.monthCostMicros / 1_000_000).toFixed(2)}</strong>
              <span>API spend this month</span>
              <small className="muted">API credit and pay-as-you-go · where it went</small>
            </>
          )}
        </a>
      </section>

      <section className="dash-charts" aria-label="Last 14 days">
        <Chart
          title="Run activity"
          emptyText="No runs in the last 14 days"
          days={d.runsByDay}
          series={[
            { key: "succeeded", label: "Finished", tone: "green" },
            { key: "failed", label: "Failed", tone: "red" },
            { key: "other", label: "Stopped", tone: "grey" },
          ]}
        />
        <Chart
          title="New tasks by status"
          emptyText="No new tasks in the last 14 days"
          days={d.ticketsByDay}
          series={[
            { key: "backlog", label: "Backlog", tone: "grey" },
            { key: "ready", label: "Ready", tone: "amber" },
            { key: "in_progress", label: "In progress", tone: "blue" },
            { key: "review", label: "Review", tone: "purple" },
            { key: "blocked", label: "Blocked", tone: "red" },
            { key: "done", label: "Done", tone: "green" },
          ]}
        />
        <SuccessChart days={d.runsByDay} />
      </section>

      <div className="dash-lists">
        <section aria-labelledby="dash-tickets">
          <h2 id="dash-tickets" className="section-label">
            Recent tasks
          </h2>
          <ul className="card dash-list">
            {d.recentTickets.length === 0 && <li className="muted">No tasks yet.</li>}
            {d.recentTickets.map((t) => (
              <li key={t.id}>
                <span className={`tag ${STATE_TONE[t.state] ?? ""}`}>{t.state === "done" && t.outcome === "cancelled" ? "Cancelled" : t.state.charAt(0).toUpperCase() + t.state.slice(1).replace(/_/g, " ")}</span>
                <a href={`#/tickets/${t.id}`}>{t.title}</a>
                <span className="muted">{t.assignee ?? "Unassigned"}</span>
                <time className="muted">{ago(t.lastActivityAt)}</time>
              </li>
            ))}
          </ul>
          <p className="muted">What happened recently is in <a href="#/notifications">Notifications</a>.</p>
        </section>
      </div>
    </>
  );
}
