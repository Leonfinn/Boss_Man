// Settings → Server and runner → Limits and checks → Check workers (DR-060, BOS-1435). Other machines that take checks when the
// company runner's slots are full. The owner adds one (its token is shown once), sets its slots and per-check caps, and
// can turn it off or remove it. Each worker says, per company, whether it takes checks and if not, why.
import { useState } from "react";
import { CHECK_PEAK_MB, checkMemoryWarning } from "@boss-man/shared";

const MEMORY_GUIDE = "https://github.com/Leonfinn/Boss_Man/blob/main/docs/34-check-workers.md#changing-the-memory-on-any-docker-host";
import { api, type Company } from "../../api";
import { copyMessage, copyText } from "../../clipboard";
import { buildCsv, download } from "../../csv";
import { usePoll } from "../../hooks";
import { when } from "../Runs";
import type { HostFactsView } from "../../host-facts-display";
import { workerAddressChoices, workerComposeFile, workerSocketUrl } from "./check-worker-compose";
import { LoadError } from "../../components/LoadError";
import { SaveButton } from "../../components/SaveButton";
import { useAction } from "./shared";
import { DEFAULT_POLICY, policyLine, policyValid, SlotSplitFields, type MachineTakes, type SlotPolicy } from "./SlotSplit";

export type CheckWorkerView = {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  slots: number;
  reportedSlots: number | null;
  /** BOS-2217: the machine's memory for checks, in MB; absent or null from an older worker or server. */
  reportedMemoryMb?: number | null;
  /** BOS-2217: set when checks at once × memory per check is more than the machine has. */
  memoryWarning?: string | null;
  limit: number;
  /** BOS-1602; absent from a server older than this page. */
  takes?: MachineTakes;
  mergeKept?: number;
  checkThreads: number | null;
  checkMemoryMb: number | null;
  imageCommit: string | null;
  toolchain: Record<string, string> | null;
  lastSeenAt: string | null;
  companies: { id: string; name: string; ready: boolean; reason: string | null }[];
  reason: string | null;
};

/** BOS-2373: one machine's last 7 days, from GET /api/settings/check-workers/stats. */
export type MachineStatsView = {
  machine: string;
  total: number;
  passed: number;
  failed: number;
  stuck: number;
  medianSeconds: number | null;
  longestSeconds: number | null;
  recent: { id: string; ticketId: string; ref: string | null; title: string; kind: string; scope: string; result: string; seconds: number | null; endedAt: string | null }[];
};

const lengthText = (s: number | null) => (s === null ? "" : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

/** The 7-day line and the "Last 10 checks" fold for one machine. */
export function MachineRecord({ stats }: { stats: MachineStatsView | undefined }) {
  if (!stats || stats.total === 0) {
    return (
      <p className="muted" style={{ fontSize: 14, margin: 0 }} data-testid="machine-record">
        No checks in the last 7 days
      </p>
    );
  }
  return (
    <>
      <p style={{ fontSize: 14, margin: 0 }} data-testid="machine-record">
        {`7 days: ${stats.total} check${stats.total === 1 ? "" : "s"} · ${stats.passed} passed · ${stats.failed} failed · ${stats.stuck} stuck`}
        {stats.medianSeconds !== null ? ` · median ${lengthText(stats.medianSeconds)}` : ""}
        {stats.longestSeconds !== null ? ` · longest ${lengthText(stats.longestSeconds)}` : ""}
      </p>
      <details>
        <summary style={{ fontSize: 14 }}>Last {Math.min(10, stats.recent.length)} checks</summary>
        <table style={{ fontSize: 14 }}>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Kind</th>
              <th>Scope</th>
              <th>Result</th>
              <th>Length</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            {stats.recent.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`#/tickets/${c.ticketId}`}>{c.ref ?? "ticket"}</a> {c.title}
                </td>
                <td>{c.kind}</td>
                <td>{c.scope}</td>
                <td>{c.result}</td>
                <td>{lengthText(c.seconds)}</td>
                <td>{when(c.endedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

/** BOS-2436: the check line over 7 days, all machines together, from GET /api/settings/check-workers/line. */
export type CheckLineView = {
  days: { date: string; quick: number; full: number; merge: number }[];
  kinds: { kind: "quick" | "full" | "merge"; total: number; cancelled: number; medianWaitSeconds: number | null; longestWaitSeconds: number | null; medianRunSeconds: number | null }[];
  busiestHours: { hour: number; checks: number }[];
  waitingNow: number;
  oldestWaitSeconds: number | null;
  timeZone: string;
};

export const MACHINES_CSV_HEAD = ["machine", "connected", "checks", "passed", "failed", "stuck", "median_seconds", "longest_seconds"];
const emptyIfNone = (n: number | null | undefined): number | string => (n === null || n === undefined ? "" : n);

/** One row per machine: the company runner first, then each worker. A figure the machine has no value for is an empty cell. */
export function machinesToCsvRows(machines: { name: string; connected: boolean; stats: MachineStatsView | undefined }[]): Array<Array<string | number>> {
  return machines.map((m) => [m.name, m.connected ? "yes" : "no", m.stats?.total ?? 0, m.stats?.passed ?? 0, m.stats?.failed ?? 0, m.stats?.stuck ?? 0, emptyIfNone(m.stats?.medianSeconds), emptyIfNone(m.stats?.longestSeconds)]);
}

export const LINE_DAYS_CSV_HEAD = ["date", "quick", "full", "merge", "total"];
export const LINE_KINDS_CSV_HEAD = ["kind", "checks", "cancelled", "median_wait_seconds", "longest_wait_seconds", "median_run_seconds"];

/** The days, a blank line, then the kinds, each part with its own header row. */
export function lineToCsv(line: CheckLineView): string {
  const days = buildCsv(LINE_DAYS_CSV_HEAD, line.days.map((d) => [d.date, d.quick, d.full, d.merge, d.quick + d.full + d.merge]));
  const kinds = buildCsv(LINE_KINDS_CSV_HEAD, line.kinds.map((k) => [k.kind, k.total, k.cancelled, emptyIfNone(k.medianWaitSeconds), emptyIfNone(k.longestWaitSeconds), emptyIfNone(k.medianRunSeconds)]));
  return `${days}\r\n${kinds}`;
}

export const csvDay = (now = new Date()) => now.toISOString().slice(0, 10);

const KIND_NAMES = { quick: "Quick", full: "Full", merge: "Merge" } as const;
const hourText = (h: number) => `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
const dayText = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** The "Check line, last 7 days" fold: how many checks came in, how long they waited for a machine, and when it is busiest. */
export function CheckLine({ line }: { line: CheckLineView }) {
  const ran = line.kinds.reduce((t, k) => t + k.total, 0);
  const cancelled = line.kinds.reduce((t, k) => t + k.cancelled, 0);
  const waiting =
    line.waitingNow === 0 ? "Nothing waiting now." : `Waiting now: ${line.waitingNow} check${line.waitingNow === 1 ? "" : "s"}, the oldest for ${lengthText(line.oldestWaitSeconds ?? 0)}.`;
  return (
    <details className="card" style={{ padding: 8 }} data-testid="check-line">
      <summary>
        <strong>Check line, last 7 days</strong>
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6, fontSize: 14 }}>
        <p style={{ margin: 0 }} data-testid="check-line-now">
          {waiting}
        </p>
        {ran === 0 && cancelled === 0 ? (
          <p className="muted" style={{ margin: 0 }} data-testid="check-line-empty">
            No checks in the last 7 days
          </p>
        ) : (
          <>
            <table data-testid="check-line-kinds">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Checks</th>
                  <th>Median wait to start</th>
                  <th>Longest wait</th>
                  <th>Median run time</th>
                  <th>Cancelled</th>
                </tr>
              </thead>
              <tbody>
                {line.kinds.map((k) => (
                  <tr key={k.kind}>
                    <td>{KIND_NAMES[k.kind]}</td>
                    <td>{k.total}</td>
                    <td>{lengthText(k.medianWaitSeconds)}</td>
                    <td>{lengthText(k.longestWaitSeconds)}</td>
                    <td>{lengthText(k.medianRunSeconds)}</td>
                    <td>{k.cancelled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table data-testid="check-line-days">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Quick</th>
                  <th>Full</th>
                  <th>Merge</th>
                </tr>
              </thead>
              <tbody>
                {line.days.map((d) => (
                  <tr key={d.date}>
                    <td>{dayText(d.date)}</td>
                    <td>{d.quick}</td>
                    <td>{d.full}</td>
                    <td>{d.merge}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {line.busiestHours.length > 0 && (
              <p style={{ margin: 0 }} data-testid="check-line-hours">
                {`Busiest hours (checks queued, ${line.timeZone} time): `}
                {line.busiestHours.map((h) => `${hourText(h.hour)} (${h.checks})`).join(" · ")}
              </p>
            )}
            <div>
              <button type="button" className="btn" onClick={() => download(`check-line-7-days-${csvDay()}.csv`, lineToCsv(line))}>
                Download CSV
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Wait is from a check joining the line to a machine starting it. Checks still waiting count above, not in the medians; cancelled checks are counted apart.
            </p>
          </>
        )}
      </div>
    </details>
  );
}

type Draft = { name: string; companyIds: string[]; slots: string; threads: string; memoryGb: string; policy: SlotPolicy };
const blank: Draft = { name: "", companyIds: [], slots: "1", threads: "", memoryGb: "", policy: DEFAULT_POLICY };

/** The form values a worker has now: the baseline the Save button compares against. */
const draftOf = (w: CheckWorkerView): Draft => ({ name: w.name, companyIds: w.companies.map((c) => c.id), slots: String(w.slots), threads: w.checkThreads ? String(w.checkThreads) : "", memoryGb: w.checkMemoryMb ? String(w.checkMemoryMb / 1024) : "", policy: { takes: w.takes ?? "both", mergeKept: w.mergeKept ?? 0 } });

const toBody = (d: Draft) => ({
  name: d.name.trim(),
  companyIds: d.companyIds,
  slots: Number(d.slots),
  checkThreads: d.threads.trim() ? Number(d.threads) : null,
  checkMemoryMb: d.memoryGb.trim() ? Math.round(Number(d.memoryGb) * 1024) : null,
  takes: d.policy.takes,
  mergeKept: d.policy.takes === "both" ? d.policy.mergeKept : 0,
});

function valid(d: Draft, maxSlots: number) {
  const b = toBody(d);
  return !!b.name && Number.isInteger(b.slots) && b.slots >= 1 && b.slots <= maxSlots && (b.checkThreads === null || (Number.isInteger(b.checkThreads) && b.checkThreads >= 1 && b.checkThreads <= 256)) && (b.checkMemoryMb === null || (b.checkMemoryMb >= 256 && b.checkMemoryMb <= 1_048_576)) && policyValid(d.policy, b.slots);
}

function WorkerForm({ draft, setDraft, companies, maxSlots, idPrefix, machineMb }: { draft: Draft; setDraft: (d: Draft) => void; companies: Company[]; maxSlots: number; idPrefix: string; machineMb?: number | null }) {
  // BOS-2217: as the owner types, say when the numbers need more than the machine has. Only a worker that has connected reports its memory.
  const slotsNow = Number(draft.slots);
  const typedMb = draft.memoryGb.trim() ? Math.round(Number(draft.memoryGb) * 1024) : null;
  const perCheckMb = typedMb && typedMb > 0 ? typedMb : CHECK_PEAK_MB;
  const gbText = (mb: number) => `${Math.round((mb / 1024) * 10) / 10} GB`; // one decimal, as in checkMemoryWarning, so the two lines agree
  const warning = machineMb && Number.isInteger(slotsNow) && slotsNow >= 1 ? checkMemoryWarning({ slots: slotsNow, perCheckMb: typedMb, machineMb }) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label htmlFor={`${idPrefix}-name`}>Name</label>
      <input id={`${idPrefix}-name`} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. NAS in the hall cupboard" />
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>Companies whose checks it may run</legend>
        {companies.map((c) => (
          <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <input
              type="checkbox"
              checked={draft.companyIds.includes(c.id)}
              onChange={(e) => setDraft({ ...draft, companyIds: e.target.checked ? [...draft.companyIds, c.id] : draft.companyIds.filter((x) => x !== c.id) })}
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${idPrefix}-slots`}>Checks at once on this machine (1 to {maxSlots})</label>
      <input id={`${idPrefix}-slots`} type="number" min={1} max={maxSlots} value={draft.slots} onChange={(e) => setDraft({ ...draft, slots: e.target.value })} style={{ width: 80 }} />
      <SlotSplitFields value={draft.policy} onChange={(policy) => setDraft({ ...draft, policy })} slots={Number(draft.slots) || 1} idPrefix={idPrefix} />
      <label htmlFor={`${idPrefix}-threads`}>Test threads per check (optional)</label>
      <input id={`${idPrefix}-threads`} type="number" min={1} max={256} value={draft.threads} onChange={(e) => setDraft({ ...draft, threads: e.target.value })} style={{ width: 80 }} />
      <label htmlFor={`${idPrefix}-memory`}>Memory limit per check (GB, optional)</label>
      <input id={`${idPrefix}-memory`} type="number" min={0.25} step={0.5} value={draft.memoryGb} onChange={(e) => setDraft({ ...draft, memoryGb: e.target.value })} style={{ width: 80 }} />
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        The most memory Boss Man lets one check use on this machine. It does not give the machine more memory: the machine's total is set where the worker runs (<code>mem_limit</code> in its compose file). Set this to the machine's memory ÷ checks at once.
      </p>
      <p className="muted" style={{ fontSize: 14, margin: 0 }} data-testid="check-worker-memory-machine">
        {machineMb
          ? `This machine has ${gbText(machineMb)}${Number.isInteger(slotsNow) && slotsNow >= 1 ? ` (${slotsNow} check${slotsNow === 1 ? "" : "s"} × ${gbText(perCheckMb)} would need ${gbText(slotsNow * perCheckMb)})` : ""}.`
          : "Not reported yet: redeploy the worker once to see it."}
      </p>
      {warning && (
        <p role="alert" className="tag red" style={{ fontSize: 14 }} data-testid="check-worker-memory-warning">
          {warning} <a href={MEMORY_GUIDE} target="_blank" rel="noreferrer">Check worker guide</a>
        </p>
      )}
      <p className="muted" style={{ fontSize: 14 }}>
        Leave the optional fields empty to let the machine decide. A machine never runs more checks than it says it can, whatever the number here.
      </p>
    </div>
  );
}

export function CheckWorkers({ workers, maxSlots, reload, companyId }: { workers: CheckWorkerView[]; maxSlots: number; reload: () => void; companyId?: string }) {
  const companies = usePoll((signal) => api<Company[]>("/api/companies", { signal }), 60_000, "companies");
  const act = useAction();
  const [adding, setAdding] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [added, setAdded] = useState<{ token: string; commit: string | null; slots: number } | null>(null);
  // BOS-1601: the address the worker dials is the owner's pick from the addresses Boss Man knows, not just the page's own.
  const hostFacts = usePoll((signal) => api<HostFactsView>("/api/host-facts", { signal }), 60_000, "host-facts-workers");
  const choices = workerAddressChoices({ origin: window.location.origin, facts: hostFacts.data?.facts });
  const [picked, setPicked] = useState<string | null>(null);
  const choice = choices.find((c) => c.url === picked) ?? choices[0];
  const workerUrl = choice?.url ?? workerSocketUrl(window.location.origin);
  const list = companies.data ?? [];
  const statsPoll = usePoll((signal) => api<MachineStatsView[]>(`/api/settings/check-workers/stats${companyId ? `?companyId=${companyId}` : ""}`, { signal }), 60_000, `check-worker-stats-${companyId ?? ""}`);
  const statsOf = (machine: string) => (Array.isArray(statsPoll.data) ? statsPoll.data.find((s) => s.machine === machine) : undefined);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const linePoll = usePoll(
    (signal) => api<CheckLineView>(`/api/settings/check-workers/line?tz=${encodeURIComponent(zone)}${companyId ? `&companyId=${companyId}` : ""}`, { signal }),
    60_000,
    `check-line-${companyId ?? ""}`,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="check-workers">
      <h3 style={{ margin: "8px 0 0" }}>Check workers</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Other machines that take checks when the runner's slots are full. A check worker runs checks only: merge checks (the full test run before a ticket lands) and quick checks (before review). It gets no secrets and runs no agents, and code only ever goes onto main from your main Boss Man server, never from a worker. It takes checks when its tools (Node, pnpm, git and so on) match the company's runner, so an ordinary runner update does not stop it. If the tools ever differ, this page says which one and you press Redeploy on that machine.
      </p>
      {linePoll.data && Array.isArray(linePoll.data.kinds) && <CheckLine line={linePoll.data} />}
      {linePoll.error && linePoll.data === null && <LoadError what="the check line's last 7 days" message={linePoll.error.message} onRetry={linePoll.reload} />}
      <div className="card" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }} data-testid="check-runner-record">
        <strong>Company runner</strong>
        <MachineRecord stats={statsOf("runner")} />
      </div>
      {statsPoll.error && statsPoll.data === null && <LoadError what="the machines' last 7 days" message={statsPoll.error.message} onRetry={statsPoll.reload} />}
      {workers.length === 0 && <p className="muted" style={{ fontSize: 14 }}>No check workers yet.</p>}
      {Array.isArray(statsPoll.data) && (
        <div>
          <button
            type="button"
            className="btn"
            onClick={() =>
              download(
                `check-workers-7-days-${csvDay()}.csv`,
                buildCsv(MACHINES_CSV_HEAD, machinesToCsvRows([{ name: "Company runner", connected: true, stats: statsOf("runner") }, ...workers.map((w) => ({ name: w.name, connected: w.connected, stats: statsOf(w.id) }))])),
              )
            }
          >
            Download CSV
          </button>
        </div>
      )}
      {workers.map((w) => (
        <div key={w.id} className="card" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }} data-testid="check-worker">
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong>{w.name}</strong>
            {!w.enabled ? <span className="tag">Off</span> : w.connected ? <span className="tag">Connected</span> : <span className="tag red">Offline</span>}
            <span className="muted" style={{ fontSize: 14 }}>
              {w.limit} check{w.limit === 1 ? "" : "s"} at once{w.reportedSlots !== null && w.reportedSlots < w.slots ? ` (the machine says it can run ${w.reportedSlots})` : ""}
              <span data-testid="check-worker-split">{` · ${policyLine({ takes: w.takes ?? "both", mergeKept: w.mergeKept ?? 0 }, w.limit)}`}</span>
              {w.lastSeenAt ? ` · last seen ${when(w.lastSeenAt)}` : ""}
              {w.toolchain?.node ? ` · Node ${w.toolchain.node}` : w.imageCommit ? ` · version ${w.imageCommit.slice(0, 7)}` : ""}
            </span>
          </div>
          <MachineRecord stats={statsOf(w.id)} />
          {w.memoryWarning && (
            <p style={{ fontSize: 14, margin: 0 }} className="tag red" data-testid="check-worker-memory-card-warning">
              Memory: {w.memoryWarning}
            </p>
          )}
          {w.reason ? (
            <p style={{ fontSize: 14, margin: 0 }} data-testid="check-worker-reason">
              Takes no checks: {w.reason}
            </p>
          ) : (
            <ul style={{ fontSize: 14, margin: 0, paddingLeft: 18 }}>
              {w.companies.length === 0 && <li>Not set up for any company yet.</li>}
              {w.companies.map((c) => (
                <li key={c.id} data-testid="check-worker-company">
                  {c.name}: {c.ready ? "takes checks when the runner is full" : c.reason}
                </li>
              ))}
            </ul>
          )}
          {editing?.id === w.id ? (
            <>
              <WorkerForm draft={editing.draft} setDraft={(draft) => setEditing({ id: w.id, draft })} companies={list} maxSlots={maxSlots} idPrefix={`cw-${w.id}`} machineMb={w.reportedMemoryMb} />
              <div style={{ display: "flex", gap: 8 }}>
                <SaveButton
                  dirty={JSON.stringify(editing.draft) !== JSON.stringify(draftOf(w))}
                  saved={false}
                  busy={act.busy}
                  disabled={!valid(editing.draft, maxSlots)}
                  onClick={() =>
                    void act.run(async () => {
                      await api(`/api/settings/check-workers/${w.id}`, { method: "PATCH", body: toBody(editing.draft) });
                      setEditing(null);
                      reload();
                      return "Saved.";
                    })
                  }
                />
                <button type="button" className="btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setEditing({ id: w.id, draft: draftOf(w) })}
              >
                Change
              </button>
              <button
                type="button"
                className="btn"
                disabled={act.busy}
                onClick={() =>
                  void act.run(async () => {
                    await api(`/api/settings/check-workers/${w.id}`, { method: "PATCH", body: { enabled: !w.enabled } });
                    reload();
                    return w.enabled ? `${w.name} is off. Any check it was running went back in line.` : `${w.name} is on again.`;
                  })
                }
              >
                {w.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={act.busy}
                onClick={() =>
                  window.confirm(`Remove ${w.name}? Its token stops working at once, and any check it is running goes back in line.`) &&
                  void act.run(async () => {
                    await api(`/api/settings/check-workers/${w.id}`, { method: "DELETE" });
                    reload();
                    return `${w.name} was removed.`;
                  })
                }
              >
                Remove
              </button>
            </div>
          )}
        </div>
      ))}
      {added && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="check-worker-token">
          <p>
            <strong>Copy this file now; it holds the worker's token and isn't shown again.</strong> On the worker's machine, save it as <code>compose.yaml</code> in an empty folder (or paste it into a TrueNAS custom app, Portainer or Dockge) and run <code>docker compose up -d</code>. Nothing else to edit, now or after a runner update.
          </p>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} data-testid="check-worker-address">
            <legend>Address the worker uses to reach Boss Man (it must be able to look it up from the worker's machine)</legend>
            {choices.map((c) => (
              <label key={c.url} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <input type="radio" name="cw-address" checked={c.url === workerUrl} onChange={() => setPicked(c.url)} />
                <span>
                  <strong>{c.label}</strong> <code>{c.url}</code>
                  <br />
                  Works from: {c.worksFrom}
                  {c.warning && <><br />{c.warning}</>}
                </span>
              </label>
            ))}
            {!choices.some((c) => c.kind === "lan") && (
              <p data-testid="check-worker-no-lan">Boss Man's host did not report a local network address, so none is offered. The address below is the one this page is open at; if it is a Tailscale name, only machines on your tailnet can use it. For any other machine, type Boss Man's LAN address into <code>BOSSMAN_URL</code> yourself: <code>ws://&lt;LAN address&gt;:3100/api/check-worker/connect</code>.</p>
            )}
            <p>If the worker's log says "Can't find the address", the worker's machine can't look that name up: pick the local network address, edit <code>BOSSMAN_URL</code> in the file and redeploy.</p>
          </fieldset>
          <pre className="mono codebox" data-testid="check-worker-compose" style={{ maxHeight: 320, overflow: "auto" }}>
            {workerComposeFile({ url: workerUrl, slots: added.slots, token: added.token })}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                void act.run(async () =>
                  copyMessage(await copyText(workerComposeFile({ url: workerUrl, slots: added.slots, token: added.token })), "Compose file"),
                )
              }
            >
              Copy compose file
            </button>
            <button type="button" className="btn" onClick={() => setAdded(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {adding ? (
        <>
          <WorkerForm draft={adding} setDraft={setAdding} companies={list} maxSlots={maxSlots} idPrefix="cw-new" />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              disabled={act.busy || !valid(adding, maxSlots)}
              onClick={() =>
                void act.run(async () => {
                  const body = { ...toBody(adding), enabled: true };
                  const r = await api<{ id: string; token: string; commit?: string | null }>("/api/settings/check-workers", { method: "POST", body });
                  setAdded({ token: r.token, commit: r.commit ?? null, slots: body.slots });
                  setAdding(null);
                  reload();
                })
              }
            >
              Add
            </button>
            <button type="button" className="btn" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div>
          <button type="button" className="btn" onClick={() => setAdding(blank)}>
            Add a check worker
          </button>
        </div>
      )}
      {act.view}
    </div>
  );
}
