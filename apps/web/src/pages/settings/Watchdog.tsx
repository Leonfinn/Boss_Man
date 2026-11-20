import { useEffect, useState } from "react";
import { WATCHDOG_RULE_LABEL, type WatchdogRule, type WatchdogSettings } from "@boss-man/shared";
import { api, type Company } from "../../api";
import { when } from "../Runs";
import { Section, useAction } from "./shared";
import { SaveButton } from "../../components/SaveButton";
import { Advanced, PresetCards } from "../../components/PresetCards";
import { limitsFromDraft, matchPreset, WATCHDOG_PRESETS, type WatchdogLimits } from "../../lib/presets";

type WatchdogStatus = {
  settings: WatchdogSettings;
  scrumMaster: { id: string; name: string; paused: boolean } | null;
  lastSweepAt: string | null;
  trippedAt: string | null;
  pausedUntil?: string | null;
  trippedReason: string | null;
  openFlags: number;
};
type Backtest = { from: string; to: string; flags: Array<{ ticketId: string; ref: string; title: string; rule: WatchdogRule; firstAt: string; handOffs: number; verdict: string }>; scrumMasterWakes: number; busiestHourWakes: number; wouldTripCap: boolean; caveats: string[] };

/** The limits the owner edits, with their labels and units; `term` is the technical name, shown small after the plain label (BOS-1494). */
const WATCHDOG_LIMITS: Array<{ key: keyof WatchdogSettings; label: string; unit: string; term?: string }> = [
  { key: "inProgressHours", label: "No movement in progress", unit: "hours" },
  { key: "reviewHours", label: "No movement in review", unit: "hours" },
  { key: "blockedHours", label: "Blocked with no movement", unit: "hours" },
  { key: "unassignedMinutes", label: "Unassigned work", unit: "minutes" },
  { key: "blockedUntilGraceHours", label: "Wait after a 'blocked until' time has passed", unit: "hours", term: "grace" },
  { key: "ownerDecisionHours", label: "Remind me about a decision after", unit: "hours" },
  { key: "reviewBounces", label: "Review loop after more than", unit: "send-backs" },
  { key: "maxSmRunsPerHour", label: "Most Scrum Master runs per hour", unit: "runs" },
  { key: "maxNudgesPerHour", label: "Most Scrum Master actions per hour", unit: "actions" },
  { key: "alertMinutes", label: "Move an alert up a level after", unit: "minutes" },
  { key: "maxCeoAlertsPerHour", label: "Most alerts sent to the CEO per hour", unit: "alerts" },
  { key: "silentSteerMinutes", label: "Ask a silent run for a status after", unit: "minutes" },
  { key: "silentFlagMinutes", label: "Flag a silent run to the Scrum Master after", unit: "minutes" },
  { key: "unprovenHours", label: "Flag a cause nobody has proved after", unit: "hours", term: "likely" },
  { key: "idleAgentMinutes", label: "Wake an agent again when its in-progress work has had no run for", unit: "minutes" },
  { key: "spareCapacityMinutes", label: "Tell the CEO the company is under-used after", unit: "minutes" },
];

/** The Scrum Master watchdog (BOS-58): who it wakes, its limits, its safety cap, and a test against past days. */
export function Watchdog({ company }: { company: Company }) {
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [sm, setSm] = useState("");
  const [bt, setBt] = useState<Backtest | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const act = useAction();
  const test = useAction();
  const load = async () => {
    const s = await api<WatchdogStatus>(`/api/companies/${company.id}/watchdog`);
    setStatus(s);
    setDraft(Object.fromEntries(WATCHDOG_LIMITS.map((l) => [l.key, String(s.settings[l.key])])));
    setSm(s.scrumMaster?.id ?? "");
  };
  useEffect(() => {
    void load().catch(() => setStatus(null));
  }, [company.id]);
  if (!status) return null;
  const candidates = company.agents.filter((a) => a.role !== "ceo" && (!a.duty || a.duty === "scrum_master"));
  const save = (extra: Record<string, unknown>) =>
    act.run(async () => {
      const limits = Object.fromEntries(WATCHDOG_LIMITS.map((l) => [l.key, Number(draft[l.key])]));
      await api(`/api/companies/${company.id}/watchdog`, { method: "PATCH", body: { ...limits, scrumMasterAgentId: sm || null, ...extra } });
      await load();
      setSavedOk(true);
      return "Saved.";
    });
  const dirty = sm !== (status.scrumMaster?.id ?? "") || WATCHDOG_LIMITS.some((l) => (draft[l.key] ?? "") !== String(status.settings[l.key]));
  const preset = matchPreset(limitsFromDraft(draft) as WatchdogLimits, WATCHDOG_PRESETS);
  const on = status.settings.enabled;
  const recordOnly = status.settings.recordOnly;
  return (
    <Section id="watchdog-h" title="Watchdog">
      <p className="muted" style={{ fontSize: 14 }}>
        Every few minutes Boss Man checks the board with simple rules (no AI, no cost) and wakes the Scrum Master only when something looks stuck. The Scrum Master can only nudge, assign unassigned work, re-wake, chase a review, snooze, escalate to the CEO or ask you; every action is logged and can be undone.
      </p>
      <p role="status" style={{ fontSize: 14 }}>
        {status.pausedUntil
          ? `Paused after hitting its hourly limit (${status.trippedReason}). It resumes by itself ${when(status.pausedUntil)}; nothing to do.`
          : status.trippedAt && !on
          ? `Switched itself off ${when(status.trippedAt)}: ${status.trippedReason}. Look at its recent actions, then switch it back on.`
          : on
            ? `On${recordOnly ? " (record only: it writes down what it would do and reaches nobody)" : ""}. Last check ${status.lastSweepAt ? when(status.lastSweepAt) : "not yet"} · ${status.openFlags} open issue${status.openFlags === 1 ? "" : "s"}.`
            : "Off."}
      </p>
      {/* Record-only mode (BOS-166): a rehearsal day, written down and sent to nobody. */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <input id="wd-record" type="checkbox" checked={recordOnly} onChange={(e) => void save({ recordOnly: e.target.checked })} style={{ marginTop: 4 }} />
        <label htmlFor="wd-record" style={{ maxWidth: 720 }}>
          <strong>Record only (rehearse)</strong>:{" "}
          <span className="muted">
            The watchdog still checks the board and keeps its warnings up to date, but it writes down what it would have done and reaches nobody: no wake, nudge, assignment, escalation or reminder to you, and its hourly limits aren’t used. The log and the daily summary mark these as not sent. Untick this to let it act again from the next check.
          </span>
        </label>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="wd-sm">Scrum Master</label>
        <select id="wd-sm" value={sm} onChange={(e) => setSm(e.target.value)}>
          <option value="">Nobody</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      {/* Presets (BOS-1493): picking one fills the limits below; nothing is saved until Save. */}
      <PresetCards label="Watchdog preset" presets={WATCHDOG_PRESETS} active={preset} onPick={(p) => setDraft({ ...draft, ...Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, String(v)])) })} />
      <Advanced storeKey="watchdog" forceOpen={!preset} summary={preset ? `The ${WATCHDOG_LIMITS.length} limits behind ${preset.name}.` : "Your own limits: edit them or pick a card."}>
        <div className="wd-limits" style={{ marginTop: 8 }}>
          {WATCHDOG_LIMITS.map((l) => (
            <div key={l.key} style={{ display: "contents" }}>
              <label htmlFor={`wd-${l.key}`}>
                {l.label}
                {l.term && (
                  <>
                    {" "}
                    <code className="mono">{l.term}</code>
                  </>
                )}
              </label>
              <input id={`wd-${l.key}`} type="number" min={0} value={draft[l.key] ?? ""} onChange={(e) => setDraft({ ...draft, [l.key]: e.target.value })} />
              <span className="muted">{l.unit}</span>
            </div>
          ))}
        </div>
      </Advanced>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <SaveButton dirty={dirty} saved={savedOk} busy={act.busy} onClick={() => void save({})} />
        <button type="button" className="btn" disabled={act.busy || (!on && !sm)} onClick={() => void save({ enabled: !on })}>
          {on ? "Switch off" : status.trippedAt ? "Switch back on" : "Switch on"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={test.busy}
          onClick={() =>
            void test.run(async () => {
              setBt(await api<Backtest>(`/api/companies/${company.id}/watchdog/backtest?days=2`));
            })
          }
        >
          Test on the past 48 hours
        </button>
      </div>
      {act.view}
      {test.view}
      {bt && (
        <div style={{ fontSize: 14 }}>
          <p>
            It would have raised {bt.flags.length} flag{bt.flags.length === 1 ? "" : "s"} and woken the Scrum Master {bt.scrumMasterWakes} time{bt.scrumMasterWakes === 1 ? "" : "s"} (at most {bt.busiestHourWakes} in one hour{bt.wouldTripCap ? ", which would have tripped the safety cap" : ""}).{" "}
            {bt.flags.filter((f) => f.verdict === "cleared within 30 min").length} cleared by themselves within 30 minutes, so may not have needed it.
          </p>
          {bt.flags.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Problem</th>
                  <th>First seen</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {bt.flags.map((f) => (
                  <tr key={`${f.ticketId}-${f.rule}-${f.firstAt}`}>
                    <td>
                      <a href={`#/tickets/${f.ticketId}`}>{f.ref}</a> {f.title}
                    </td>
                    <td>{WATCHDOG_RULE_LABEL[f.rule]}</td>
                    <td>{when(f.firstAt)}</td>
                    <td>{f.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul className="muted">
            {bt.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
