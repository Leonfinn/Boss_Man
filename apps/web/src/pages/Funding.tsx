import { useState } from "react";
import { api, usd, type BudgetRow, type Company, type FundingSource, type FundingStatus } from "../api";
import { usePoll } from "../hooks";
import { windowHasReset, windowLabel } from "@boss-man/shared";
import { ageLabel } from "../age";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";

const pct = (f: number) => `${Math.round(f * 100)}%`;
/** "Thu 29 Oct at 14:04": day, date and time in the same style as the reset line. */
const dayAndTime = (iso: string) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${day} at ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** A rate in % an hour: one decimal under 10% (0.3% and 1.5% must not read as 0% and 2%). */
const rateText = (perHour: number) => {
  const p = perHour * 100;
  return `about ${p >= 10 ? Math.round(p) : Number(p.toFixed(1))}% an hour`;
};

/** The limit estimate under a quota bar (R78): how fast it's going, and whether it lasts until the reset. */
function Forecast({ f }: { f: FundingStatus["forecasts"][string] | undefined }) {
  if (!f || f.perHour === null) return null;
  // The rate the date was worked out from, so the two always agree (BOS-1012).
  const rate = `at ${rateText(f.runsOutPerHour ?? f.perHour)}`;
  const [warn, text] = f.perHour <= 0 || !f.runsOutAt ? [false, "Not rising at the moment"] : f.beforeReset ? [true, `Runs out about ${dayAndTime(f.runsOutAt)} ${rate}, if the week so far keeps on as it has`] : [false, `Won't run out before it resets ${rate}, at the week's pace so far`];
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

const holdLength = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

/** The last 8 weeks of this source: plan use at each reset, spend, and the times work was held for its quota. */
function Weeks({ s }: { s: FundingStatus }) {
  const weeks = s.weeks ?? [];
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const hasData = weeks.some((w) => w.plans.length || w.spendMicros > 0 || w.holds.length);
  return (
    <details className="weeks">
      <summary>Last 8 weeks</summary>
      {!hasData ? (
        <p className="muted" style={{ fontSize: 13 }}>Nothing recorded yet. Each reset, week of spend and hold shows here as it happens.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
          {weeks.map((w) => (
            <li key={w.start} style={{ fontSize: 13 }}>
              <strong>
                {day(w.start)} to {day(w.end)}
              </strong>
              {w.plans.map((p) => (
                <div key={p.window}>
                  {pct(p.peak)}
                  {p.limit ? ` (of ${p.limit.toLocaleString()})` : ""} of {windowLabel(p.window).name}, {p.resets} reset{p.resets === 1 ? "" : "s"}
                </div>
              ))}
              {w.spendMicros > 0 && <div>{usd(w.spendMicros)} spent pay as you go</div>}
              {w.holds.map((h) => (
                <div key={h.startedAt}>
                  Work held for the {windowLabel(h.window).name}: {when(h.startedAt)} to {h.endedAt ? when(h.endedAt) : "now"} ({holdLength(h.ms)})
                </div>
              ))}
              {!w.plans.length && w.spendMicros <= 0 && !w.holds.length && <div className="muted">Nothing recorded</div>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** Who used this source in the last 7 days: money for paid sources, tokens for a subscription. */
function ByCompany({ s }: { s: FundingStatus }) {
  const rows = s.byCompany ?? [];
  if (!rows.length) return null;
  const sub = s.source.kind === "subscription";
  return (
    <div className="by-company">
      <span className="muted">Last 7 days, by company</span>
      <ul>
        {rows.map((r) => (
          <li key={r.companyId}>
            <span>{r.name}</span>
            <span className="mono nowrap">
              {sub ? `${compact(r.tokens)} tokens` : usd(r.costMicros)} · {r.runs} run{r.runs === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Who used it, last 7 days": top agents and the split by project, each with tokens, spend and share (BOS-2442). */
function WhoUsedIt({ s }: { s: FundingStatus }) {
  const w = s.whoUsedIt;
  if (!w) return null;
  type Row = { name: string; tokens: number; costMicros: number; share: number; engagement?: boolean; company?: string | null };
  const line = (r: Row, key: string) => (
    <li key={key}>
      <span>
        {r.name}
        {r.company ? <span className="muted"> · {r.company}</span> : null}
        {r.engagement ? <span className="muted"> (engagement work, charged here)</span> : null}
      </span>
      <span className="mono nowrap">
        {[w.totalTokens > 0 ? `${compact(r.tokens)} tokens` : null, w.totalMicros > 0 ? usd(r.costMicros) : null, pct(r.share)].filter(Boolean).join(" · ")}
      </span>
    </li>
  );
  const list = (title: string, rows: Row[], others: { tokens: number; costMicros: number; share: number; count: number } | null | undefined) => (
    <div>
      <span className="muted">{title}</span>
      <ul>
        {rows.map((r, i) => line(r, `${i}`))}
        {others && line({ name: `Everyone else (${others.count})`, ...others }, "others")}
      </ul>
    </div>
  );
  return (
    <details className="weeks">
      <summary>Who used it, last 7 days</summary>
      {w.totalTokens <= 0 && w.totalMicros <= 0 ? (
        <span className="muted">Not used in the last 7 days</span>
      ) : (
        <>
          <span className="muted">Shares are of {w.totalMicros > 0 ? "spend" : "tokens"}.</span>
          {list("Top agents", w.agents, w.agentsOthers)}
          {list("By project", w.projects, w.projectsOthers)}
        </>
      )}
    </details>
  );
}

/** "3 min ago", "2h ago", "4d ago": how old a cached reading is, in age.ts's words. */
const ago = (seconds: number | null) => (seconds === null ? "" : ageLabel(seconds * 1000));

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
  const claude = s.source.provider === "anthropic";
  const synthetic = s.source.provider === "synthetic";
  const [rank, setRank] = useState<string>(s.source.fallbackRank ? String(s.source.fallbackRank) : "");
  const [secretId, setSecretId] = useState<string>(s.source.secretId ?? "");
  const tokens = usePoll((signal) => (claude ? api<Array<{ id: string; name: string; kind: string }>>("/api/secrets", { signal }) : Promise.resolve([])), 60_000, "secrets-for-funding");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const windows = s.windowsSeen ?? s.quota.map((q) => q.window);
  const save = async () => {
    setError(null);
    try {
      await api(`/api/funding-sources/${s.source.id}`, { method: "PATCH", body: { quotaHoldAt: holdAt / 100, quotaOverage: overage, quotaDisabledWindows: off, ...(claude ? { fallbackRank: rank ? Number(rank) : null, secretId: secretId || undefined } : {}) } });
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
      {/* Each label sits above its control: side by side they crush the label and push the select out of the card. */}
      <label className="field-stack">
        <span>Hold routine work at</span>
        <span className="field-inline">
          <input aria-label="Hold routine work at this percentage" type="number" min={80} max={100} value={holdAt} onChange={(e) => setHoldAt(Math.max(80, Math.min(100, Number(e.target.value) || 95)))} style={{ width: 96 }} />
          <span>%</span>
        </span>
      </label>
      {/* The same setting as Claude's extra usage (BOS-227): Synthetic spends paid top-up credit once the weekly allowance is used (BOS-934). */}
      <label className="field-stack">
        <span>{synthetic ? "I have top-up credit" : "I have extra usage"}</span>
        <select aria-label={synthetic ? "Top-up credit" : "Extra usage"} className="fill" value={overage} onChange={(e) => setOverage(e.target.value as "pause" | "urgent" | "all")}>
          <option value="pause">Hold everything at the limit (urgent tickets run until then)</option>
          <option value="urgent">{synthetic ? "Keep urgent work running on top-up credit" : "Keep urgent work running past the limit"}</option>
          <option value="all">{synthetic ? "Keep all work running on top-up credit" : "Keep all work running"}</option>
        </select>
      </label>
      {(synthetic || overage !== "pause") && (
      <span className="muted" style={{ fontSize: 12 }}>
        {synthetic
          ? overage === "pause"
            ? `Routine work is held at ${holdAt}% of the weekly allowance and nothing spends top-up credit, except chats and reviews, which always run. Use this if the account has no top-up credit.`
            : overage === "urgent"
              ? `Routine work is held at ${holdAt}%. Urgent tickets, chats and reviews carry on past the weekly allowance, paid from your Synthetic top-up credit.`
              : "Nothing is held: once the weekly allowance is used, Synthetic pays for all work from your top-up credit. You get one note a week when that starts."
          : "Extra usage is billed by Anthropic. Boss Man can't see the balance, so set a spending limit in your Claude account."}
        {synthetic && overage !== "pause" ? " Synthetic doesn't report the balance, so Boss Man can't stop before it runs out; check it at synthetic.new." : null}
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
              <label key={w} className="window-hold">
                <input type="checkbox" checked={!off.includes(w)} onChange={(e) => toggle(w, e.target.checked)} />
                <span>
                  Can trigger the hold: {windowLabel(w).name} <span className="mono">({w})</span>
                </span>
                {latest && <span className="mono muted pct">{pct(windowHasReset(latest.resetsAt ? new Date(latest.resetsAt) : null, new Date()) ? 0 : latest.utilization)}</span>}
              </label>
            );
          })}
          <span className="muted" style={{ fontSize: 12 }}>
            {s.source.provider === "synthetic"
              ? "These come from Synthetic's own usage reading, checked every 5 minutes. Infinite-mode agents are never held."
              : "These names come from Claude Code and aren't documented, so Boss Man doesn't guess what each one means."}
          </span>
        </fieldset>
      )}
      {claude && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Switch between Claude accounts</span>
          <label className="field-stack">
            <span>Order (1 is used first; leave empty to keep this account out of the list)</span>
            <input aria-label="Claude account order" type="number" min={1} max={10} value={rank} onChange={(e) => setRank(e.target.value)} style={{ width: 96 }} />
          </label>
          <label className="field-stack">
            <span>Login for this account</span>
            <select aria-label="Claude account login" className="fill" value={secretId} onChange={(e) => setSecretId(e.target.value)}>
              <option value="">The company's own Claude token (Settings, Secrets)</option>
              {(tokens.data ?? []).filter((t) => t.kind === "claude_oauth_token").map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <span className="muted" style={{ fontSize: 12 }}>
            When an account in the list reaches its hold level, new runs go to the next one with room, and back again once the first resets. Runs already going finish where they started. Add each plan's token first under Settings, Secrets (Add secret, kind Claude setup-token), then create a Claude subscription source here for it.
          </span>
        </div>
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

/**
 * Synthetic's own reading; an unreadable one is unknown, never an error. The plan spends its weekly
 * credits, so that is what the bar shows when Synthetic reports them (BOS-260); the old request
 * window is shown only when there is nothing weekly, and always labelled as that, never as usage.
 */
function ProviderQuotaBlock({ q }: { q: NonNullable<FundingStatus["providerQuota"]> }) {
  if (q.used === null || q.limit === null)
    return <span className="muted">Quota unknown: Synthetic's quota service couldn't be reached and there's no earlier reading yet.</span>;
  const fraction = q.limit > 0 ? q.used / q.limit : 0;
  const weekly = (q.measure ?? "requests") === "weekly";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span>{weekly ? "Weekly credits" : "Requests this period"}</span>
        <span className="mono" style={{ color: fraction >= 0.8 ? "var(--amber-ink)" : undefined }}>
          {weekly ? `${pct(fraction)} used · ${100 - Math.round(fraction * 100)}% left` : `${q.used.toLocaleString()} of ${q.limit.toLocaleString()} · ${pct(fraction)}`}
        </span>
      </div>
      <div className={`bar${fraction >= 0.8 ? " warn" : ""}`} aria-hidden="true">
        <span style={{ width: pct(Math.min(1, fraction)) }} />
      </div>
      {weekly ? (
        <span className="muted" style={{ fontSize: 12 }}>
          Credits come back 2% at a time. Boss Man started reading weekly credits on 31 Oct; earlier readings in this list were the old request count.
        </span>
      ) : (
        <>
          {q.renewsAt && (
            <span className="muted" style={{ fontSize: 12 }}>
              Renews {when(q.renewsAt)} ({until(q.renewsAt)})
            </span>
          )}
          <span className="muted" style={{ fontSize: 12 }}>
            This is Synthetic's request window, which the weekly plan often doesn't use. Synthetic's API doesn't report weekly credits for this account, so this isn't total usage.
          </span>
        </>
      )}
      <Trend q={q} />
      {/* api.synthetic.new has no balance field or route (checked 9 Nov 2026, BOS-934), so this can only say so. */}
      <span className="muted" style={{ fontSize: 12 }}>
        Top-up credit: not shown. Synthetic's API doesn't report the balance; see it at synthetic.new. Whether work uses it is your choice under "I have top-up credit" below.
      </span>
      <span className="muted" style={{ fontSize: 12 }}>
        Checked {ago(q.ageSeconds)}{q.warned.length ? ` · you've been warned at ${q.warned.join("% and ")}%` : ""}
      </span>
    </div>
  );
}

function SourceCard({ s }: { s: FundingStatus }) {
  const kind = s.source.kind === "api_credit" ? "API credit" : s.source.kind === "subscription" ? "Subscription" : s.source.kind === "api_payg" ? "API, pay as you go" : s.source.kind;
  return (
    <section className="card source-card" aria-labelledby={`fs-${s.source.id}`}>
      <div className="source-head">
        <h2 id={`fs-${s.source.id}`}>
          {s.source.name}
          {s.source.fallbackRank ? <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}> · account {s.source.fallbackRank}</span> : null}
          {s.claudeActive ? <span className="pill" style={{ marginLeft: 8, fontSize: 12 }}>In use now</span> : null}
        </h2>
        <span className="muted">
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
          // A reading whose window has already reset says nothing about the window now (BOS-1409):
          // every limit reads as empty, the same rule the hold uses, so Fable and This week never show last week's figure.
          const beforeReset = windowHasReset(q.resetsAt ? new Date(q.resetsAt) : null, new Date());
          const utilization = beforeReset ? 0 : q.utilization;
          return (
          <div key={q.window} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>{label.name}</span>
              <span className="mono" style={{ color: utilization >= 0.9 ? "var(--amber-ink)" : undefined }}>
                {pct(utilization)}
              </span>
            </div>
            <div className={`bar${utilization >= 0.9 ? " warn" : ""}`} aria-hidden="true">
              <span style={{ width: pct(Math.min(1, utilization)) }} />
            </div>
            {label.note && (
              <span className="muted" style={{ fontSize: 12 }}>
                {label.note}
              </span>
            )}
            {q.resetsAt && (
              <span className="muted" style={{ fontSize: 12 }}>
                {beforeReset ? "No reading since its reset; updates on the next run" : `Resets ${when(q.resetsAt)}`}
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
      <WhoUsedIt s={s} />
      <Weeks s={s} />
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

/** One status card per funding source (usage, resets, forecast, quota holds, spend), shown on Settings → Funding. */
export function FundingCards() {
  const sources = usePoll(
    async (signal) => {
      const list = await api<FundingSource[]>("/api/funding-sources", { signal });
      const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
      return Promise.all(list.map((s) => api<FundingStatus>(`/api/funding-sources/${s.id}/status?tz=${tz}`, { signal })));
    },
    30_000,
    "sources-status",
  );
  return (
    <>
      {sources.error ? <LoadError what="funding sources" message={sources.error.message} onRetry={sources.reload} /> : null}
      {sources.data === null ? (
        sources.error ? null :
        <Loader label="Loading funding sources" />
      ) : sources.data.length === 0 ? (
        <p className="muted">No funding sources yet.</p>
      ) : (
        <div className="grid-cards">{sources.data.map((s) => <SourceCard key={s.source.id} s={s} />)}</div>
      )}
    </>
  );
}

/** The budget policies (scope, window, used, what happens at the limit), shown on Settings → Funding. */
export function BudgetLimits({ companies }: { companies: Company[] }) {
  const budgets = usePoll((signal) => api<BudgetRow[]>("/api/budgets", { signal }), 30_000, "budgets");
  const scopeName = (b: BudgetRow) => (b.policy.scopeKind === "instance" ? "All companies" : b.policy.scopeKind === "company" ? (companies.find((c) => c.id === b.policy.scopeId)?.name ?? "A company") : `A ${b.policy.scopeKind}`);

  return (
    <>
      {(budgets.data?.length ?? 0) > 0 && (
        <section aria-labelledby="budget-limits-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 id="budget-limits-h" style={{ fontSize: 18, fontWeight: 600 }}>
            Spending limits
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
    </>
  );
}
