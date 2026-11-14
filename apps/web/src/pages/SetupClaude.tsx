// Two simplified setup-wizard steps (BOS-1495): "Claude" is one token box that also makes the funding source
// and points the CEO at it; "The runner" is one status line. The full forms stay in Settings.
import { useRef, useState, type FormEvent } from "react";
import { api, type Company } from "../api";
import { usePoll } from "../hooks";
import { Credentials } from "./settings/Credentials";
import { useAction } from "./settings/shared";

const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
type Grant = { id: string; envName: string; secretName: string };

/** Claude step: the setup-token path by default, the general credentials form behind "Use an API key instead". */
export function ClaudeStep({ company, onChanged, onTokenSaved }: { company: Company; onChanged: () => void; onTokenSaved: () => void }) {
  const grants = usePoll((signal) => api<Grant[]>(`/api/companies/${company.id}/grants`, { signal }), 30_000, `setup-claude-grants-${company.id}`);
  const [value, setValue] = useState("");
  const act = useAction();
  // What a half-finished save already made, so a retry carries on instead of making a second secret or source.
  const made = useRef<{ secretId?: string; granted?: boolean; sourceId?: string }>({});
  const ceo = company.agents.find((a) => a.role === "ceo");
  const connected = grants.data?.find((g) => g.envName === CLAUDE_TOKEN_ENV);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const m = made.current;
      if (!m.secretId) m.secretId = (await api<{ secret: { id: string } }>("/api/secrets", { method: "POST", body: { name: `${company.name} Claude setup-token`, kind: "claude_oauth_token", value: value.trim() } })).secret.id;
      if (!m.granted) {
        await api(`/api/secrets/${m.secretId}/grants`, { method: "POST", body: { companyId: company.id, envName: CLAUDE_TOKEN_ENV } });
        m.granted = true;
      }
      if (!m.sourceId) m.sourceId = (await api<{ id: string }>("/api/funding-sources", { method: "POST", body: { name: `${company.name} Claude`, kind: "subscription", provider: "anthropic", secretId: m.secretId } })).id;
      if (ceo) await api(`/api/agents/${ceo.id}`, { method: "PATCH", body: { fundingSourceId: m.sourceId } });
      made.current = {};
      setValue("");
      grants.reload();
      onTokenSaved();
      onChanged();
      return "Saved. The token is stored encrypted and is not shown again. It also pays for the CEO, so the \"What pays for the CEO\" step is done.";
    });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {connected ? (
        <p role="status">
          <span className="tag green">Connected</span> Claude is set up from <strong>{connected.secretName}</strong>. To change it, use Settings → Credentials.
        </p>
      ) : (
        <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
          <div className="field">
            <label htmlFor="setup-claude-token">Claude setup token</label>
            <input id="setup-claude-token" type="password" autoComplete="off" spellCheck={false} required value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <p className="muted" style={{ fontSize: 14, margin: 0 }}>
            On your own computer, run <code>claude setup-token</code>, sign in with your Claude Pro or Max account, and paste the token it prints.
          </p>
          <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={act.busy || !value.trim()}>
            Save the token
          </button>
        </form>
      )}
      {act.view}
      <details>
        <summary style={{ cursor: "pointer", color: "var(--link)" }}>Use an API key instead</summary>
        <div style={{ marginTop: 10 }}>
          <Credentials company={company} onChanged={onChanged} />
        </div>
      </details>
    </div>
  );
}

type RunnerState = { registered: boolean; connected?: boolean; launcher?: unknown };

/** Runner step: connected or not, and if not the one thing to do. The full panel is Settings → Runner. */
export function RunnerStep({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const status = usePoll((signal) => api<RunnerState>(`/api/companies/${company.id}/runner`, { signal }), 5_000, `setup-runner-${company.id}`);
  const act = useAction();
  const s = status.data;
  if (!s) return <p className="muted">Checking the runner…</p>;
  const connected = s.registered && s.connected;
  const start = () =>
    void act.run(async () => {
      await api(`/api/companies/${company.id}/runner/launch`, { method: "POST" });
      status.reload();
      onChanged();
      return "Starting the runner. This page updates when it connects.";
    });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p role="status" data-testid="setup-runner-line">
        {connected ? (
          <>
            <span className="tag green">Connected</span> The runner is connected.
          </>
        ) : (
          <>
            <span className="tag amber">Not connected</span> The runner is not connected yet.
          </>
        )}
      </p>
      {!connected &&
        (s.launcher ? (
          <button type="button" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={act.busy} onClick={start}>
            Start the runner
          </button>
        ) : (
          <p style={{ margin: 0 }}>
            To connect it, open <a href={`#/settings/${company.id}/system`}>Settings → Server and runner</a> and follow the steps there.
          </p>
        ))}
      {act.view}
    </div>
  );
}
