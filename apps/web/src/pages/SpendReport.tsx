// The Spend page (BOS-2194): what a company's API and credit use cost over the last 7, 30 or 90 days, one bar per
// day split by agent, feature or project, a table of totals with each one's share, and a CSV of the same figures.
// Subscription use isn't money, so it is not in here (the Dashboard counts it in tokens).
import { useState } from "react";
import { api, usd, type Company } from "../api";
import { NoCompany } from "../components/NoCompany";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { usePoll } from "../hooks";
import { buildCsv, download } from "../csv";
import { away } from "../server-watch";

export type SpendRow = {
  date: string;
  agentId: string | null;
  agent: string;
  featureId: string | null;
  feature: string;
  projectId: string | null;
  project: string;
  tickets: number;
  micros: number;
};
export type SpendTopTicket = {
  ticketId: string | null;
  ref: string | null;
  title: string;
  state: string | null;
  feature: string | null;
  micros: number;
  runs: number;
};
/** One model's use (BOS-2401): plan use is list price of subscription runs, kept apart from pay-as-you-go. `date` is "" in the period totals. */
export type SpendModelRow = {
  date: string;
  model: string;
  micros: number;
  planMicros: number;
  payMicros: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
export type SpendData = {
  timeZone: string;
  days: string[];
  rows: SpendRow[];
  totalMicros: number;
  topTickets?: SpendTopTicket[];
  models?: SpendModelRow[];
  modelDays?: SpendModelRow[];
};
export type Split = "agent" | "feature" | "project" | "model";

const PERIODS = [7, 30, 90] as const;
const SPLITS: Array<{ id: Split; label: string }> = [
  { id: "agent", label: "By agent" },
  { id: "feature", label: "By feature" },
  { id: "project", label: "By project" },
  { id: "model", label: "By model" },
];

/** The chart's data for a split: the model split charts the per-day model rows (plan and pay-as-you-go together), the rest the money rows. */
export function chartData(data: SpendData, by: Split): SpendData {
  if (by !== "model") return data;
  const rows: SpendRow[] = (data.modelDays ?? []).map((m) => ({
    date: m.date,
    agentId: null,
    agent: m.model,
    featureId: null,
    feature: m.model,
    projectId: m.model,
    project: m.model,
    tickets: 0,
    micros: m.micros,
  }));
  return { ...data, rows, totalMicros: rows.reduce((n, r) => n + r.micros, 0) };
}
const TONES = ["blue", "green", "amber", "purple", "teal"];
const TOP = TONES.length;

// The model split's rows come from chartData, which puts the model name in the project fields.
const nameOf = (r: SpendRow, by: Split) => r[by === "model" ? "project" : by];
const keyOf = (r: SpendRow, by: Split) => (by === "agent" ? r.agentId : by === "feature" ? r.featureId : r.projectId) ?? `none:${nameOf(r, by)}`;

export type Total = { key: string; name: string; micros: number; share: number; tone: string };

/** Totals for the period, biggest first. The top 5 get a colour; everything else is one "Other" (grey) in the chart. */
export function totalsBy(rows: SpendRow[], by: Split): Total[] {
  const sums = new Map<string, { name: string; micros: number }>();
  let all = 0;
  for (const r of rows) {
    const k = keyOf(r, by);
    const s = sums.get(k) ?? { name: nameOf(r, by), micros: 0 };
    s.micros += r.micros;
    all += r.micros;
    sums.set(k, s);
  }
  return [...sums.entries()]
    .sort((a, b) => b[1].micros - a[1].micros || a[1].name.localeCompare(b[1].name))
    .map(([key, s], i) => ({ key, name: s.name, micros: s.micros, share: all ? s.micros / all : 0, tone: i < TOP ? TONES[i]! : "grey" }));
}

/** One stack per day: the top 5's money each, then "Other". */
export function stacksBy(data: SpendData, by: Split) {
  const totals = totalsBy(data.rows, by);
  const toneOf = new Map(totals.map((t) => [t.key, t]));
  return data.days.map((day) => {
    const parts = new Map<string, { name: string; tone: string; micros: number }>();
    for (const r of data.rows) {
      if (r.date !== day) continue;
      const t = toneOf.get(keyOf(r, by))!;
      const id = t.tone === "grey" ? "other" : t.key;
      const p = parts.get(id) ?? { name: t.tone === "grey" ? "Other" : t.name, tone: t.tone, micros: 0 };
      p.micros += r.micros;
      parts.set(id, p);
    }
    const list = [...parts.values()].sort((a, b) => (a.tone === "grey" ? 1 : b.tone === "grey" ? -1 : TONES.indexOf(a.tone) - TONES.indexOf(b.tone)));
    return { day, parts: list, micros: list.reduce((n, p) => n + p.micros, 0) };
  });
}

/** One row per day per agent (and feature and project), the same figures as the page; cost in dollars to four places. */
export function toCsv(rows: SpendRow[]): string {
  return buildCsv(
    ["date", "agent", "feature", "project", "tickets", "cost_usd"],
    rows.map((r) => [r.date, r.agent, r.feature, r.project, r.tickets, (r.micros / 1e6).toFixed(4)]),
  );
}

/** One row per day per model, with runs, tokens, and plan use apart from pay-as-you-go; cost in dollars to four places. */
export function toModelCsv(rows: SpendModelRow[]): string {
  return buildCsv(
    ["date", "model", "runs", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "plan_usd", "pay_as_you_go_usd", "cost_usd"],
    rows.map((r) => [r.date, r.model, r.runs, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, (r.planMicros / 1e6).toFixed(4), (r.payMicros / 1e6).toFixed(4), (r.micros / 1e6).toFixed(4)]),
  );
}

const dayLabel =(d: string) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
const pct = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

export function SpendChart({ data, by }: { data: SpendData; by: Split }) {
  const stacks = stacksBy(data, by);
  const totals = totalsBy(data.rows, by);
  const max = Math.max(1, ...stacks.map((s) => s.micros));
  const legend = totals.slice(0, TOP).map((t) => ({ name: t.name, tone: t.tone }));
  if (totals.length > TOP) legend.push({ name: "Other", tone: "grey" });
  return (
    <figure className="card chart" style={{ margin: 0 }}>
      <figcaption>
        <strong>Spend per day</strong>
        <small className="muted">Last {data.days.length} days, in {data.timeZone}</small>
      </figcaption>
      <div className="dbars spend-bars" style={{ height: 180, gap: data.days.length > 30 ? 1 : 4 }} role="img" aria-label={`Spend per day: ${usd(data.totalMicros)} in the last ${data.days.length} days`}>
        {stacks.map((s) => (
          <div key={s.day} className="dbar" title={`${dayLabel(s.day)}: ${usd(s.micros)}${s.parts.length ? ` (${s.parts.map((p) => `${p.name} ${usd(p.micros)}`).join(", ")})` : ""}`}>
            {s.parts.map((p) => (
              <span key={p.name} className={`seg ${p.tone}`} style={{ height: `${(p.micros / max) * 100}%` }} />
            ))}
            {s.micros === 0 && <span className="seg empty" />}
          </div>
        ))}
        {data.totalMicros === 0 && <span className="chart-empty muted">No spend in the last {data.days.length} days</span>}
      </div>
      <div className="axis">
        <span>{dayLabel(data.days[0] ?? "")}</span>
        <span>{dayLabel(data.days[Math.floor(data.days.length / 2)] ?? "")}</span>
        <span>{dayLabel(data.days.at(-1) ?? "")}</span>
      </div>
      <ul className="legend">
        {legend.map((l) => (
          <li key={l.name}>
            <span className={`swatch ${l.tone}`} aria-hidden="true" /> {l.name}
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function SpendTable({ data, by }: { data: SpendData; by: Split }) {
  const totals = totalsBy(data.rows, by);
  const heading = SPLITS.find((s) => s.id === by)!.label.replace("By ", "");
  return (
    <div className="table-wrap">
      <table style={{ minWidth: 0 }}>
        <thead>
          <tr>
            <th style={{ textTransform: "capitalize" }}>{heading}</th>
            <th style={{ textAlign: "right" }}>Spend</th>
            <th style={{ textAlign: "right" }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {totals.map((t) => (
            <tr key={t.key}>
              <td>
                <span className={`swatch ${t.tone}`} aria-hidden="true" /> {t.name}
              </td>
              <td className="mono" style={{ textAlign: "right" }}>{usd(t.micros)}</td>
              <td className="mono" style={{ textAlign: "right" }}>{pct(t.share)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Total</th>
            <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{usd(data.totalMicros)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const num = (n: number) => n.toLocaleString("en-US");

/** The model split's table (BOS-2401): spend, runs, tokens, share, and plan use apart from pay-as-you-go. */
export function ModelTable({ models }: { models: SpendModelRow[] }) {
  const all = models.reduce((n, m) => n + m.micros, 0);
  const right = { textAlign: "right" } as const;
  return (
    <div className="table-wrap">
      <table style={{ minWidth: 0 }}>
        <thead>
          <tr>
            <th>Model</th>
            <th style={right}>Spend</th>
            <th style={right}>Share</th>
            <th style={right}>Plan use</th>
            <th style={right}>Pay-as-you-go</th>
            <th style={right}>Runs</th>
            <th style={right}>Tokens in</th>
            <th style={right}>Tokens out</th>
            <th style={right}>Cache read</th>
            <th style={right}>Cache write</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model}>
              <td>{m.model}</td>
              <td className="mono" style={right}>{usd(m.micros)}</td>
              <td className="mono" style={right}>{pct(all ? m.micros / all : 0)}</td>
              <td className="mono" style={right}>{usd(m.planMicros)}</td>
              <td className="mono" style={right}>{usd(m.payMicros)}</td>
              <td className="mono" style={right}>{num(m.runs)}</td>
              <td className="mono" style={right}>{num(m.inputTokens)}</td>
              <td className="mono" style={right}>{num(m.outputTokens)}</td>
              <td className="mono" style={right}>{num(m.cacheReadTokens)}</td>
              <td className="mono" style={right}>{num(m.cacheWriteTokens)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Total</th>
            <td className="mono" style={{ ...right, fontWeight: 600 }}>{usd(all)}</td>
            <td colSpan={8} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** The period's costliest tickets (BOS-2370), each title a link to its ticket, with its share of the period's total. */
export function TopTicketsTable({ data }: { data: SpendData }) {
  const list = data.topTickets ?? [];
  if (list.length === 0) return null;
  return (
    <section>
      <h2>Costliest tickets</h2>
      <div className="table-wrap">
        <table style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>State</th>
              <th>Feature</th>
              <th style={{ textAlign: "right" }}>Runs</th>
              <th style={{ textAlign: "right" }}>Spend</th>
              <th style={{ textAlign: "right" }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.ticketId ?? "none"}>
                <td>
                  {t.ticketId ? (
                    <>
                      {t.ref ? <span className="mono">{t.ref}</span> : null} <a href={`#/tickets/${t.ticketId}`}>{t.title}</a>
                    </>
                  ) : (
                    t.title
                  )}
                </td>
                <td>{t.state ? t.state.replace(/_/g, " ") : ""}</td>
                <td>{t.feature ?? ""}</td>
                <td className="mono" style={{ textAlign: "right" }}>{t.runs}</td>
                <td className="mono" style={{ textAlign: "right" }}>{usd(t.micros)}</td>
                <td className="mono" style={{ textAlign: "right" }}>{pct(data.totalMicros ? t.micros / data.totalMicros : 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SpendReport({ company }: { company: Company | undefined }) {
  const [days, setDays] = useState<number>(30);
  const [by, setBy] = useState<Split>("agent");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = `spend-report-${company?.id}-${days}`;
  const report = usePoll(
    (signal) => (company ? api<SpendData>(`/api/companies/${company.id}/spend-report?days=${days}&tz=${encodeURIComponent(zone)}`, { signal }) : Promise.resolve(null)),
    60_000,
    key,
  );
  if (!company) return <NoCompany />;
  const data = report.data;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company.name}</p>
          <h1>Spend</h1>
        </div>
        <button type="button" disabled={!data || (by === "model" ? (data.modelDays ?? []).length === 0 : data.rows.length === 0)} onClick={() => data && download(`spend-${company.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${data.days.at(-1)}-last-${days}-days.csv`, (by === "model" ? toModelCsv(data.modelDays ?? []) : toCsv(data.rows)))}>
          Download CSV
        </button>
      </header>
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        What API and credit use cost, as list-price estimates, not a bill. Runs paid from a subscription are not money and are left out; the Dashboard counts them in tokens. "By model" is the exception: it also shows plan use at list price, apart from pay-as-you-go.
      </p>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div className="segmented" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p} type="button" className="chip" aria-pressed={days === p} onClick={() => setDays(p)}>
              {p} days
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Split spend">
          {SPLITS.map((s) => (
            <button key={s.id} type="button" className="chip" aria-pressed={by === s.id} onClick={() => setBy(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {report.error && !away(report.error) ? <LoadError what="the spend" message={report.error.message} onRetry={report.reload} /> : null}
      {!data ? (
        report.error ? null : <Loader label="Loading the spend" />
      ) : (
        <>
          <SpendChart data={chartData(data, by)} by={by} />
          {by === "model" ? (
            (data.models ?? []).length === 0 ? <p className="muted">No model use in the last {days} days.</p> : <ModelTable models={data.models ?? []} />
          ) : data.rows.length === 0 ? (
            <p className="muted">No spend in the last {days} days.</p>
          ) : (
            <SpendTable data={data} by={by} />
          )}
          <TopTicketsTable data={data} />
        </>
      )}
    </>
  );
}
