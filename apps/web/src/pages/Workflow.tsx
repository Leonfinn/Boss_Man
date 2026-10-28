import { useState } from "react";
import { api, type Company } from "../api";
import { usePoll } from "../hooks";

type Stats = { done: number; firstPassRate: number | null; meanRework: number | null; medianCycleMs: number | null; costPerDoneMicros: number | null; ownCostPerDoneMicros: number | null; watchdogFlags: number; overrideShare: number | null; answered: number };
type Role = Stats & { role: string; agents: number };
type AgentRow = Stats & { agentId: string; name: string; title: string | null; role: string };
type Handoff = { from: string; to: string; kind: "assign" | "review"; count: number; medianWaitMs: number | null; bounceRate: number | null };
type Task = { id: string; ref: string | null; title: string; state: string; assignee: string | null; ageMs: number };
type Feature = {
  id: string;
  title: string;
  status: string;
  tasksDone: number;
  tasksTotal: number;
  tail: Task[];
  tailFlag: boolean;
  tailLagMs: number | null;
  criticalPath: { chain: { id: string; ref: string | null; title: string; state: string }[]; p50Ms: number | null; p85Ms: number | null; ageing: { id: string; ref: string | null; title: string; reasons: string[] }[] } | null;
};
type Finding = { failure: string; failureLabel: string; handoff?: { from: string; to: string }; tickets: string[]; count: number; note: string };
type RetroInfo = { retro: { id: string; startedAt: string; since: string; until: string; doneCount: number; savedAt: string | null; agentName: string | null; findings: Finding[] } | null; changes: ChangeRow[] };
type ChangeRow = { id: string; lever: string; summary: string; approver: "ceo" | "owner"; status: "proposed" | "applied" | "skipped" | "kept" | "reverted"; metricLabel: string; baselineText: string; afterText: string | null; target: string | null; appliedAt: string | null; evidence: string[] };
type SizeRow = { role: string; size: number; done: number; p50CycleMs: number | null; p85CycleMs: number | null; meanCostMicros: number | null; meanRework: number | null };
type SizeNote = { role: string; size: number; likeSize: number };
type Scorecard = { days: number; costBasis: "estimate" | "billed" | "mixed" | null; byRole: Role[]; byAgent: AgentRow[]; handoffs: Handoff[]; features: Feature[]; sizes: SizeRow[]; sizeNotes: SizeNote[] };

/** "45m", "3.5h", "2d"; a dash for no number. */
export function span(ms: number | null) {
  if (ms === null) return "–";
  const m = ms / 60_000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${Math.round(h / 24)}d`;
}
const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const dollars = (micros: number | null) => (micros === null ? "–" : `$${(micros / 1_000_000).toFixed(2)}`);
const LEVER: Record<string, string> = { playbook: "Playbook", lesson: "Brief lesson", instructions: "Instructions", review_policy: "Review policy", watchdog: "Watchdog", model: "Model", thinking: "Thinking level" };
const STATUS: Record<ChangeRow["status"], string> = { proposed: "Waiting for an answer", applied: "Applied", skipped: "Skipped", kept: "Kept", reverted: "Reverted" };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const label = (s: string) => s.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

function Ticket({ t }: { t: { id: string; ref: string | null; title: string } }) {
  return (
    <a href={`#/tickets/${t.id}`} title={t.title}>
      {t.ref ?? t.title}
    </a>
  );
}

function StatsCells({ s }: { s: Stats }) {
  return (
    <>
      <td>{s.done}</td>
      <td>{pct(s.firstPassRate)}</td>
      <td>{s.meanRework === null ? "–" : s.meanRework.toFixed(1)}</td>
      <td>{span(s.medianCycleMs)}</td>
      <td>{dollars(s.ownCostPerDoneMicros)}</td>
      <td>{dollars(s.costPerDoneMicros)}</td>
      <td>{s.watchdogFlags}</td>
      <td>{pct(s.overrideShare)}</td>
    </>
  );
}

const HEAD = ["Done", "Right first time", "Rework rounds", "Time to finish", "Own cost", "Ticket cost", "Watchdog flags", "Answers changed"];

/** The latest retro's findings, ranked, and every change it led to. */
function Retro({ companyId }: { companyId: string }) {
  const { data, error } = usePoll((signal) => api<RetroInfo>(`/api/companies/${companyId}/retros/latest`, { signal }), 60_000, `retro-${companyId}`);
  if (error || !data) return null;
  const r = data.retro;
  return (
    <>
      <section>
        <h2>Latest retro</h2>
        {!r ? (
          <p className="muted">No retro has run yet. One runs every 20 finished tickets, or after 7 days if anything was finished. You can run one from Settings.</p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 14 }}>
              {day(r.since)} to {day(r.until)}, over {r.doneCount} finished tickets{r.agentName ? `, run by ${r.agentName}` : ""}. Most frequent first.
            </p>
            {!r.savedAt ? (
              <p className="muted">Waiting for the findings.</p>
            ) : r.findings.length ? (
              <ol>
                {r.findings.map((f, i) => (
                  <li key={i}>
                    <strong>{f.failureLabel}</strong> <small className="muted">{f.count} {f.count === 1 ? "ticket" : "tickets"}{f.handoff ? ` · ${label(f.handoff.from)} to ${label(f.handoff.to)}` : ""} · {f.tickets.join(", ")}</small>
                    <br />
                    {f.note}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">It found nothing to report.</p>
            )}
          </>
        )}
      </section>
      <section>
        <h2>Changes</h2>
        <p className="muted" style={{ fontSize: 14 }}>
          Changes a retro suggested. Nothing changes until it is approved: the CEO approves playbooks and lessons, and you approve the rest. Once a change has had time to work, you or the CEO get a Keep or Revert question. "Was" is where the measure stood when it was suggested; "now" is what the check found.
        </p>
        {data.changes.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Kind</th>
                  <th>Approves</th>
                  <th>Status</th>
                  <th>Measure</th>
                </tr>
              </thead>
              <tbody>
                {data.changes.map((c) => (
                  <tr key={c.id}>
                    <td title={c.evidence.join(", ")}>{c.summary}</td>
                    <td>{LEVER[c.lever] ?? label(c.lever)}</td>
                    <td>{c.approver === "ceo" ? "CEO" : "You"}</td>
                    <td>{STATUS[c.status]}{c.appliedAt ? ` ${day(c.appliedAt)}` : ""}</td>
                    <td>
                      {c.metricLabel} <small className="muted">was {c.baselineText}{c.afterText !== null ? `, now ${c.afterText}` : ""}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">None yet.</p>
        )}
      </section>
    </>
  );
}

/** How work moves between roles, and which features wait on their last tasks. */
export function Workflow({ company }: { company: Company | undefined }) {
  const [days, setDays] = useState(14);
  const [showAgents, setShowAgents] = useState(false);
  const data = usePoll((signal) => (company ? api<Scorecard>(`/api/companies/${company.id}/workflow?days=${days}`, { signal }) : Promise.resolve(null)), 60_000, `workflow-${company?.id}-${days}`);
  if (!company) return <p className="muted">Pick a company first.</p>;
  const d = data.data;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company.name}</p>
          <h1>Workflow</h1>
          <p className="sub">How work moves through the team, and where it waits. Times only count tickets that moved after this page was released.</p>
        </div>
        <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 90].map((n) => (
            <option key={n} value={n}>
              Last {n} days
            </option>
          ))}
        </select>
      </header>
      {data.error ? (
        <p role="alert" className="error">{data.error.message}</p>
      ) : !d ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <section>
            <h2>Roles</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              <strong>Done</strong> is tickets finished in this period. <strong>Right first time</strong> is the share of reviewed tickets that were never sent back. <strong>Rework rounds</strong> is how many times a ticket was sent back, on average. <strong>Time to finish</strong> is the middle time from first starting a ticket to finishing it. <strong>Own cost</strong> is what this role's own runs on those tickets cost, per ticket. <strong>Ticket cost</strong> is every run on them, per ticket: reviews, the CEO and rework included, so a ticket sent back often costs more. {d.costBasis === "billed" ? "Costs are what the provider billed." : "Costs are estimates at list price from the tokens used, not what a subscription actually charges you."} <strong>Watchdog flags</strong> counts tickets the watchdog raised. <strong>Answers changed</strong> is how often the answer to a decision this role raised was not the one it recommended.
            </p>
            {d.byRole.length ? (
              <>
                <label className="muted" style={{ fontSize: 14 }}>
                  <input type="checkbox" checked={showAgents} onChange={(e) => setShowAgents(e.target.checked)} /> Show each agent
                </label>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{showAgents ? "Agent" : "Role"}</th>
                        {HEAD.map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {showAgents
                        ? d.byAgent.map((a) => (
                            <tr key={a.agentId}>
                              <td>
                                {a.name} <small className="muted">{a.title ?? label(a.role)}</small>
                              </td>
                              <StatsCells s={a} />
                            </tr>
                          ))
                        : d.byRole.map((r) => (
                            <tr key={r.role}>
                              <td>
                                {label(r.role)} <small className="muted">{r.agents} {r.agents === 1 ? "agent" : "agents"}</small>
                              </td>
                              <StatsCells s={r} />
                            </tr>
                          ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="muted">Not enough finished tickets yet.</p>
            )}
          </section>

          <section>
            <h2>Handoffs</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              Where work passes from one role to another. <strong>Wait</strong> is the middle time before the next role picked it up (an assignment) or gave its verdict (a review). <strong>Sent back</strong> is the share of reviews that asked for changes. Assignments by the owner or Boss Man show as "owner".
            </p>
            {d.handoffs.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>To</th>
                      <th>Kind</th>
                      <th>Count</th>
                      <th>Wait</th>
                      <th>Sent back</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.handoffs.map((h) => (
                      <tr key={`${h.kind}|${h.from}|${h.to}`}>
                        <td>{label(h.from)}</td>
                        <td>{label(h.to)}</td>
                        <td>{h.kind === "assign" ? "Assigned" : "Reviewed"}</td>
                        <td>{h.count}</td>
                        <td>{span(h.medianWaitMs)}</td>
                        <td>{pct(h.bounceRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No handoffs in this period.</p>
            )}
          </section>

          <section>
            <h2>Features</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              The <strong>tail</strong> is the tasks still open once three quarters of a feature is done. It is flagged when one has been open for more than twice the usual time to finish. The <strong>critical path</strong> is the longest chain of tasks that wait on each other, with a likely time range (typical to slow) from past tickets. A task on it is flagged when nobody has it, it is blocked, or it is older than a slow ticket for its role. After release, <strong>tail lag</strong> is how long the last quarter of tasks took.
            </p>
            {d.features.length ? (
              d.features.map((f) => (
                <article key={f.id} className="card" style={{ marginBottom: 12 }}>
                  <h3 style={{ margin: 0 }}>
                    <a href={`#/features/${company.id}/${f.id}`}>{f.title}</a> <span className="tag">{label(f.status)}</span> {f.tailFlag && <span className="tag amber">Tail is slow</span>}
                  </h3>
                  <p className="muted" style={{ fontSize: 14, margin: "4px 0" }}>
                    {f.tasksDone} of {f.tasksTotal} tasks done{f.tailLagMs !== null && f.status === "released" ? `. Tail lag ${span(f.tailLagMs)}.` : ""}
                  </p>
                  {f.tail.length > 0 && (
                    <>
                      <strong style={{ fontSize: 14 }}>Tail</strong>
                      <ul>
                        {f.tail.map((t) => (
                          <li key={t.id}>
                            <Ticket t={t} /> {t.title} <small className="muted">{label(t.state)} · {t.assignee ?? "nobody"} · open {span(t.ageMs)}</small>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {f.criticalPath && (
                    <>
                      <strong style={{ fontSize: 14 }}>Critical path</strong>
                      <p style={{ margin: "4px 0" }}>
                        {f.criticalPath.chain.map((c, i) => (
                          <span key={c.id}>
                            {i > 0 && " → "}
                            <Ticket t={c} />
                          </span>
                        ))}{" "}
                        <small className="muted">{f.criticalPath.p50Ms === null ? "Not enough finished tickets yet for a time range." : `Likely ${span(f.criticalPath.p50Ms)} to ${span(f.criticalPath.p85Ms)}.`}</small>
                      </p>
                      {f.criticalPath.ageing.length > 0 && (
                        <ul>
                          {f.criticalPath.ageing.map((a) => (
                            <li key={a.id}>
                              <Ticket t={a} /> <span className="tag amber">{a.reasons.join(", ")}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </article>
              ))
            ) : (
              <p className="muted">No features in progress.</p>
            )}
          </section>

          <section>
            <h2>Sizes</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              Each task has a size (1, 2, 3, 5 or 8) set by whoever made it. This shows what finished tasks of each size really took over the last 90 days, whatever period is chosen above. The critical path uses these times once a role and size has 10 finished tasks.
            </p>
            {d.sizeNotes.map((n) => (
              <p key={`${n.role}|${n.size}`} style={{ fontSize: 14, margin: "4px 0" }}>
                <span className="tag amber">{label(n.role)}</span> Size {n.size} tasks take about as long as size {n.likeSize}. They may be sized too low.
              </p>
            ))}
            {d.sizes.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Size</th>
                      <th>Done</th>
                      <th>Typical time</th>
                      <th>Slow time</th>
                      <th>Cost</th>
                      <th>Sent back</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.sizes.map((r) => (
                      <tr key={`${r.role}|${r.size}`}>
                        <td>{label(r.role)}</td>
                        <td>{r.size}</td>
                        <td>{r.done}</td>
                        <td>{span(r.p50CycleMs)}</td>
                        <td>{span(r.p85CycleMs)}</td>
                        <td>{dollars(r.meanCostMicros)}</td>
                        <td>{r.meanRework === null ? "–" : r.meanRework.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No finished task has a size yet.</p>
            )}
          </section>

          <Retro companyId={company.id} />
        </>
      )}
    </>
  );
}
