// Set-up wizard steps (BOS-2815): "Connect" is one equal list of every way to pay for an agent, each with its
// own short steps, and saving one also makes the funding source and points the CEO at it; "The runner" is one
// status line. The full forms stay in Settings.
import { useRef, useState, type FormEvent } from "react";
import { CONNECT_OPTIONS, connectSaves, connectValueHint, connectValueProblem, providerLabel, type ConnectOption } from "@boss-man/shared";
import { api, type Company } from "../api";
import { usePoll } from "../hooks";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { useAction } from "./settings/shared";

type Grant = { id: string; envName: string; secretName: string; secretId?: string };
/** A set-up secret for a listed option that hasn't made the CEO's funding source yet (BOS-2815). */
export type ReadyFunding = { secretId: string; optionId: string };

/** What a half-finished save already made, so a retry carries on instead of making a second secret or source. */
type Made = { secretId?: string; granted?: boolean; sourceId?: string };
/** The one funding source a company uses to connect an agent, by secret, so two saves don't each make one. */
export type SourceBySecret = Record<string, string>;

const guideUrl = (slug: string) => `https://github.com/Leonfinn/Boss_Man/blob/main/apps/site/src/guides/${slug}.md`;

/**
 * An option the connect step has already done: its key is granted to the company, so it pays for agents and
 * the step says so. Null when none is (the first save).
 */
export async function existingConnection(company: Company): Promise<ConnectOption | null> {
  const grants = await api<Grant[]>(`/api/companies/${company.id}/grants`);
  return CONNECT_OPTIONS.find((o) => o.secret && grants.some((g) => g.envName === o.secret!.envName)) ?? null;
}

/**
 * Saves a value for one listed option as the CEO's funding source, the way the setup token always has
 * (BOS-1495): the secret, its grant, the funding source, then the CEO's link. Returns down to the caller and
 * leaves what was made in `made`, so pressing Save again after a failure carries on rather than duplicating.
 * A company that already holds this option's key gets that secret used again, not a second one.
 */
export async function runConnect(o: ConnectOption & { secret: NonNullable<ConnectOption["secret"]> }, company: Company, value: string, made: Made, known: SourceBySecret): Promise<string> {
  const grantBody = { companyId: company.id, envName: o.secret.envName };
  // One already save grants this option's key: that secret is used again, so changing the value doesn't make a second one.
  if (!made.secretId) made.secretId = known[`env:${o.secret.envName}`];
  if (!made.secretId) made.secretId = (await api<{ secret: { id: string } }>("/api/secrets", { method: "POST", body: { name: `${company.name} ${o.name}`, kind: o.secret.kind, value: value.trim() } })).secret.id;
  if (!made.granted) {
    await api(`/api/secrets/${made.secretId}/grants`, { method: "POST", body: grantBody });
    made.granted = true;
  }
  if (!made.sourceId) {
    const all = await api<Array<{ id: string; secretId?: string | null }>>("/api/funding-sources");
    const source = known[made.secretId] ?? (Array.isArray(all) ? all.find((s) => s.secretId === made.secretId)?.id : undefined);
    made.sourceId = source ?? (await api<{ id: string }>("/api/funding-sources", { method: "POST", body: { name: `${company.name} ${providerLabel(o.provider)}`, kind: o.kind, provider: o.provider, secretId: made.secretId } })).id;
  }
  const ceo = company.agents.find((a) => a.role === "ceo");
  if (ceo) await api(`/api/agents/${ceo.id}`, { method: "PATCH", body: { fundingSourceId: made.sourceId } });
  return ceo
    ? "Saved. It is stored encrypted and is not shown again. It also pays for the CEO, so the \"What pays for the CEO\" step is done."
    : "Saved. It is stored encrypted and is not shown again. This company has no CEO yet, so choose what pays for it on the \"What pays for the CEO\" step.";
}

/** The steps for making the value on a provider's website, each outside step saying when it was last checked. */
function KeySteps({ o }: { o: ConnectOption }) {
  const s = o.steps;
  if (!s) return null;
  return (
    <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
      <li>In your browser, open <a href={s.url} target="_blank" rel="noreferrer">{providerLabel(o.provider)}</a>.</li>
      <li>{s.site}.</li>
      <li>Set a spending limit there if the site offers one, so the bill can't run away.</li>
      <li>Copy the whole key; the site shows it once. Paste it below.</li>
      <li className="muted">
        Site steps {s.checked}, checked against {s.note}
      </li>
    </ol>
  );
}

/** The install-first steps for a plan that needs one command, so the command exists before it is run. */
function CommandSteps({ o }: { o: ConnectOption }) {
  const c = o.command;
  if (!c) return null;
  return (
    <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
      <li>Install {o.name.includes("ChatGPT") ? "Codex" : "Claude Code"} on your own computer: <a href={c.installUrl} target="_blank" rel="noreferrer">{o.name.includes("ChatGPT") ? "Codex's setup page" : "Claude Code's setup page"}</a>.</li>
      <li>Open a terminal: on a Mac, press Command and Space, type <code>Terminal</code> and press Enter; on Windows, press the Windows key, type <code>PowerShell</code> and press Enter.</li>
      <li>
        Paste the line for your computer and press Enter: <code>{c.install.mac}</code> (Mac) or <code>{c.install.windows}</code> (Windows).
      </li>
      <li>Close that window, open a new terminal, and type <code>{c.run}</code>.</li>
      <li>Sign in in the browser that opens, then copy the token the terminal prints. It is shown once.</li>
      <li className="muted">
        Steps from <a href={c.makeUrl} target="_blank" rel="noreferrer">{o.name.includes("ChatGPT") ? "OpenAI's docs" : "Claude Code's authentication page"}</a>, checked {c.checked}. {c.note}
      </li>
    </ol>
  );
}

/** One listed option with its steps open: the value box, a plain error tied to it, and Save. */
function ConnectDetail({ o, company, onSaved, known }: { o: ConnectOption; company: Company; onSaved: (secretId: string, optionId: string) => void; known: SourceBySecret }) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const act = useAction();
  // Kept across messages: a partly saved value carries on, and the funding source it made is found again.
  const made = useRef<Made>({});
  const boxId = `setup-connect-value-${o.id}`;
  const errorId = `${boxId}-error`;
  const hint = connectValueHint(o);
  if (!connectSaves(o)) {
    // No value Boss Man can save for this one: say where it is set instead of a box that would fail.
    const what: Record<string, string> = {
      other: "Amazon Bedrock, Microsoft Foundry and LLM gateways each use two or three values (such as an address and a token), so they are set under Settings → Secrets, under Other. Agents then run on them from the Agents page.",
      "chatgpt-plan": "A ChatGPT plan is signed in to in Codex itself, on the computer the runner runs on; no value is pasted here. See the guide for how, or choose OpenAI API key to connect from this page alone.",
      "ollama-plan": "An Ollama Cloud plan is signed in to in Ollama itself; no value is pasted here. See the guide for how, or choose Ollama Cloud API key to connect from this page alone.",
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={{ margin: 0 }}>{what[o.id]}</p>
        <p style={{ margin: 0 }}>
          <a href={`#/settings/${company.id}/secrets`}>Open Settings → Secrets</a> · <a href={guideUrl(o.guide)} target="_blank" rel="noreferrer">How this works</a>
        </p>
      </div>
    );
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    const bad = connectValueProblem(o, value);
    setProblem(bad);
    if (bad) return;
    void act.run(async () => {
      const msg = await runConnect(o as ConnectOption & { secret: NonNullable<ConnectOption["secret"]> }, company, value, made.current, known);
      const secretId = made.current.secretId!;
      made.current = {};
      setValue("");
      onSaved(secretId, o.id);
      return msg;
    });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {o.needs === "command" ? <CommandSteps o={o} /> : <KeySteps o={o} />}
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }} noValidate>
        <div className="field">
          <label htmlFor={boxId}>
            {o.id === "claude-plan" ? "The setup token" : `${providerLabel(o.provider)} key`}
          </label>
          <input
            id={boxId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : hint ? `${boxId}-hint` : undefined}
            onChange={(e) => {
              made.current = {};
              setProblem(null);
              setValue(e.target.value);
            }}
          />
          {hint && !problem && (
            <small id={`${boxId}-hint`} className="muted" style={{ fontSize: 13 }}>
              {hint}
            </small>
          )}
          {problem && (
            <small id={errorId} role="alert" className="error">
              {problem}{" "}
              <a href={`${guideUrl(o.guide)}`} target="_blank" rel="noreferrer">Still stuck? See the guide</a>
            </small>
          )}
        </div>
        <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={act.busy || !value.trim()}>
          {act.busy ? "Saving…" : "Save and connect"}
        </button>
      </form>
      {act.view}
    </div>
  );
}

/**
 * The connect step: every way to pay for an agent as equal rows, in one order, with no favourite (BOS-2815).
 * A row opens its own short steps; saving one sets what pays for the CEO, so step 7 is done.
 */
export function ClaudeStep({ company, onChanged, onSaved }: { company: Company; onChanged: () => void; onSaved: (secretId: string, optionId: string) => void }) {
  const grants = usePoll((signal) => api<Grant[]>(`/api/companies/${company.id}/grants`, { signal }), 30_000, `setup-connect-grants-${company.id}`);
  const sources = usePoll((signal) => api<Array<{ id: string; secretId?: string | null }>>("/api/funding-sources", { signal }), 30_000, "setup-sources");
  const [open, setOpen] = useState<string | null>(null);
  // Only once both loads have answered: an error answer is not a list, and must not crash the step.
  if (grants.data === null) return <Loader label="Loading what your agents can connect to" size={16} />;
  if (!Array.isArray(grants.data)) return <LoadError what="what your agents can connect to" message="Boss Man sent something unexpected. Reload the page, or continue with a later step." onRetry={grants.reload} />;
  const sourceList = Array.isArray(sources.data) ? sources.data : [];
  const granted = new Set(grants.data.map((g) => g.envName));
  const saved = CONNECT_OPTIONS.find((o) => o.secret && granted.has(o.secret.envName));
  // By secret (funding source) and by variable (the secret it is), so a value is saved onto one already there.
  const known: SourceBySecret = {};
  for (const g of grants.data) if (g.secretId) known[`env:${g.envName}`] = g.secretId;
  for (const s of sourceList) if (s.secretId) known[s.secretId] = s.id;
  const name = (o: ConnectOption) => o.name;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {saved && (
        <p role="status">
          <span className="tag green">Connected</span> Your agents can run on {name(saved)}. It pays for the CEO too. To change it, use Settings → Credentials.
        </p>
      )}
      <div role="list" aria-label="Ways to connect an agent" className="connect-list">
        {CONNECT_OPTIONS.map((o) => {
          const isOpen = open === o.id;
          return (
            <div key={o.id} role="listitem" className="connect-row" data-testid={`setup-connect-row-${o.id}`}>
              <button type="button" className="connect-pick" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : o.id)}>
                <span className="connect-name">{o.name}</span>
                <span className="connect-meta">
                  {o.cost} · {o.needs === "browser" ? "Browser only" : "One command on a computer"}
                </span>
              </button>
              {isOpen && (
                <div className="connect-detail">
                  <ConnectDetail o={o} company={company} known={known} onSaved={onSaved} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        <a href={guideUrl("connect-a-claude-account")} target="_blank" rel="noreferrer">Plan or API key: which is right for me?</a>
      </p>
    </div>
  );
}

/** Step 7, until the connect step has set it up: what pays for the CEO, the funding-source form above it. */
export function fundingHint(): string {
  return "Go back to the connect step; it sets this up for you.";
}

/** What GET /runner says of the launcher (services/launcher.ts status()); null or absent when there is no launcher. */
type Launched = { slug: string; container: { state: string; status: string; guard?: string; guardReason?: string } | null; error?: string } | null;
type RunnerState = { registered: boolean; connected?: boolean; launcher?: Launched; memoryLine?: string | null };

const TROUBLESHOOT = "https://github.com/Leonfinn/Boss_Man/blob/main/docs/29-tune-and-troubleshoot.md";

/**
 * BOS-1895: why a launched runner isn't connected, in plain words, each with the docs/29 section that fixes it.
 * Empty when nothing is known to be wrong (not started yet, or still starting): the step keeps "not connected yet".
 */
function runnerProblems(l: Launched | undefined): { key: string; text: string; anchor: string }[] {
  if (!l) return [];
  const out: { key: string; text: string; anchor: string }[] = [];
  if (l.error) out.push({ key: "launcher", text: `Boss Man couldn't reach the launcher, which starts the runner. It said: ${l.error}`, anchor: "the-launcher-cant-be-reached" });
  const c = l.container;
  if (c && c.state !== "running") out.push({ key: "container", text: `The runner's container is ${c.state}${c.status ? ` (Docker says "${c.status}")` : ""}.`, anchor: "the-runners-container-has-stopped" });
  if (c?.guardReason) out.push({ key: "guard", text: `The runner's network guard didn't start: ${c.guardReason}`, anchor: "the-runners-network-guard-wont-start" });
  return out;
}

/** Runner step: connected or not, and if not the one thing to do. The full panel is Settings → Runner. */
export function RunnerStep({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const status = usePoll((signal) => api<RunnerState>(`/api/companies/${company.id}/runner`, { signal }), 5_000, `setup-runner-${company.id}`);
  const act = useAction();
  const s = status.data;
  if (!s) return <p className="muted">Checking the runner…</p>;
  const connected = s.registered && s.connected;
  const problems = connected ? [] : runnerProblems(s.launcher);
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
        ) : problems.length ? (
          <>
            <span className="tag red">Not connected</span> The runner is not connected, and something is wrong:
          </>
        ) : (
          <>
            <span className="tag amber">Not connected</span> The runner is not connected yet.
          </>
        )}
      </p>
      {problems.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 20 }} data-testid="setup-runner-problems">
          {problems.map((p) => (
            <li key={p.key} data-testid={`setup-runner-problem-${p.key}`}>
              {p.text}{" "}
              <a href={`${TROUBLESHOOT}#${p.anchor}`} target="_blank" rel="noreferrer">
                How to fix it
              </a>
            </li>
          ))}
        </ul>
      )}
      {/* BOS-1498: what the runner is given and why ("11 GB: 6 agents at once and 1 check, on a 16 GB machine."). */}
      {s.memoryLine && (
        <p className="muted" style={{ margin: 0, fontSize: 14 }} data-testid="setup-runner-memory">
          Memory: {s.memoryLine}
        </p>
      )}
      {!connected &&
        (s.launcher ? (
          <button type="button" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={act.busy} onClick={start}>
            Start the runner
          </button>
        ) : (
          <p style={{ margin: 0 }}>
            To connect it, open <a href={`#/settings/${company.id}/runner`}>Settings → Server and runner → Runner</a> and follow the steps there.
          </p>
        ))}
      {act.view}
    </div>
  );
}
