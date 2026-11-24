import { useState } from "react";
import { RUNNER_ADDONS, type AddonReport } from "@boss-man/shared";
import { api, type Company } from "../../api";
import { copyMessage, copyText } from "../../clipboard";
import { usePoll } from "../../hooks";
import { buildCsv, download } from "../../csv";
import { spanText } from "../../components/TicketStateHistory";
import { when } from "../Runs";
import { Section, useAction } from "./shared";
import type { UpdateRow } from "./updates";

const csvDay = () => new Date().toISOString().slice(0, 10);

/** The runner's container when the launcher runs it (R55); null when the launcher is off. */
type Launched = { slug: string; container: { state: string; status: string; image: string; guard?: "on" | "off" | "unavailable" | "down" | "retrying" | "frozen" } | null; error?: string } | null;
/** BOS-382: "updating" is a planned runner swap; Start, Restart and Stop wait until it is over. */
type RunnerLiveState = "connected" | "updating" | "paused" | "failed" | "offline" | "none";
type CompanyReport = { live: { ok: boolean; text: string; state?: RunnerLiveState }; last: UpdateRow | null };
const liveTag = (l: CompanyReport["live"]) => (l.state === "updating" ? "tag amber" : l.ok ? undefined : "tag red");
type RunnerStatus = ({ registered: false; report?: CompanyReport | null } | { registered: true; runnerId: string; connected: boolean; connection?: ConnectionHistory; lastSeenAt: string | null; imageVersion: string | null; diskUsedBytes: number | null; addons: AddonReport[] | null; sandbox?: { guard?: { state: "on" | "absent"; reason: string } } | null; safety?: Safety; report?: CompanyReport | null }) & { launcher?: Launched };

/** BOS-1583: what the host knows of the add-on choice: the owner's saved ticks, and what the last build held (null = no file). */
type AddonSelection = { enabled: boolean; saved: string[] | null; built: string[] | null };
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function RunnerAddons({ report }: { report: AddonReport[] | null }) {
  const sel = usePoll((signal) => api<AddonSelection>("/api/self-deploy/runner-addons", { signal }), 30_000, "runner-addons");
  const act = useAction();
  const [edit, setEdit] = useState<string[] | null>(null);
  const known = RUNNER_ADDONS.map((a) => a.id);
  const choice = sel.data && typeof sel.data === "object" && "enabled" in sel.data ? sel.data : null;
  // Where the boxes start: the saved choice, else what the last build held, else what the runner reports (an install set up
  // by hand in .env before this panel existed), so the first save never drops an add-on that is already there.
  const start = (choice?.saved ?? choice?.built ?? (report ?? []).map((r) => r.id)).filter((id) => known.includes(id));
  const ticked = edit ?? start;
  const installed = (report ?? []).map((r) => r.id).filter((id) => known.includes(id));
  const enabled = choice?.enabled === true;
  // No saved choice, no build record and no runner report (offline): the starting set is unknown, and a save would store
  // an empty choice that drops add-ons set by hand in .env. Hold the boxes and Save until it is known (BOS-1656).
  const unknownStart = enabled && choice?.saved == null && choice?.built == null && report == null;
  const dirty = edit !== null && !sameSet(edit, start);
  // The choice differs from what the runner has now: it takes effect at the next Build and update runners.
  const waiting = !dirty && enabled && choice?.saved != null && !sameSet(choice.saved.filter((id) => known.includes(id)), installed);
  const toggle = (id: string, on: boolean) => setEdit((on ? [...ticked, id] : ticked.filter((x) => x !== id)).filter((x, i, all) => all.indexOf(x) === i));
  const save = () =>
    act.run(async () => {
      await api("/api/self-deploy/runner-addons", { method: "PUT", body: { ids: ticked } });
      setEdit(null);
      sel.reload();
      return "Saved. The next Build and update runners (Settings → Server and runner → Updates) builds the runner with exactly these add-ons, and keeps them on every update after that.";
    });
  return (
    <div data-testid="runner-addons">
      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Add-ons</h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {RUNNER_ADDONS.map((a) => {
          const r = report?.find((x) => x.id === a.id);
          return (
            <li key={a.id}>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input type="checkbox" checked={ticked.includes(a.id)} disabled={!enabled || unknownStart || act.busy} onChange={(e) => toggle(a.id, e.target.checked)} />
                <strong>{a.title}</strong>
              </label>{" "}
              {r?.ok ? <span className="tag green">Working, {r.version}</span> : r ? <span className="tag red">Not working</span> : <span className="tag">Not installed</span>}
              <p className="muted" style={{ fontSize: 14, margin: "2px 0 0" }}>
                {a.summary}{" "}
                <a href={a.homepage} target="_blank" rel="noopener noreferrer">
                  About it
                </a>
              </p>
              {r && !r.ok && r.detail && <p className="error" style={{ fontSize: 13, margin: "2px 0 0" }}>{r.detail}</p>}
              {!r && ticked.includes(a.id) && (
                <p className="muted" style={{ fontSize: 13, margin: "2px 0 0" }}>
                  Ticked, not built yet. Skills that need it are left out of runs until the runner is rebuilt.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {enabled ? (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <button type="button" className="btn" disabled={!dirty || unknownStart || act.busy} onClick={() => void save()}>
            Save add-ons
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            {unknownStart ? "Can't tell which add-ons are on yet: the runner is offline and nothing has been built or saved. Saving now could drop add-ons you set in .env. This unlocks when the runner connects." : waiting ? "Saved. Not on the runner yet: press Build and update runners (Settings → Server and runner → Updates)." : "Tick the add-ons you want, then save. They are built in the next time you press Build and update runners, and stay on every update after."}
          </span>
        </div>
      ) : (
        sel.data && (
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            Choosing add-ons here needs self-deploy set up on this server.
          </p>
        )
      )}
      {act.view}
    </div>
  );
}

/** The runner's last hello: while connected that is when this connection began. */
function Since({ connected, at }: { connected: boolean; at: string | null }) {
  if (!at) return null;
  return <span className="muted">{connected ? `since ${when(at)}` : `last connected ${when(at)}`}</span>;
}

/** BOS-2459: the last 7 days of the runner's connection: share of time connected, drops, longest gap and the last 10 gaps. */
type ConnectionHistory = {
  since: string | null;
  percentConnected: number | null;
  drops: number;
  longestGapMs: number;
  gaps: Array<{ from: string; to: string | null; ms: number; how: "dropped" | "stopped" | "server restart" | null }>;
  shortGaps: number;
};
const HOW: Record<string, string> = { dropped: "Connection dropped", stopped: "Stopped by you", "server restart": "Boss Man restarted" };

/** The gaps listed (gone, back, length, why), then a blank line and the summary the fold shows. Times are ISO; "back" is empty while still away. */
export function connectionToCsv(h: ConnectionHistory): string {
  const rows = h.gaps.map((g) => [g.from, g.to ?? "", Math.round(g.ms / 1000), spanText(g.ms), g.how ? HOW[g.how] ?? "Connection dropped" : "Connection dropped"]);
  const summary = buildCsv(
    ["percent_connected", "since", "times_dropped", "longest_gap_seconds", "longest_gap", "shorter_gaps_not_listed"],
    [[h.percentConnected ?? "", h.since ?? "", h.drops, Math.round(h.longestGapMs / 1000), h.drops || h.longestGapMs ? spanText(h.longestGapMs) : "none", h.shortGaps]],
  );
  return `${buildCsv(["gone", "back", "length_seconds", "length", "why"], rows)}\r\n${summary}`;
}

export function ConnectionFold({ history }: { history: ConnectionHistory | undefined }) {
  if (!history) return null;
  return (
    <details data-testid="runner-connection">
      <summary style={{ fontSize: 14 }}>Connection, last 7 days{history.percentConnected != null ? `: ${history.percentConnected}% connected` : ""}</summary>
      {history.percentConnected == null ? (
        <p className="muted" style={{ fontSize: 14 }}>History starts from this update: nothing is recorded until the runner next connects.</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Connected</dt>
            <dd>{history.percentConnected}% of the time since {when(history.since!)}</dd>
            <dt>Times it dropped</dt>
            <dd>{history.drops}</dd>
            <dt>Longest gap</dt>
            <dd>{history.drops || history.longestGapMs ? spanText(history.longestGapMs) : "none"}</dd>
          </dl>
          {history.gaps.length === 0 ? (
            <p className="muted" style={{ fontSize: 14 }}>No gaps of 30 seconds or more.</p>
          ) : (
            <table style={{ fontSize: 14 }}>
              <thead>
                <tr>
                  <th>Gone</th>
                  <th>Back</th>
                  <th>Length</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {history.gaps.map((g) => (
                  <tr key={g.from}>
                    <td>{when(g.from)}</td>
                    <td>{g.to ? when(g.to) : "Still away"}</td>
                    <td>{spanText(g.ms)}</td>
                    <td>{g.how ? HOW[g.how] : "Connection dropped"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {history.gaps.length > 0 && (
            <div style={{ margin: "8px 0" }}>
              <button type="button" className="btn" onClick={() => download(`runner-connection-${csvDay()}.csv`, connectionToCsv(history))}>
                Download CSV
              </button>
            </div>
          )}
          {history.shortGaps > 0 && (
            <p className="muted" style={{ fontSize: 14 }}>
              {history.shortGaps} shorter gap{history.shortGaps === 1 ? "" : "s"} (under 30 seconds) counted, not listed.
            </p>
          )}
        </>
      )}
    </details>
  );
}

/**
 * The network guard keeps the runner off private addresses (BOS-324). It is only "on" when its rules are loaded
 * (or the host is known to be able to load them); "off", "unavailable" and "down" mean the runner can reach the
 * home network, so say so plainly and how to fix it (BOS-335, BOS-709).
 */
function GuardWarning({ guard }: { guard: "off" | "unavailable" | "down" }) {
  const what =
    guard === "off"
      ? "The network guard is turned off, so this runner can reach private addresses (your home network and the database)."
      : guard === "down"
        ? "The network guard is down for this runner: it is missing, stopped or out of date, so this runner can reach private addresses (your home network and the database)."
        : "The network guard is unavailable on this host, which can't load firewall rules, so this runner can reach private addresses (your home network and the database).";
  const fix =
    guard === "off"
      ? "Ask your admin to turn the network guard back on for the launcher, then restart the runner."
      : guard === "down"
        ? "The launcher repairs the guard by itself; if this is still shown after a minute, tell your admin."
        : "Ask your admin to make the launcher refuse runners on hosts that can't run the guard.";
  return (
    <p className="error" role="alert" data-testid="guard-warning">
      {what} {fix}
    </p>
  );
}

type Safety = { fingerprint: string | null; fence: { proven: boolean; runWithout: boolean }; guard: { proven: boolean; runWithout: boolean; reason: string | null } } | null;

/**
 * One card per safety feature the runner hasn't proven (DR-049 point 1): agents stay stopped unless the owner chooses
 * to run them without it. The choice is kept with the runner's platform, so a new host or kernel asks again.
 */
export function SafetyCards({ companyId, safety, connected, onChanged }: { companyId: string; safety: Safety | undefined; connected: boolean; onChanged: () => void }) {
  const act = useAction();
  if (!safety) return null;
  const choose = (feature: "guard" | "fence", run: boolean) =>
    act.run(async () => {
      await api(`/api/companies/${companyId}/safety-choice`, { method: "POST", body: { feature, run } });
      onChanged();
      return run ? "Agents will run without it on this host." : "Agents stay stopped until it works.";
    });
  const cards = [
    { feature: "guard" as const, state: safety.guard, name: "network guard", what: "keeps agents off your home network", note: safety.guard.reason ? `The runner's own check says: ${safety.guard.reason}.` : "The runner hasn't proven its network guard yet." },
    { feature: "fence" as const, state: safety.fence, name: "fence", what: "keeps agents out of each other's files and keys", note: "The runner's own check says it can't fence agents (its kernel has no usable Landlock, or the container blocks it)." },
  ].filter((f) => !f.state.proven);
  if (!connected || cards.length === 0) return null;
  return (
    <div data-testid="safety-cards">
      {cards.map((f) => (
        <div key={f.feature} className="card" role="group" aria-label={`Missing: ${f.name}`} data-testid={`safety-card-${f.feature}`} style={{ marginTop: 12 }}>
          <p>
            <strong>This runner has no proven {f.name}.</strong> The {f.name} {f.what}. {f.note}{" "}
            {f.state.runWithout ? "You chose to run agents without it on this host." : "Agents are stopped until it works or you choose otherwise."}
          </p>
          <p className="muted" style={{ fontSize: 13 }}>
            Your choice is kept for this host{safety.fingerprint ? ` (${safety.fingerprint})` : ""}; a new host or kernel asks again.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className={f.state.runWithout ? "btn" : "btn primary"} disabled={act.busy} onClick={() => void choose(f.feature, false)} aria-pressed={!f.state.runWithout}>
              Keep agents stopped
            </button>
            <button type="button" className={f.state.runWithout ? "btn primary" : "btn"} disabled={act.busy} onClick={() => void choose(f.feature, true)} aria-pressed={f.state.runWithout}>
              {f.feature === "guard" ? "Run agents without the network guard" : "Run agents without the fence"}
            </button>
          </div>
        </div>
      ))}
      {act.view}
    </div>
  );
}

export function Runner({ company, onChanged }: { company: Company; onChanged?: () => void }) {
  const status = usePoll((signal) => api<RunnerStatus>(`/api/companies/${company.id}/runner`, { signal }), 10_000, company.id);
  const [token, setToken] = useState<string | null>(null);
  const act = useAction();
  const s = status.data;
  const issue = () =>
    act.run(async () => {
      if (s?.registered && !window.confirm("Issuing a new token disconnects the runner using the old one until you update it. Continue?")) return;
      setToken((await api<{ token: string }>(`/api/companies/${company.id}/runner`, { method: "POST" })).token);
      status.reload();
      onChanged?.();
    });
  // The compose file's first runner reads this file; R55's launcher replaces the copying.
  const file = "secrets/runner-app-co.token";
  const launched = s?.launcher;
  const launch = (method: "POST" | "DELETE", what: "launch" | "restart", done: string) =>
    act.run(async () => {
      await api(`/api/companies/${company.id}/runner/${what}`, { method });
      status.reload();
      onChanged?.();
      return done;
    });
  if (launched) {
    const c = launched.container;
    const connected = s?.registered && s.connected;
    const swapping = s?.report?.live.state === "updating";
    return (
      <Section id="runner-h" title="Runner">
        <p className="muted" style={{ fontSize: 14 }}>
          Boss Man's launcher runs this company's runner as the container <code className="mono">boss-man-runner-{launched.slug}</code>, locked down, with its files under <code className="mono">companies/{launched.slug}</code> in your data folder.
        </p>
        <dl className="facts" role="status">
          <dt>Now</dt>
          <dd data-testid="runner-now">
            {s?.report ? (
              <span className={liveTag(s.report.live)}>{s.report.live.text}</span>
            ) : (
              <>
                {connected ? (
                  <span className="tag green">Connected</span>
                ) : c?.state === "running" ? (
                  <span className="tag amber">Starting…</span>
                ) : c ? (
                  <span className="tag amber">{c.state[0]!.toUpperCase() + c.state.slice(1)}</span>
                ) : (
                  <span className="tag">Not started</span>
                )}{" "}
                {s?.registered && <Since connected={!!connected} at={s.lastSeenAt} />}
              </>
            )}
          </dd>
          {/* Docker's own words, e.g. "Up 14 hours (healthy)": how long the container has run, not the connection. */}
          {c && (
            <>
              <dt>Container</dt>
              <dd>{c.status}</dd>
            </>
          )}
          {s?.registered && s.imageVersion && (
            <>
              <dt>Image</dt>
              <dd className="mono">{s.imageVersion}</dd>
            </>
          )}
          {s?.registered && (
            <>
              <dt>Network guard</dt>
              <dd data-testid="runner-guard-row">
                launcher: {c ? c.guard ?? "not reported" : "no container"} · runner: {s.sandbox?.guard ? (s.sandbox.guard.state === "on" ? "on" : `absent (${s.sandbox.guard.reason})`) : "not reported yet"}
              </dd>
            </>
          )}
        </dl>
        {c && (c.guard === "off" || c.guard === "unavailable" || c.guard === "down") && <GuardWarning guard={c.guard} />}
        <SafetyCards companyId={company.id} safety={s?.registered ? s.safety : null} connected={!!connected} onChanged={status.reload} />
        {launched.error && (
          <p className="error" role="alert">
            {launched.error}
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            type="button"
            className="btn primary"
            disabled={act.busy || swapping}
            title={swapping ? "A runner update is swapping this runner; it starts by itself." : undefined}
            onClick={() => (!c || window.confirm("Reconnect the runner? It gets a new token and a fresh container; work in progress resumes from its journal.")) && void launch("POST", "launch", c ? "Reconnecting…" : "Starting…")}
          >
            {c ? "Reconnect runner" : "Start runner"}
          </button>
          {c && (
            <>
              <button type="button" className="btn" disabled={act.busy || swapping} onClick={() => void launch("POST", "restart", "Restarting…")}>
                Restart
              </button>
              <button type="button" className="btn" disabled={act.busy || swapping} onClick={() => window.confirm("Stop and remove the runner? Its workspaces and sessions stay on disk; agents can't run until it's started again.") && void launch("DELETE", "launch", "Stopped.")}>
                Stop
              </button>
            </>
          )}
        </div>
        {s?.registered && <ConnectionFold history={s.connection} />}
        {s?.registered && <RunnerAddons report={s.addons} />}
        {act.view}
      </Section>
    );
  }
  return (
    <Section id="runner-h" title="Runner">
      {s && !s.registered && <p>This company has no runner yet. A runner is the container its agents work in; it connects out to this server, so it needs no open ports.</p>}
      {s?.registered && (
        <dl className="facts" role="status">
          <dt>Now</dt>
          <dd data-testid="runner-now">
            {s.report ? (
              <span className={liveTag(s.report.live)}>{s.report.live.text}</span>
            ) : (
              <>
                {s.connected ? <span className="tag green">Connected</span> : <span className="tag amber">Offline</span>} <Since connected={s.connected} at={s.lastSeenAt} />
              </>
            )}
          </dd>
          {s.imageVersion && (
            <>
              <dt>Image</dt>
              <dd className="mono">{s.imageVersion}</dd>
            </>
          )}
          {s.diskUsedBytes != null && (
            <>
              <dt>Workspaces</dt>
              <dd>{(s.diskUsedBytes / 1024 ** 3).toFixed(1)} GB</dd>
            </>
          )}
        </dl>
      )}
      {token ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p>
            <strong>Copy this token now; it isn't shown again.</strong> On the server, save it as <code className="mono">{file}</code> next to <code className="mono">docker-compose.yml</code>, readable only by uid 1000, then start the runner.
          </p>
          <pre className="mono codebox">{token}</pre>
          <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => void act.run(async () => copyMessage(await copyText(token), "Token"))}>
            Copy token
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn primary"
          style={{ alignSelf: "flex-start" }}
          disabled={act.busy}
          onClick={() => (!s?.registered || window.confirm("Issue a new token? The current one stops working at once, and the runner stays offline until you save the new token and restart it.")) && void issue()}
        >
          {s?.registered ? "Issue a new runner token" : "Register a runner"}
        </button>
      )}
      {s?.registered && <SafetyCards companyId={company.id} safety={s.safety} connected={s.connected} onChanged={status.reload} />}
      {s?.registered && <ConnectionFold history={s.connection} />}
      {s?.registered && <RunnerAddons report={s.addons} />}
      {act.view}
    </Section>
  );
}
