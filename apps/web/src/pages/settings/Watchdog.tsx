import { useEffect, useState } from "react";
import { WATCHDOG_RULE_LABEL, watchdogLimitRule, type WatchdogRule, type WatchdogSettings } from "@boss-man/shared";
import { api, type Company } from "../../api";
import { when } from "../Runs";
import { Section, useAction } from "./shared";
import { Loader } from "../../components/Loader";
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

const BACKTEST_PERIODS = [
  { days: 2, label: "Past 48 hours" },
  { days: 7, label: "Past 7 days" },
  { days: 14, label: "Past 14 days" },
];
const CLEARED = "cleared within 30 min";

/** One row per problem type: how many flags and how many cleared by themselves, most flags first. */
export function problemCounts(flags: Backtest["flags"]): Array<{ rule: WatchdogRule; flags: number; cleared: number }> {
  const by = new Map<WatchdogRule, { rule: WatchdogRule; flags: number; cleared: number }>();
  for (const f of flags) {
    const row = by.get(f.rule) ?? { rule: f.rule, flags: 0, cleared: 0 };
    row.flags += 1;
    if (f.verdict === CLEARED) row.cleared += 1;
    by.set(f.rule, row);
  }
  return [...by.values()].sort((a, b) => b.flags - a.flags);
}

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

function rangeText(key: keyof WatchdogSettings): string {
  const l = WATCHDOG_LIMITS.find((x) => x.key === key)!;
  const rule = watchdogLimitRule(key);
  return rule ? `"${l.label}" must be ${rule.whole ? "a whole number " : ""}from ${rule.min} to ${rule.max} ${l.unit}.` : `"${l.label}" isn't allowed.`;
}

/** Says in plain words what is wrong with a box's text, or null when it is fine; the range comes from the shared schema. */
function limitProblem(key: keyof WatchdogSettings, text: string): string | null {
  const l = WATCHDOG_LIMITS.find((x) => x.key === key);
  const rule = watchdogLimitRule(key);
  if (!l || !rule) return null;
  const name = l.label;
  if (text.trim() === "") return `Type a number for "${name}".`;
  const n = Number(text);
  if (!Number.isFinite(n)) return `"${name}" must be a number.`;
  if (rule.whole && !Number.isInteger(n)) return `"${name}" must be a whole number, from ${rule.min} to ${rule.max} ${l.unit}.`;
  if (n < rule.min || n > rule.max) return `"${name}" must be from ${rule.min} to ${rule.max} ${l.unit}.`;
  return null;
}

/** The Scrum Master watchdog (BOS-58): who it wakes, its limits, its safety cap, and a test against past days. */
export function Watchdog({ company }: { company: Company }) {
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [sm, setSm] = useState("");
  const [bt, setBt] = useState<Backtest | null>(null);
  const [days, setDays] = useState(2);
  const [btDays, setBtDays] = useState(2);
  const [hideCleared, setHideCleared] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const act = useAction();
  const test = useAction();
  const load = async () => {
    const s = await api<WatchdogStatus>(`/api/companies/${company.id}/watchdog`);
    setStatus(s);
    setDraft(Object.fromEntries(WATCHDOG_LIMITS.map((l) => [l.key, String(s.settings[l.key])])));
    setSm(s.scrumMaster?.id ?? "");
  };
  useEffect(() => {
    setLoadError(null);
    void load().catch((e: unknown) => {
      setStatus(null);
      setLoadError(e instanceof Error ? e.message : "Could not load the watchdog.");
    });
  }, [company.id]);
  if (!status) {
    return (
      <Section id="watchdog-h" title="Watchdog">
        {loadError ? <p className="error" role="alert">{loadError}</p> : <Loader label="Loading the watchdog" />}
      </Section>
    );
  }
  const candidates = company.agents.filter((a) => a.role !== "ceo" && (!a.duty || a.duty === "scrum_master"));
  const save = (extra: Record<string, unknown>) => {
    // Check every box first, so the owner is told which one and why (BOS-2163).
    const found = Object.fromEntries(WATCHDOG_LIMITS.flatMap((l) => {
      const msg = limitProblem(l.key, draft[l.key] ?? "");
      return msg ? [[l.key, msg]] : [];
    }));
    setProblems(found);
    if (Object.keys(found).length) {
      setSavedOk(false);
      return Promise.resolve(act.run(async () => { throw new Error(`${Object.keys(found).length === 1 ? "One limit needs" : "Some limits need"} fixing before it can be saved: see the red text beside ${Object.keys(found).length === 1 ? "it" : "them"}.`); }));
    }
    return act.run(async () => {
      const limits = Object.fromEntries(WATCHDOG_LIMITS.map((l) => [l.key, Number(draft[l.key])]));
      try {
        await api(`/api/companies/${company.id}/watchdog`, { method: "PATCH", body: { ...limits, scrumMasterAgentId: sm || null, ...extra } });
      } catch (err) {
        // A server 422 reads "unassignedMinutes: Number must be…"; show each part beside its box instead.
        const back: Record<string, string> = {};
        for (const part of (err as Error).message.split("; ")) {
          const m = /^(\w+): /.exec(part);
          const l = m && WATCHDOG_LIMITS.find((x) => x.key === m[1]);
          if (l) back[l.key] = limitProblem(l.key, draft[l.key] ?? "") ?? rangeText(l.key);
        }
        if (Object.keys(back).length) {
          setProblems(back);
          throw new Error("One or more limits need fixing before it can be saved: see the red text beside them.");
        }
        throw err;
      }
      setProblems({});
      await load();
      setSavedOk(true);
      return "Saved.";
    });
  };
  const shown = bt ? (hideCleared ? bt.flags.filter((f) => f.verdict !== CLEARED) : bt.flags) : [];
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
      <Advanced storeKey="watchdog" forceOpen={!preset || Object.keys(problems).length > 0} summary={preset ? `The ${WATCHDOG_LIMITS.length} limits behind ${preset.name}.` : "Your own limits: edit them or pick a card."}>
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
              <input
                id={`wd-${l.key}`}
                type="number"
                min={watchdogLimitRule(l.key)?.min}
                max={watchdogLimitRule(l.key)?.max}
                step={watchdogLimitRule(l.key)?.whole ? 1 : "any"}
                value={draft[l.key] ?? ""}
                aria-invalid={problems[l.key] ? true : undefined}
                aria-describedby={problems[l.key] ? `wd-${l.key}-err` : undefined}
                onChange={(e) => {
                  setDraft({ ...draft, [l.key]: e.target.value });
                  if (problems[l.key]) setProblems(Object.fromEntries(Object.entries(problems).filter(([k]) => k !== l.key)));
                }}
              />
              <span className="muted">{l.unit}</span>
              {problems[l.key] && (
                <span id={`wd-${l.key}-err`} className="error" role="alert" style={{ gridColumn: "1 / -1", fontSize: 13 }}>
                  {problems[l.key]}
                </span>
              )}
            </div>
          ))}
        </div>
      </Advanced>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <SaveButton dirty={dirty} saved={savedOk} busy={act.busy} onClick={() => void save({})} />
        <button type="button" className="btn" disabled={act.busy || (!on && !sm)} onClick={() => void save({ enabled: !on })}>
          {on ? "Switch off" : status.trippedAt ? "Switch back on" : "Switch on"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="wd-period">Test the rules against</label>
        <select id="wd-period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {BACKTEST_PERIODS.map((p) => (
            <option key={p.days} value={p.days}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={test.busy}
          onClick={() =>
            void test.run(async () => {
              const ran = days;
              setBt(await api<Backtest>(`/api/companies/${company.id}/watchdog/backtest?days=${ran}`));
              setBtDays(ran);
            })
          }
        >
          Run the test
        </button>
      </div>
      {act.view}
      {test.view}
      {bt && (
        <div style={{ fontSize: 14 }}>
          <p>
            Over the {BACKTEST_PERIODS.find((p) => p.days === btDays)?.label.toLowerCase() ?? `past ${btDays} days`} it would have raised {bt.flags.length} flag{bt.flags.length === 1 ? "" : "s"} and woken the Scrum Master {bt.scrumMasterWakes} time{bt.scrumMasterWakes === 1 ? "" : "s"} (at most {bt.busiestHourWakes} in one hour{bt.wouldTripCap ? ", which would have tripped the safety cap" : ""}).{" "}
            {bt.flags.filter((f) => f.verdict === CLEARED).length} cleared by themselves within 30 minutes, so may not have needed it.
          </p>
          {bt.flags.length > 0 && (
            <>
              <ul aria-label="Flags by problem" style={{ margin: "4px 0" }}>
                {problemCounts(bt.flags).map((c) => (
                  <li key={c.rule}>
                    <strong>{WATCHDOG_RULE_LABEL[c.rule]}</strong>: {c.flags} flag{c.flags === 1 ? "" : "s"}, {c.cleared} cleared by themselves within 30 minutes
                  </li>
                ))}
              </ul>
              <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0" }}>
                <input id="wd-hide-cleared" type="checkbox" checked={hideCleared} onChange={(e) => setHideCleared(e.target.checked)} />
                <label htmlFor="wd-hide-cleared">Hide ones that cleared by themselves</label>
              </div>
            </>
          )}
          {shown.length > 0 && (
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
                {shown.map((f) => (
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
