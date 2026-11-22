import { useState, type FormEvent } from "react";
import { api, type Company, type FundingSource, type Project } from "../../api";
import { usePoll } from "../../hooks";
import { ProjectBudget } from "../ProjectBudget";
import { Section, useAction } from "./shared";
import { Loader } from "../../components/Loader";
import { LoadError } from "../../components/LoadError";

const PROVIDERS: Array<[string, string]> = [
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["bedrock", "Amazon Bedrock"],
  ["foundry", "Microsoft Foundry"],
  ["gateway", "LLM gateway"],
  ["openrouter", "OpenRouter"],
  ["ollama", "Ollama"],
  ["synthetic", "Synthetic"],
];
/** Mirrors the server's rule: a subscription is only a Claude, ChatGPT, Ollama Cloud or Synthetic plan. */
const providerFits = (kind: string, provider: string) => kind !== "subscription" || provider === "anthropic" || provider === "openai" || provider === "ollama" || provider === "synthetic";

export function Funding({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 30_000, "sources");
  const [form, setForm] = useState({ name: "", kind: "subscription", provider: "anthropic", grant: "", anchor: "" });
  const [editing, setEditing] = useState<FundingSource | null>(null);
  const act = useAction();
  const blank = { name: "", kind: "subscription", provider: "anthropic", grant: "", anchor: "" };
  const edit = (s: FundingSource) => {
    setEditing(s);
    setForm({ name: s.name, kind: s.kind, provider: s.provider, grant: s.monthlyGrantMicros != null ? String(s.monthlyGrantMicros / 1e6) : "", anchor: s.cycleAnchor?.slice(0, 10) ?? "" });
  };
  const remove = (s: FundingSource) => {
    if (!window.confirm(`Delete the funding source "${s.name}"? Agents using it will have no funding source until you choose one.`)) return;
    void act.run(async () => {
      const r = await api<{ agentsUnlinked: number }>(`/api/funding-sources/${s.id}`, { method: "DELETE" });
      sources.reload();
      onChanged?.();
      return `Deleted. ${r.agentsUnlinked} agent${r.agentsUnlinked === 1 ? " was" : "s were"} using it.`;
    });
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      await api(editing ? `/api/funding-sources/${editing.id}` : "/api/funding-sources", {
        method: editing ? "PATCH" : "POST",
        body: {
          name: form.name,
          kind: form.kind,
          provider: form.provider,
          ...(form.kind === "api_credit" && form.grant ? { monthlyGrantUsd: Number(form.grant) } : {}),
          ...(form.kind === "api_credit" && form.anchor ? { cycleAnchor: form.anchor } : {}),
        },
      });
      setForm(editing ? blank : { ...form, name: "", grant: "", anchor: "" });
      setEditing(null);
      sources.reload();
      onChanged?.();
      return editing ? "Saved." : "Added.";
    });
  };
  return (
    <Section id="funding-h" title="Funding sources">
      <p className="muted" style={{ fontSize: 14 }}>
        The subscriptions and API accounts agents run on, so their cost and quota are tracked. Choose each agent's model and funding source on the <a href="#/agents">Agents</a> page.
      </p>
      {sources.data && sources.data.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {sources.data.map((s) => (
            <li key={s.id}>
              {s.name} <span className="muted">· {s.kind.replace(/_/g, " ")} · {s.provider}</span>{" "}
              <button type="button" className="btn small" aria-label={`Edit ${s.name}`} onClick={() => edit(s)}>
                Edit
              </button>{" "}
              <button type="button" className="btn small" aria-label={`Delete ${s.name}`} disabled={act.busy} onClick={() => remove(s)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", alignItems: "end" }}>
        <div className="field">
          <label htmlFor="fs-name">{editing ? `Editing ${editing.name}` : "New funding source"}</label>
          <input id="fs-name" required placeholder="Claude Max" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="fs-kind">Kind</label>
          <select id="fs-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, provider: providerFits(e.target.value, form.provider) ? form.provider : "anthropic" })}>
            <option value="subscription">Subscription (setup-token)</option>
            <option value="api_credit">API credit, monthly grant</option>
            <option value="api_payg">API, pay as you go</option>
            <option value="usage_credits">Usage credits</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="fs-provider">Provider</label>
          <select id="fs-provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            {PROVIDERS.filter(([id]) => providerFits(form.kind, id)).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <details style={{ gridColumn: "1 / -1" }}>
          <summary>What the provider controls</summary>
          <div className="muted" style={{ fontSize: 14, display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            <p>
              The provider decides which service lists models for an API-key source (Anthropic, OpenAI and LLM gateways such as OpenRouter; Bedrock and Foundry use the list Claude Code reports from the runner) and labels the quota readings. It doesn't deliver the credential: agents get that from the Secrets page, as environment variables.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Subscription + Anthropic: a Claude Pro or Max plan, run with a setup-token (<code>CLAUDE_CODE_OAUTH_TOKEN</code>).</li>
              <li>Subscription + OpenAI: a ChatGPT plan, used by Codex agents.</li>
              <li>Subscription + Ollama or Synthetic: an Ollama Cloud or Synthetic plan, used by OpenCode agents.</li>
              <li>API kinds: a key from that provider (Anthropic, OpenAI).</li>
              <li>
                Amazon Bedrock (API kinds only): add three credentials with "Other": <code>CLAUDE_CODE_USE_BEDROCK</code> = 1, <code>AWS_REGION</code> and <code>AWS_BEARER_TOKEN_BEDROCK</code> (a Bedrock API key). Name models as Bedrock IDs, e.g. <code>us.anthropic.claude-sonnet-4-6</code>.
              </li>
              <li>
                Microsoft Foundry (API kinds only): <code>CLAUDE_CODE_USE_FOUNDRY</code> = 1, <code>ANTHROPIC_FOUNDRY_RESOURCE</code> (the resource name) and <code>ANTHROPIC_FOUNDRY_API_KEY</code>. Model names are your deployment names.
              </li>
              <li>
                LLM gateway (API kinds only): <code>ANTHROPIC_BASE_URL</code> and <code>ANTHROPIC_AUTH_TOKEN</code>, for a gateway that serves Claude models in the Anthropic format. For OpenRouter: <code>https://openrouter.ai/api</code>, and the OpenRouter key on this funding source; the model list then comes from OpenRouter. Claude Code is only supported on Claude models, so others are marked "may not work".
              </li>
            </ul>
            <p>Claude agents only: Codex runs on OpenAI.</p>
            <p>
              OpenCode agents (pick "OpenCode" when hiring) read <code>OPENROUTER_API_KEY</code>, <code>OLLAMA_API_KEY</code> (Ollama Cloud), <code>SYNTHETIC_API_KEY</code> (Synthetic), <code>OPENAI_API_KEY</code> and <code>ANTHROPIC_API_KEY</code> by themselves; models are named <code>provider/model</code>. A local Ollama has no key: add a credential with "Other" named <code>OPENCODE_CONFIG_CONTENT</code>, whose value is JSON such as{" "}
              <code>{`{"provider":{"ollama":{"npm":"@ai-sdk/openai-compatible","name":"Ollama","options":{"baseURL":"http://host.docker.internal:11434/v1"},"models":{"qwen3:8b":{"name":"Qwen3 8B"}}}}}`}</code>.
            </p>
          </div>
        </details>
        {form.kind === "api_credit" && (
          <>
            <div className="field">
              <label htmlFor="fs-grant">Monthly grant (USD)</label>
              <input id="fs-grant" type="number" min="0" step="0.01" value={form.grant} onChange={(e) => setForm({ ...form, grant: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="fs-anchor">Cycle starts on</label>
              <input id="fs-anchor" type="date" value={form.anchor} onChange={(e) => setForm({ ...form, anchor: e.target.value })} />
            </div>
          </>
        )}
        {editing && <p className="muted" style={{ gridColumn: "1 / -1", fontSize: 14 }}>Spend already recorded stays, but it's counted by this source's current kind, so changing the kind changes how past spend counts too (for example, a subscription's spend never counts toward money caps).</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" type="submit" disabled={act.busy}>
            {editing ? "Save" : "Add funding source"}
          </button>
          {editing && (
            <button className="btn" type="button" onClick={() => (setEditing(null), setForm(blank))}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {act.view}
    </Section>
  );
}

/** Each project's budget (Funding → Budgets, BOS-1018): the same figures the project's Budget tab shows. */
export function ProjectBudgets({ company }: { company: Company }) {
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${company.id}/projects`, { signal }), 60_000, `settings-budgets-${company.id}`);
  const rows = (projects.data ?? []).filter((p) => !p.archivedAt);
  return (
    <Section id="budgets-h" title="Budgets">
      <p className="muted" style={{ fontSize: 14 }}>
        What each project has cost on API and credit runs (list-price estimates, not a bill), and its cap per task and per month. Runs paid from a subscription are left out of the dollar figures. Set a project's caps on its Config tab.
      </p>
      {projects.error && projects.data === null ? <LoadError what="the projects" message={projects.error.message} onRetry={projects.reload} /> : projects.data === null ? <Loader label="Loading projects" /> : rows.length === 0 ? <p className="muted">No projects yet. Add one on the Projects page.</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {rows.map((p) => (
            <div key={p.id}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{p.name}</h3>
              <ProjectBudget project={p} />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
