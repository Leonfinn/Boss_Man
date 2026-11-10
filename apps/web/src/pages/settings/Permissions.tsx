import { useEffect, useState, type FormEvent } from "react";
import { FENCE_OFF_CONSEQUENCE, SECOND_OPINION_PRESETS } from "@boss-man/shared";
import { api, type Company } from "../../api";
import { usePoll } from "../../hooks";
import { when } from "../Runs";
import { SaveButton, useSaveState } from "../../components/SaveButton";
import { Section, useAction } from "./shared";

type FenceStatus = { registered: boolean; sandbox?: { level: "full" | "partial" | "unavailable"; missing: string[]; probe: boolean | null; guard?: { state: "on" | "absent"; reason: string } } | null; sandboxCheckedAt?: string | null };

/** The agent fence (BOS-325): off, watch or enforce, with this host's fence level. A refusal by the fence is wording on the card, never a decision. */
export function FenceSetting({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const act = useAction();
  const status = usePoll((signal) => api<FenceStatus>(`/api/companies/${company.id}/runner`, { signal }), 30_000, `fence-${company.id}`);
  const mode = company.fenceMode ?? "off";
  const sb = status.data?.sandbox ?? null;
  const hostLine = !status.data?.registered
    ? "This company has no runner yet."
    : !sb
      ? "This host hasn't reported its fence level yet. It reports each time the runner starts."
      : sb.level === "unavailable"
        ? "This host can't fence agents (its kernel doesn't offer Landlock, or the container blocks it). Agents run as before."
        : `This host fences agents ${sb.level === "full" ? "fully" : "partly"}${sb.missing.length ? ` (not covered: ${sb.missing.join(", ")})` : ""}.${sb.probe === false ? " Its self-test did not see a write outside the agent's folders refused." : ""} Last checked ${status.data?.sandboxCheckedAt ? when(status.data.sandboxCheckedAt) : "never"}.`;
  // What the fence means for runs reading each other (BOS-555): said plainly, so Off never looks safe.
  const isolationLine =
    mode === "off" || sb?.level === "unavailable"
      ? "Agent runs are not isolated: one run can read another run's memory and start-up keys."
      : !sb
        ? null
        : sb.level === "partial"
          ? "Agent runs are isolated from each other, except that one run can send signals to another (this host's kernel is older than 6.12)."
          : "Agent runs are isolated from each other.";
  // Off is never left looking like a safe default (BOS-940): say why it is Off and what it means.
  const offLine =
    mode !== "off"
      ? null
      : company.fenceModeChosenAt
        ? `You chose Off. ${FENCE_OFF_CONSEQUENCE}`
        : sb?.level === "unavailable"
          ? `The fence is Off because this host can't fence agents. ${FENCE_OFF_CONSEQUENCE}`
          : `Nobody chose Off: it was Boss Man's old default. ${FENCE_OFF_CONSEQUENCE}`;
  return (
    <Section id="fence-h" title="Agent fence">
      <p className="muted" style={{ fontSize: 14 }}>
        The fence is a kernel limit on what an agent's commands can touch: its own folders and nothing else. It doesn't ask you anything and doesn't change which permission cards appear. When it refuses something the agent just sees "Permission denied", and Boss Man writes that to its permission log.
      </p>
      <p style={{ fontSize: 14 }}>{hostLine}</p>
      {sb?.guard ? (
        <p style={{ fontSize: 14 }} data-testid="network-guard-line">
          {sb.guard.state === "on"
            ? "Network guard: on. The runner tried to reach its own gateway and was refused at once."
            : `Network guard: absent. The runner's own gateway was not refused (${sb.guard.reason}), so private addresses on this network are not blocked.`}
        </p>
      ) : sb ? (
        <p className="muted" style={{ fontSize: 14 }}>Network guard: not reported yet (this runner is older than the check).</p>
      ) : null}
      {isolationLine && <p style={{ fontSize: 14 }}>{isolationLine}</p>}
      {offLine && <p style={{ fontSize: 14 }}>{offLine}</p>}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="fence-mode">Fence</label>
        <select
          id="fence-mode"
          value={mode}
          disabled={act.busy}
          onChange={(e) => {
            const fenceMode = e.target.value;
            // Off is the owner's explicit choice, made after reading what it means (BOS-940).
            if (fenceMode === "off" && !window.confirm(`Turn the agent fence off? ${FENCE_OFF_CONSEQUENCE} Agent runs can also read each other's memory and start-up keys.`)) return;
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { fenceMode } });
              onChanged();
              return "Saved. It applies to runs that start from now on.";
            });
          }}
        >
          <option value="off">Off: agents run unfenced</option>
          <option value="watch" disabled={sb?.level === "unavailable" && mode !== "watch"}>
            {sb?.level === "unavailable" ? "Watch: not available, this host can't fence agents" : "Watch: agents run inside the fence and every refusal is logged"}
          </option>
          <option value="enforce" disabled>
            Enforce: not available yet (waiting for a security fix, BOS-323)
          </option>
        </select>
      </div>
      <details style={{ marginTop: 10 }}>
        <summary>Setting up a host</summary>
        <ul style={{ fontSize: 14 }}>
          <li>The fence needs a Linux kernel with Landlock (5.19 or newer, and 6.12 or newer for full cover). Most current Docker hosts have it; TrueNAS, a Proxmox VM and a plain Linux machine all work if the kernel does.</li>
          <li>The runner tests the fence each time it starts. If this page says "can't fence", update the host's kernel, or check that the container's security profile doesn't block Landlock, then restart the runner.</li>
          <li>A fenced agent has its own temporary folder for each run and can't write to the shared /tmp. A skill that hard-codes /tmp needs to use the folder in $TMPDIR instead.</li>
          <li>Start with Watch on one company, look at the permission log after a few days, and fix what it shows before anything stricter.</li>
        </ul>
      </details>
      {act.view}
    </Section>
  );
}

type SecondOpinion = { enabled: boolean; baseUrl: string; model: string; secretId: string | null };
type SecondOpinionStats = { answered: number; allowed: number; denied: number; fellBack: number; pending: number; reasons: Array<{ reason: string; count: number }> };

const cards = (n: number) => `${n} card${n === 1 ? "" : "s"}`;

/** BOS-1052: whether the model is really answering, from the last 24 h of cards. */
function SecondOpinionLast24h({ stats }: { stats: SecondOpinionStats | undefined }) {
  if (!stats) return null;
  const total = stats.answered + stats.fellBack;
  if (total === 0) return <p className="muted" style={{ fontSize: 14 }}>Last 24 hours: the model wasn't asked about any cards.</p>;
  return (
    <div style={{ fontSize: 14 }}>
      <p style={{ margin: 0 }}>
        <strong>Last 24 hours:</strong> the model answered {cards(stats.answered)} ({stats.allowed} allow, {stats.denied} deny); {cards(stats.fellBack)} fell back to the rules judge alone.
      </p>
      {stats.reasons.length > 0 && (
        <ul style={{ margin: "4px 0", paddingLeft: 20 }} className="muted">
          {stats.reasons.map((r) => (
            <li key={r.reason}>
              {r.count}× {r.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The optional model second opinion on permission cards (BOS-338): off by default. The key is a secret from the encrypted store. */
export function SecondOpinionSetting({ company }: { company: Company }) {
  const cur = usePoll((signal) => api<SecondOpinion>(`/api/companies/${company.id}/second-opinion`, { signal }), 600_000, `second-${company.id}`);
  const secrets = usePoll((signal) => api<Array<{ id: string; name: string }>>("/api/secrets", { signal }), 600_000, "secrets");
  const stats = usePoll((signal) => api<SecondOpinionStats>(`/api/companies/${company.id}/second-opinion/stats`, { signal }), 60_000, `second-stats-${company.id}`);
  const [v, setV] = useState<SecondOpinion | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sv = useSaveState(v);
  // Only the first load fills the form, so a background refresh never overwrites an edit in progress.
  useEffect(() => {
    if (!cur.data || v) return;
    setV(cur.data);
    sv.reset(cur.data);
  }, [cur.data]);
  if (!v) return null;
  const judgeOff = (company.permissionJudge ?? "watch") === "off";
  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    api(`/api/companies/${company.id}/second-opinion`, { method: "PUT", body: v })
      .then(
        () => (sv.markSaved(), setMsg("Saved.")),
        (err: Error) => setMsg(err.message),
      )
      .finally(() => setBusy(false));
  };
  const test = () => {
    setBusy(true);
    setMsg("Asking the model…");
    api<{ ok: boolean; message: string }>(`/api/companies/${company.id}/second-opinion/test`, { method: "POST", body: v })
      .then(
        (r) => setMsg(r.message),
        (err: Error) => setMsg(err.message),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Section id="second-opinion-h" title="Second opinion from a model (optional)">
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ fontSize: 14 }}>
          Off by default. When it's on, a card the rules above would suggest allowing is also shown to a model you pick. It can only make the advice stricter: a card is suggested Allow only when both agree. If the model is slow (over 5 seconds), down, busy, out of credit or gives an answer Boss Man can't read, the rules decide alone. It never presses a button. The card's text is sent to the provider, with tokens, keys and passwords removed first.
        </p>
        {judgeOff && <p className="muted" style={{ fontSize: 14 }}>Advice on permission cards is off, so the model isn't asked. Set it to Watch or Advise first.</p>}
        <label>
          <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Ask a model for a second opinion
        </label>
        <div>
          <strong style={{ fontSize: 14 }}>Suggested models</strong> <span className="muted" style={{ fontSize: 14 }}>(from our test on 203 real cards; click one to fill in the fields)</span>
          <ul style={{ margin: "6px 0", paddingLeft: 20, fontSize: 14 }}>
            {SECOND_OPINION_PRESETS.map((p) => (
              <li key={p.label}>
                <button type="button" className="linkish" onClick={() => setV({ ...v, baseUrl: p.baseUrl, model: p.model })}>
                  {p.label}
                </button>{" "}
                <span className="muted">— {p.note}</span>
              </li>
            ))}
          </ul>
          <small className="muted">Decision models such as Jev, d3 and the others that only return a score don't work for this: they can't tell safe from unsafe reliably and give no reason. Use a chat model.</small>
        </div>
        <div className="field">
          <label htmlFor="second-url">Provider address</label>
          <input id="second-url" value={v.baseUrl} placeholder="https://openrouter.ai/api/v1" onChange={(e) => setV({ ...v, baseUrl: e.target.value })} />
          <small className="muted">Any OpenAI-compatible service (it must accept /chat/completions): OpenRouter, Synthetic, or your own server such as Ollama.</small>
        </div>
        <div className="field">
          <label htmlFor="second-model">Model</label>
          <input id="second-model" value={v.model} placeholder="openai/gpt-oss-safeguard-20b" onChange={(e) => setV({ ...v, model: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="second-key">API key</label>
          <select id="second-key" value={v.secretId ?? ""} onChange={(e) => setV({ ...v, secretId: e.target.value || null })}>
            <option value="">None (a local server)</option>
            {(secrets.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          {!v.secretId && <small className="muted">Add the key under Secrets first, then pick it here.</small>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <SaveButton {...sv} busy={busy} />
          <button type="button" className="btn" disabled={busy || !v.baseUrl || !v.model} onClick={test}>
            Test
          </button>
        </div>
        {msg && <p role="status">{msg}</p>}
        {(cur.data?.enabled || (stats.data && stats.data.answered + stats.data.fellBack > 0)) && <SecondOpinionLast24h stats={stats.data ?? undefined} />}
      </form>
    </Section>
  );
}

/** The company's hourly nudge limit (BOS-73). */
export function NudgeCap({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [cap, setCap] = useState(String(company.nudgesPerHour ?? 30));
  const act = useAction();
  const n = Number(cap);
  const valid = Number.isInteger(n) && n >= 1 && n <= 1000;
  return (
    <Section id="nudge-cap-h" title="Nudges">
      <p className="muted" style={{ fontSize: 14 }}>
        Agents nudge each other to hand over work or ask a question, and each nudge wakes the colleague. Past this many in an hour, they write on the ticket instead. The Scrum Master's nudges have their own limit under Watchdog.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="nudge-cap">Nudges per hour</label>
        <input id="nudge-cap" type="number" min={1} max={1000} value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 80 }} />
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { nudgesPerHour: n } });
              onChanged();
              return "Saved.";
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

/** The longest one run may go (BOS-846). Empty means no limit. */
export function RunTimeLimit({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [mins, setMins] = useState(company.maxRunMinutes != null ? String(company.maxRunMinutes) : "");
  const act = useAction();
  const n = Number(mins);
  const empty = mins.trim() === "";
  const valid = empty || (Number.isInteger(n) && n >= 1 && n <= 10_080);
  return (
    <Section id="run-time-limit-h" title="Run time limit">
      <p className="muted" style={{ fontSize: 14 }}>
        Stops any single run that goes longer than this many minutes, the same as pressing Stop, and asks you whether to raise the limit. Leave it empty for no limit. Under about 50 minutes it also stops an agent that is waiting on a full check.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="run-time-limit">Most minutes per run</label>
        <input id="run-time-limit" type="number" min={1} max={10080} step={1} placeholder="No limit" value={mins} onChange={(e) => setMins(e.target.value)} style={{ width: 100 }} />
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { maxRunMinutes: empty ? null : n } });
              onChanged();
              return empty ? "Saved: no limit." : "Saved.";
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
