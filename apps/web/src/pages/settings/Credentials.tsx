import { useState, type FormEvent } from "react";
import { api, type Agent, type Company } from "../../api";
import { usePoll } from "../../hooks";
import { SaveButton, useSaveState } from "../../components/SaveButton";
import { LoadError } from "../../components/LoadError";
import { Loader } from "../../components/Loader";
import { Section, useAction } from "./shared";

/** What each kind of credential is called inside an agent's environment by default. */
const CREDENTIALS = [
  { kind: "claude_oauth_token", label: "Claude setup-token", env: "CLAUDE_CODE_OAUTH_TOKEN", help: "Run `claude setup-token` on your own computer and paste the token it prints." },
  { kind: "generic", label: "Git token (GitHub or Gitea)", env: "GIT_TOKEN", help: "GitHub: a fine-grained token for the company's repos, with Contents, Pull requests and Workflows read and write, plus Actions read-only (so Boss Man can read CI runs). Gitea: a token with the write:repository scope." },
  { kind: "generic", label: "Git token for the merge gate (second account)", env: "GIT_CI_TOKEN", help: "Optional. A token from a second GitHub account with Contents read and write on the company's repo. Boss Man pushes its merge-check branches (bossman-ci/...) with it, so GitHub's failed-run emails go to that account, not yours." },
  { kind: "anthropic_api_key", label: "Anthropic API key", env: "ANTHROPIC_API_KEY", help: "From the Anthropic Console. Runs on it are billed to your API credit." },
  { kind: "openai_api_key", label: "OpenAI API key", env: "OPENAI_API_KEY", help: "For Codex agents." },
  { kind: "generic", label: "OpenRouter API key", env: "OPENROUTER_API_KEY", help: "For OpenCode agents. Models are named openrouter/<model>." },
  { kind: "generic", label: "Ollama Cloud API key", env: "OLLAMA_API_KEY", help: "For OpenCode agents. Models are named ollama-cloud/<model>." },
  { kind: "generic", label: "Synthetic API key", env: "SYNTHETIC_API_KEY", help: "For OpenCode agents. Models are named synthetic/<model>, e.g. synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017" },
  { kind: "generic", label: "GitHub watcher token", env: "GITHUB_WATCH_TOKEN", help: "A fine-grained GitHub token for the project's GitHub watcher: Metadata read, plus Issues, Discussions, Secret scanning alerts and Dependabot alerts read and write (write lets Support answer and close issues and discussions, and the security reviewer close an alert, from inside Boss Man; it changes nothing else on GitHub)." },
  { kind: "generic", label: "Other", env: "", help: "Any other value an agent needs, under the variable name you choose. The one exception is GITHUB_WATCH_TOKEN, the GitHub watcher's token: only the server reads it and no agent run ever gets it." },
] as const;

type Grant = { id: string; envName: string; secretId: string; secretName: string; hint: string | null; deployTargetId: string | null; agentIds: string[] };
type Secret = { id: string; name: string; kind: string; hint: string | null };

/** A setup-token can only be proved by Claude Code, so its check runs on the runner (R58). */
const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** Which of the company's agents get a key; none ticked means all of them. */
function GrantAgents({ grant, agents, busy, onSave }: { grant: Grant; agents: Agent[]; busy: boolean; onSave: (ids: string[]) => void }) {
  const [picked, setPicked] = useState(grant.agentIds);
  const names = agents.filter((a) => grant.agentIds.includes(a.id)).map((a) => a.name);
  return (
    <details onToggle={(e) => e.currentTarget.open && setPicked(grant.agentIds)}>
      <summary aria-label={`Agents for ${grant.envName}`}>
        {names.length ? `Only ${names.join(", ")}` : "Every agent"} <span className="muted">({names.length ? "change" : "limit to some"})</span>
      </summary>
      <fieldset style={{ border: 0, padding: 0, margin: "6px 0" }}>
        <legend className="muted" style={{ fontSize: 13 }}>Leave all unticked to give the key to every agent in this company.</legend>
        {agents.map((a) => (
          <label key={a.id} style={{ display: "block" }}>
            <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((id) => id !== a.id))} /> {a.name}
          </label>
        ))}
      </fieldset>
      <SaveButton dirty={[...picked].sort().join() !== [...grant.agentIds].sort().join()} saved={false} busy={busy} onClick={() => onSave(picked)} ariaLabel={`Save agents for ${grant.envName}`} />
    </details>
  );
}

export function Credentials({ company, onChanged, title = "Credentials" }: { company: Company; onChanged?: () => void; title?: string }) {
  const grants = usePoll((signal) => api<Grant[]>(`/api/companies/${company.id}/grants`, { signal }), 30_000, `grants-${company.id}`);
  const targets = usePoll((signal) => api<{ id: string; name: string }[]>(`/api/companies/${company.id}/deploy-targets`, { signal }), 30_000, `deploy-targets-${company.id}`);
  const secrets = usePoll((signal) => api<Secret[]>("/api/secrets", { signal }), 30_000, "secrets");
  // No default kind: a value checked as the wrong kind fails confusingly, so the owner always picks.
  const [choice, setChoice] = useState(-1);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [env, setEnv] = useState("");
  const [existing, setExisting] = useState("");
  const act = useAction();
  const sv = useSaveState({ choice, name, value, env, existing });
  const c = CREDENTIALS[choice];
  // A pasted key file (e.g. a Google service-account JSON) only fits "Other".
  const looksLikeJson = !!c && c.kind !== "generic" && value.trim().startsWith("{");
  // The name is only the label in the secret store; left blank it follows the variable for "Other".
  const defaultName = !c ? "" : c.env ? `${company.name} ${c.label}` : env;
  const describe = (r: { problems?: string[]; live: { ok: boolean; message: string } | null }) => {
    const problems = r.problems?.length ? ` ${r.problems.join(" ")}` : "";
    if (r.live) {
      if (!r.live.ok) throw new Error(`${r.live.message}${problems}`);
      return `${r.live.message}${problems}`;
    }
    if (problems) throw new Error(problems.trim());
    return c?.kind === "claude_oauth_token" ? "The format looks right. A setup-token can only be fully checked by Claude Code itself: save it, then choose Check with Claude." : "The format looks right. Boss Man can't ask a provider about this kind of value.";
  };
  const check = () =>
    void act.run(async () => describe(await api<{ problems: string[]; live: { ok: boolean; message: string } | null }>("/api/secrets/check", { method: "POST", body: { kind: c!.kind, value } })));
  const checkSaved = (g: Grant) =>
    void act.run(async () => {
      if (g.envName === CLAUDE_TOKEN_ENV) {
        const r = await api<{ ok: boolean; message: string }>(`/api/companies/${company.id}/check-claude`, { method: "POST" });
        if (!r.ok) throw new Error(`${g.secretName}: ${r.message}`);
        return `${g.secretName}: ${r.message}`;
      }
      const r = await api<{ live: { ok: boolean; message: string } | null }>(`/api/secrets/${g.secretId}/check`, { method: "POST" });
      if (!r.live) return `${g.secretName}: Boss Man can't ask a provider about this kind of value.`;
      if (!r.live.ok) throw new Error(`${g.secretName}: ${r.live.message}`);
      return `${g.secretName}: ${r.live.message}`;
    });

  // Stops this company getting the value; the secret itself stays, for other companies or to grant again.
  const remove = (g: Grant) =>
    window.confirm(`Stop giving ${g.secretName} to ${company.name} as ${g.envName}? The secret itself is kept.`) &&
    void act.run(async () => {
      await api(`/api/grants/${g.id}`, { method: "DELETE" });
      grants.reload();
      onChanged?.();
      return `${company.name}'s agents no longer get ${g.envName} (from the next run). ${g.secretName} is still stored; delete it under All stored secrets if nothing else uses it.`;
    });

  const setAgents = (g: Grant, ids: string[]) =>
    void act.run(async () => {
      await api(`/api/grants/${g.id}/agents`, { method: "PUT", body: { agentIds: ids } });
      grants.reload();
      return ids.length ? `${g.envName} now goes only to the agents you ticked (from the next run).` : `${g.envName} goes to every agent in ${company.name} (from the next run).`;
    });

  const add = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      let secretId = existing;
      let warnings: string[] = [];
      if (!secretId) {
        const created = await api<{ secret: { id: string }; warnings: string[] }>("/api/secrets", { method: "POST", body: { name: name.trim() || defaultName, kind: c!.kind, value } });
        secretId = created.secret.id;
        warnings = created.warnings;
      }
      await api(`/api/secrets/${secretId}/grants`, { method: "POST", body: { companyId: company.id, envName: env } });
      // Each new credential starts from a blank form, so nothing carries over from the last one.
      setValue("");
      setName("");
      setExisting("");
      setChoice(-1);
      setEnv("");
      sv.markSaved({ choice: -1, name: "", value: "", env: "", existing: "" });
      grants.reload();
      secrets.reload();
      onChanged?.();
      return `Saved. ${company.name}'s agents now get it as ${env}.${warnings.length ? ` Note: ${warnings.join(" ")}` : ""}`;
    });
  };

  return (
    <Section id="creds-h" title={title}>
      <p className="muted" style={{ fontSize: 14 }}>
        Values are encrypted on the server and never shown again; agents get them as environment variables. Each value is checked when saved, e.g. for stray spaces.
      </p>
      {grants.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">Secret</th>
                <th scope="col">Ends in</th>
                <th scope="col">Used for</th>
                <th scope="col">Agents</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.data.map((g) => (
                <tr key={g.id}>
                  <td className="mono">{g.envName}</td>
                  <td>{g.secretName}</td>
                  <td className="mono muted">{g.hint ?? ""}</td>
                  <td>{g.deployTargetId ? (targets.data?.find((t) => t.id === g.deployTargetId)?.name ?? "One deploy target") : "Every run"}</td>
                  <td>
                    <GrantAgents key={g.agentIds.join()} grant={g} agents={company.agents} busy={act.busy} onSave={(ids) => setAgents(g, ids)} />
                  </td>
                  <td>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => checkSaved(g)} style={{ whiteSpace: "nowrap" }} title={g.envName === CLAUDE_TOKEN_ENV ? "Runs one tiny prompt on the company's runner, using a little of the subscription allowance" : undefined}>
                      {g.envName === CLAUDE_TOKEN_ENV ? "Check with Claude" : "Check"}
                    </button>{" "}
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => remove(g)} aria-label={`Remove ${g.envName} from ${company.name}`}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : grants.data ? (
        <p>No credentials yet. Agents need at least a Claude setup-token or an API key to run.</p>
      ) : grants.error ? (
        <LoadError what="the credentials" message={grants.error.message} onRetry={grants.reload} />
      ) : (
        <Loader label="Loading the credentials" size={16} />
      )}
      {grants.data?.some((g) => g.envName === CLAUDE_TOKEN_ENV) && (
        <p className="muted" style={{ fontSize: 13 }}>
          <strong>Check with Claude</strong> runs one tiny prompt on the company's runner, so it uses a little of the subscription allowance and can take a minute.
        </p>
      )}
      <form onSubmit={add} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
        <div className="field">
          <label htmlFor="cred-kind">Add</label>
          <select
            id="cred-kind"
            required={!existing}
            value={choice < 0 ? "" : choice}
            onChange={(e) => {
              const i = Number(e.target.value);
              setChoice(i);
              setEnv(CREDENTIALS[i]!.env);
            }}
          >
            <option value="" disabled>
              Choose what you're adding
            </option>
            {CREDENTIALS.map((k, i) => (
              <option key={k.label} value={i}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        {(secrets.data?.length ?? 0) > 0 && (
          <div className="field">
            <label htmlFor="cred-existing">Value</label>
            <select id="cred-existing" value={existing} onChange={(e) => setExisting(e.target.value)}>
              <option value="">A new value</option>
              {secrets.data!.map((s) => (
                <option key={s.id} value={s.id}>
                  Reuse {s.name}
                  {s.hint ? ` (${s.hint})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {!existing && (
          <>
            <div className="field">
              <label htmlFor="cred-name">Name</label>
              <input id="cred-name" autoComplete="off" aria-describedby="cred-name-hint" placeholder={defaultName} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="cred-value">Value</label>
              <input id="cred-value" type="password" autoComplete="off" spellCheck={false} required value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="cred-env">Variable name</label>
          <input id="cred-env" className="mono" autoComplete="off" required pattern="[A-Z_][A-Z0-9_]*" value={env} onChange={(e) => setEnv(e.target.value.toUpperCase())} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!existing && (
            <button className="btn" type="button" disabled={act.busy || !value.trim() || !c} onClick={check}>
              Check
            </button>
          )}
          <SaveButton {...sv} busy={act.busy} />
        </div>
      </form>
      {!existing && (
        <p id="cred-name-hint" className="muted" style={{ fontSize: 13 }}>
          <strong>Name</strong> is optional: it's how the value is listed under Secrets, and lets you reuse it in another company under a different variable name. Leave it blank to use the one shown. <strong>Variable name</strong> is what agents see.
        </p>
      )}
      {looksLikeJson && (
        <p role="alert" className="error" style={{ fontSize: 14 }}>
          This looks like a JSON key file (such as a Google service-account key), not a {c!.label}. Choose <strong>Other</strong> under Add, and keep the whole file as the value.
        </p>
      )}
      {c && (
        <p className="muted" style={{ fontSize: 13 }}>
          {c.help.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
        </p>
      )}
      {act.view}
    </Section>
  );
}
