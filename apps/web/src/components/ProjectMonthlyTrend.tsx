import { usd } from "../api";

export type ProjectMonth = { month: string; paygMicros: number; planMicros: number; runs: number };

const label = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });

/** One project's last months of spend (BOS-2369): a stacked bar per month (plan use under pay-as-you-go), the monthly cap as a line, and a table with the same figures. */
export function ProjectMonthlyTrend({ months, capMicros }: { months: ProjectMonth[]; capMicros: number | null }) {
  if (!months.length) return null;
  const W = 360;
  const H = 140;
  const top = 12;
  const bottom = 22;
  const plotH = H - top - bottom;
  const peak = Math.max(1, capMicros ?? 0, ...months.map((m) => m.paygMicros + m.planMicros));
  const y = (v: number) => top + plotH - (v / peak) * plotH;
  const slot = W / months.length;
  const barW = Math.min(36, slot * 0.6);
  const quiet = months.every((m) => m.paygMicros === 0 && m.planMicros === 0 && m.runs === 0);
  return (
    <section aria-label="Spend by month" style={{ marginTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Month by month</h2>
      {quiet ? (
        <p className="muted" style={{ margin: 0 }}>No spend or runs on this project in the last {months.length} months.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Spend per month for the last ${months.length} months, plan use and pay-as-you-go. The table below has the same figures.`} style={{ width: "100%", maxWidth: 520, height: "auto", display: "block" }}>
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" />
            {months.map((m, i) => {
              const x = i * slot + (slot - barW) / 2;
              const paygH = (m.paygMicros / peak) * plotH;
              const planH = (m.planMicros / peak) * plotH;
              return (
                <g key={m.month}>
                  <rect x={x} y={y(0) - paygH} width={barW} height={paygH} fill="var(--accent-dark)"><title>{`${label(m.month)}: pay-as-you-go ${usd(m.paygMicros)}`}</title></rect>
                  <rect x={x} y={y(0) - paygH - planH} width={barW} height={planH} fill="var(--amber-line)"><title>{`${label(m.month)}: plan use about ${usd(m.planMicros)} at list prices`}</title></rect>
                  <text x={i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">{label(m.month)}</text>
                </g>
              );
            })}
            {capMicros ? (
              <g>
                <line x1={0} x2={W} y1={y(capMicros)} y2={y(capMicros)} stroke="var(--ink)" strokeDasharray="4 3" />
                <text x={W - 2} y={Math.max(9, y(capMicros) - 3)} textAnchor="end" fontSize={10} fill="var(--ink)">{`Monthly cap ${usd(capMicros)}`}</text>
              </g>
            ) : null}
          </svg>
          <p className="muted" style={{ fontSize: 13, margin: "4px 0 8px" }}>
            <span aria-hidden="true" style={{ display: "inline-block", width: 10, height: 10, background: "var(--accent-dark)", marginRight: 4 }} />Pay-as-you-go
            <span aria-hidden="true" style={{ display: "inline-block", width: 10, height: 10, background: "var(--amber-line)", margin: "0 4px 0 14px" }} />Plan use (list-price estimate)
          </p>
        </>
      )}
      <div style={{ overflowX: "auto" }}>
        <table>
          <caption className="muted" style={{ textAlign: "left" }}>Months in your time zone, oldest first</caption>
          <thead>
            <tr><th scope="col">Month</th><th scope="col">Pay-as-you-go</th><th scope="col">Plan use</th><th scope="col">Runs</th></tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}>
                <th scope="row">{label(m.month)}</th>
                <td className="mono">{usd(m.paygMicros)}</td>
                <td className="mono">{usd(m.planMicros)}</td>
                <td>{m.runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
