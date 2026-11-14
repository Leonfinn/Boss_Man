import { useState } from "react";
import { RUNNER_ADDONS, type AddonReport } from "@boss-man/shared";
import { api, type Company } from "../../api";
import { copyMessage, copyText } from "../../clipboard";
import { usePoll } from "../../hooks";
import { when } from "../Runs";
import { Section, useAction } from "./shared";
import type { UpdateRow } from "./updates";

/** The runner's container when the launcher runs it (R55); null when the launcher is off. */
type Launched = { slug: string; container: { state: string; status: string; image: string; guard?: "on" | "off" | "unavailable" | "down" | "retrying" | "frozen" } | null; error?: string } | null;
/** BOS-382: "updating" is a planned runner swap; Start, Restart and Stop wait until it is over. */
type RunnerLiveState = "connected" | "updating" | "paused" | "failed" | "offline" | "none";
type CompanyReport = { live: { ok: boolean; text: string; state?: RunnerLiveState }; last: UpdateRow | null };
const liveTag = (l: CompanyReport["live"]) => (l.state === "updating" ? "tag amber" : l.ok ? undefined : "tag red");
type RunnerStatus = ({ registered: false; report?: CompanyReport | null } | { registered: true; runnerId: string; connected: boolean; lastSeenAt: string | null; imageVersion: string | null; diskUsedBytes: number | null; addons: AddonReport[] | null; sandbox?: { guard?: { state: "on" | "absent"; reason: string } } | null; report?: CompanyReport | null }) & { launcher?: Launched };

function RunnerAddons({ report }: { report: AddonReport[] | null }) {
  return (
    <div>
      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Add-ons</h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {RUNNER_ADDONS.map((a) => {
          const r = report?.find((x) => x.id === a.id);
          return (
            <li key={a.id}>
              <strong>{a.title}</strong> {r?.ok ? <span className="tag green">Working, {r.version}</span> : r ? <span className="tag red">Not working</span> : <span className="tag">Not installed</span>}
              <p className="muted" style={{ fontSize: 14, margin: "2px 0 0" }}>
                {a.summary}{" "}
                <a href={a.homepage} target="_blank" rel="noopener noreferrer">
                  About it
                </a>
              </p>
              {r && !r.ok && r.detail && <p className="error" style={{ fontSize: 13, margin: "2px 0 0" }}>{r.detail}</p>}
              {!r && (
                <p className="muted" style={{ fontSize: 13, margin: "2px 0 0" }}>
                  To add it, put <code className="mono">RUNNER_ADDONS={a.id}</code> in <code className="mono">.env</code> on the server, then run <code className="mono">scripts/update-runner.sh</code> as root in a root shell on that server. Skills that need it stay out of runs until then.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The runner's last hello: while connected that is when this connection began. */
function Since({ connected, at }: { connected: boolean; at: string | null }) {
  if (!at) return null;
  return <span className="muted">{connected ? `since ${when(at)}` : `last connected ${when(at)}`}</span>;
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
      {s?.registered && <RunnerAddons report={s.addons} />}
      {act.view}
    </Section>
  );
}
