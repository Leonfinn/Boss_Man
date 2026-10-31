import { useState } from "react";
import { api, usd, type ActiveRun, type BudgetRow, type Company, type FundingSource, type FundingStatus } from "../api";
import { art } from "../brand";
import { State } from "../components/State";
import { usePoll } from "../hooks";
import { windowLabel } from "@boss-man/shared";

const pct = (f: number) => `${Math.round(f * 100)}%`;
/** "Thu 29 Oct at 14:04": day, date and time in the same style as the reset line. */
const dayAndTime = (iso: string) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${day} at ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** The limit estimate under a quota bar (R78): how fast it's going, and whether it lasts until the reset. */
function Forecast({ f }: { f: FundingStatus["forecasts"][string] | undefined }) {
  if (!f || f.perHour === null) return null;
  const rate = `about ${pct(f.perHour)} an hour`;
  const [warn, text] = f.perHour <= 0 || !f.runsOutAt ? [false, "Not rising at the moment"] : f.beforeReset ? [true, `Runs out about ${dayAndTime(f.runsOutAt)} at the recent rate (${rate})`] : [false, `Won't run out before it resets, at the recent rate (${rate})`];
  return (
    <span className={warn ? undefined : "muted"} style={{ fontSize: 12, color: warn ? "var(--amber-ink)" : undefined }}>
      {text}
    </span>
  );
}

/** Use per day over the last week (R78): tokens on a subscription, money otherwise. */
function Daily({ s }: { s: FundingStatus }) {
  if (!s.daily.some((d) => d.runs > 0 || d.costMicros > 0)) return null;
  const sub = s.source.kind === "subscription";
  const value = (d: FundingStatus["daily"][number]) => (sub ? d.inputTokens + d.outputTokens : d.costMicros);
  const top = Math.max(1, ...s.daily.map(value));
  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      <figcaption className="muted" style={{ fontSize: 12 }}>
        Last 7 days, {sub ? "tokens" : "spend"} per day
      </figcaption>
      <ul className="day-bars">
        {s.daily.map((d) => {
          const amount = `${sub ? `${compact(value(d))} tokens` : usd(d.costMicros)}, ${d.runs} run${d.runs === 1 ? "" : "s"}`;
          return (
            <li key={d.day} className="day-bar" title={`${d.day}: ${amount}`}>
              <span className="sr-only">
                {d.day}: {amount}
              </span>
              <span className="fill" aria-hidden="true" style={{ height: `${Math.round((value(d) / top) * 100)}%` }} />
              <span className="lbl" aria-hidden="true">
                {new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short" })}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** Who used this source in the last 7 days: money for paid sources, tokens for a subscription. */
function ByCompany({ s }: { s: FundingStatus }) {
  const rows = s.byCompany ?? [];
  if (!rows.length) return null;
  const sub = s.source.kind === "subscription";
  return (
    <div>
      <span className="muted" style={{ fontSize: 13 }}>
        Last 7 days, by company
      </span>
      <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
        {rows.map((r) => (
          <li key={r.companyId} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{r.name}</span>
            <span className="mono">
              {sub ? `${compact(r.tokens)} tokens` : usd(r.costMicros)} · {r.runs} run{r.runs === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "3m ago", "2h ago", "4d ago": how old a cached reading is, in plain words. */
const ago = (seconds: number | null) => {
  if (seconds === null) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};

/** "in 3 days", "in 5 hours": how long until the plan renews. */
const until = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)} hours`;
  return `in ${Math.round(ms / 86_400_000)} days`;
};

/** The readings inside this period (the same renewal), oldest first: used counts over time. */
function Trend({ q }: { q: NonNullable<FundingStatus["providerQuota"]> }) {
  const rows = q.history.filter((h) => (h.renewsAt ?? "") === (q.renewsAt ?? "")).slice().reverse();
  if (rows.length < 2) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const step = last.used - first.used;
  return (
    <span className="muted" style={{ fontSize: 12 }}>
      This period: {rows.length} readings, {first.used.toLocaleString()} → {last.used.toLocaleString()} ({step >= 0 ? "+" : ""}
      {step.toLocaleString()} since {ago(Math.round((Date.now() - new Date(first.takenAt).getTime()) / 1000))})
    </span>
  );
}

/** The hold controls for a subscription: threshold, extra usage and which windows count (BOS-227). */
function QuotaSettings({ s }: { s: FundingStatus }) {
  const [holdAt, setHoldAt] = useState(Math.round((s.source.quotaHoldAt ?? 0.95) * 100));
  const [overage, setOverage] = useState<"pause" | "urgent" | "all">(s.source.quotaOverage ?? "pause");
  const [off, setOff] = useState<string[]>(s.source.quotaDisabledWindows ?? []);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const windows = s.windowsSeen ?? s.quota.map((q) => q.window);
  const save = async () => {
    setError(null);
    try {
      await api(`/api/funding-sources/${s.source.id}`, { method: "PATCH", body: { quotaHoldAt: holdAt / 100, quotaOverage: overage, quotaDisabledWindows: off } });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const toggle = (w: string, on: boolean) => setOff((cur) => (on ? cur.filter((x) => x !== w) : [...cur, w]));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
      <span style={{ fontWeight: 600, fontSize: 13 }}>When the subscription is nearly used up</span>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <span style={{ flex: 1 }}>Hold routine work at</span>
        <input aria-label="Hold routine work at this percentage" type="number" min={80} max={100} value={holdAt} onChange={(e) => setHoldAt(Math.max(80, Math.min(100, Number(e.target.value) || 95)))} style={{ width: 70 }} />
        <span>%</span>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <span style={{ flex: 1 }}>I have extra usage</span>
        <select aria-label="Extra usage" value={overage} onChange={(e) => setOverage(e.target.value as "pause" | "urgent" | "all")}>
          <option value="pause">Hold everything at the limit (urgent tickets run until then)</option>
          <option value="urgent">Keep urgent work running past the limit</option>
          <option value="all">Keep all work running</option>
        </select>
      </label>
      {overage !== "pause" && (
        <span className="muted" style={{ fontSize: 12 }}>
          Extra usage is billed by Anthropic. Boss Man can't see the balance, so set a spending limit in your Claude account.
        </span>
      )}
      {windows.length > 0 && (
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <legend className="muted" style={{ fontSize: 12 }}>
            Which limits can trigger the hold
          </legend>
          {windows.map((w) => {
            const latest = s.quota.find((q) => q.window === w);
            return (
              <label key={w} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={!off.includes(w)} onChange={(e) => toggle(w, e.target.checked)} />
                <span style={{ flex: 1 }}>
                  Can trigger the hold: {windowLabel(w).name} <span className="mono">({w})</span>
                </span>
                {latest && <span className="mono muted">{pct(latest.utilization)}</span>}
              </label>
            );
          })}
          <span className="muted" style={{ fontSize: 12 }}>
            These names come from Claude Code and aren't documented, so Boss Man doesn't guess what each one means.
          </span>
        </fieldset>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" className="btn" onClick={() => void save()}>
          Save
        </button>
        {saved && <span className="muted" style={{ fontSize: 12 }}>Saved.</span>}
        {error && <span className="error" style={{ fontSize: 12 }}>{error}</span>}
      </div>
    </div>
  );
}

/** Synthetic's own used/limit reading; an unreadable one is unknown, never an error. */
function ProviderQuotaBlock({ q }: { q: NonNullable<FundingStatus["providerQuota"]> }) {
  if (q.used === null || q.limit === null)
    return <span className="muted">Quota unknown: Synthetic's quota service couldn't be reached and there's no earlier reading yet.</span>;
  const fraction = q.limit > 0 ? q.used / q.limit : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span>Requests this period</span>
        <span className="mono" style={{ color: fraction >= 0.8 ? "var(--amber-ink)" : undefined }}>
          {q.used.toLocaleString()} of {q.limit.toLocaleString()} · {pct(fraction)}
        </span>
      </div>
      <div className={`bar${fraction >= 0.8 ? " warn" : ""}`} aria-hidden="true">
        <span style={{ width: pct(Math.min(1, fraction)) }} />
      </div>
      {q.renewsAt && (
        <span className="muted" style={{ fontSize: 12 }}>
          Renews {when(q.renewsAt)} ({until(q.renewsAt)})
        </span>
      )}
      <Trend q={q} />
      <span className="muted" style={{ fontSize: 12 }}>
        Checked {ago(q.ageSeconds)}{q.warned.length ? ` · you've been warned at ${q.warned.join("% and ")}%` : ""}
      </span>
    </div>
  );
}

function SourceCard({ s }: { s: FundingStatus }) {
  const kind = s.source.kind === "api_credit" ? "API credit" : s.source.kind === "subscription" ? "Subscription" : s.source.kind === "api_payg" ? "API, pay as you go" : s.source.kind;
  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby={`fs-${s.source.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <h2 id={`fs-${s.source.id}`} style={{ fontSize: 15, fontWeight: 600 }}>
          {s.source.name}
        </h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {kind} · {s.source.provider}
        </span>
      </div>
      {s.credit ? (
        <>
          <span className="big">
            {usd(s.credit.remainingMicros)} <small>of {usd(s.credit.grantMicros)} left</small>
          </span>
          <div className={`bar${s.credit.fractionUsed >= 0.9 ? " warn" : ""}`} aria-hidden="true">
            <span style={{ width: pct(Math.min(1, s.credit.fractionUsed)) }} />
          </div>
          <span className="muted" style={{ fontSize: 13 }}>
            Resets {when(s.credit.cycleEnd)} · {usd(s.credit.spentMicros)} spent this cycle
          </span>
        </>
      ) : s.providerQuota ? (
        <ProviderQuotaBlock q={s.providerQuota} />
      ) : s.quota.length ? (
        s.quota.map((q) => {
          const label = windowLabel(q.window);
          return (
          <div key={q.window} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>{label.name}</span>
              <span className="mono" style={{ color: q.utilization >= 0.9 ? "var(--amber-ink)" : undefined }}>
                {pct(q.utilization)}
              </span>
            </div>
            <div className={`bar${q.utilization >= 0.9 ? " warn" : ""}`} aria-hidden="true">
              <span style={{ width: pct(Math.min(1, q.utilization)) }} />
            </div>
            {label.note && (
              <span className="muted" style={{ fontSize: 12 }}>
                {label.note}
              </span>
            )}
            {q.resetsAt && (
              <span className="muted" style={{ fontSize: 12 }}>
                Resets {when(q.resetsAt)}
                {q.overageInUse ? " · using usage credits" : ""}
              </span>
            )}
            <Forecast f={s.forecasts[q.window]} />
          </div>
          );
        })
      ) : s.source.kind === "subscription" ? (
        // A subscription isn't paid per run, so there's no money to show; its quota appears after its first run.
        <span className="muted">No quota reported yet. It shows here after the first run on this subscription.</span>
      ) : (
        <span className="big">
          {usd(s.totalSpentMicros)} <small>spent through Boss Man</small>
        </span>
      )}
      {s.source.kind === "subscription" && <QuotaSettings s={s} />}
      <Daily s={s} />
      <ByCompany s={s} />
      {s.coverage === "boss_man_runs_only" && s.source.kind !== "subscription" && (
        <span className="muted" style={{ fontSize: 12 }}>
          Counted from Boss Man's own runs. Spend outside Boss Man isn't included: see the{" "}
          <a href="https://console.anthropic.com/settings/cost" target="_blank" rel="noreferrer">
            Console cost page
          </a>
          .
        </span>
      )}
    </section>
  );
}

export function Funding({ companies }: { companies: Company[] }) {
  const sources = usePoll(
    async (signal) => {
      const list = await api<FundingSource[]>("/api/funding-sources", { signal });
      const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
      return Promise.all(list.map((s) => api<FundingStatus>(`/api/funding-sources/${s.id}/status?tz=${tz}`, { signal })));
    },
    30_000,
    "sources",
  );
  const budgets = usePoll((signal) => api<BudgetRow[]>("/api/budgets", { signal }), 30_000, "budgets");
  const runs = usePoll((signal) => api<ActiveRun[]>("/api/runs", { signal }), 10_000, "runs");
  const scopeName = (b: BudgetRow) => (b.policy.scopeKind === "instance" ? "All companies" : b.policy.scopeKind === "company" ? (companies.find((c) => c.id === b.policy.scopeId)?.name ?? "A company") : `A ${b.policy.scopeKind}`);
  const agentName = (id: string | null) => companies.flatMap((c) => c.agents).find((a) => a.id === id)?.name ?? "An agent";

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Funding</h1>
          <p className="sub">Where agent work is paid from, and how much is left this cycle.</p>
        </div>
      </header>
      {sources.data && sources.data.length === 0 ? (
        <State img={art.setup} alt="No funding sources yet" title="No funding sources yet">
          <p>Add a Claude subscription (with a setup-token) or an API key so agents have something to run on.</p>
        </State>
      ) : (
        <div className="grid-cards">{sources.data?.map((s) => <SourceCard key={s.source.id} s={s} />)}</div>
      )}

      {(budgets.data?.length ?? 0) > 0 && (
        <section aria-labelledby="budgets-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 id="budgets-h" style={{ fontSize: 18, fontWeight: 600 }}>
            Budgets
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Window</th>
                  <th scope="col">Used</th>
                  <th scope="col">At the limit</th>
                </tr>
              </thead>
              <tbody>
                {budgets.data!.map((b) => (
                  <tr key={b.policy.id}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      {scopeName(b)}
                    </th>
                    <td>{b.policy.windowKind.replace(/_/g, " ")}</td>
                    <td className="mono" style={{ color: b.status.state === "ok" ? undefined : "var(--amber-ink)" }}>
                      {usd(b.status.usedMicros)} / {usd(b.status.limitMicros)} · {pct(b.status.fractionUsed)}
                    </td>
                    <td>{b.policy.onLimit === "pause" ? "Pause" : "Ask me"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section aria-labelledby="runs-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="runs-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Running now
        </h2>
        {runs.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Company</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Model</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id}>
                    <td className="mono muted">{when(r.startedAt)}</td>
                    <td>{companies.find((c) => c.id === r.companyId)?.name}</td>
                    <td>{agentName(r.agentId)}</td>
                    <td className="mono">{r.model ?? "default"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No agents are running.</p>
        )}
      </section>
    </>
  );
}
