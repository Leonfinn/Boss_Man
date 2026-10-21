import { useState, type FormEvent } from "react";
import { api, type Company } from "../api";
import { usePoll } from "../hooks";

type Outcome = "allow" | "ceo" | "owner" | "deny";
type Match = { kinds?: string[]; commandPattern?: string; titlePattern?: string };
type Rule = { id: string; companyId: string | null; name: string; match: Match; outcome: Outcome; position: number };
type RuleList = { company: Rule[]; global: Rule[]; defaults: Array<{ name: string; match: Match; outcome: Outcome }> };

const KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"];
export const OUTCOMES: Array<{ value: Outcome; label: string; tone: string }> = [
  { value: "allow", label: "Allow", tone: "green" },
  { value: "ceo", label: "Ask the CEO", tone: "blue" },
  { value: "owner", label: "Ask me", tone: "amber" },
  { value: "deny", label: "Deny", tone: "red" },
];
const outcomeTag = (o: Outcome) => {
  const x = OUTCOMES.find((v) => v.value === o)!;
  return <span className={`tag ${x.tone}`}>{x.label}</span>;
};

function describeMatch(m: Match) {
  const parts: string[] = [];
  if (m.kinds?.length) parts.push(`tool kind is ${m.kinds.join(" or ")}`);
  if (m.commandPattern) parts.push(`command matches /${m.commandPattern}/`);
  if (m.titlePattern) parts.push(`title matches /${m.titlePattern}/`);
  return parts.join(" and ");
}

function RuleRows({ rules, onMove, onChange, onDelete }: { rules: Rule[]; onMove: (i: number, d: -1 | 1) => void; onChange: (r: Rule, o: Outcome) => void; onDelete: (r: Rule) => void }) {
  if (!rules.length) return <p className="muted">None yet.</p>;
  return (
    <ol className="rules">
      {rules.map((r, i) => (
        <li key={r.id}>
          <span className="mono muted">{i + 1}</span>
          <div style={{ minWidth: 0 }}>
            <strong>{r.name}</strong>
            <p className="mono muted" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
              When {describeMatch(r.match)}
            </p>
          </div>
          <select aria-label={`Outcome of ${r.name}`} value={r.outcome} onChange={(e) => onChange(r, e.target.value as Outcome)}>
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="row-actions">
            <button type="button" className="btn small" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => onMove(i, -1)}>
              ↑
            </button>
            <button type="button" className="btn small" aria-label={`Move ${r.name} down`} disabled={i === rules.length - 1} onClick={() => onMove(i, 1)}>
              ↓
            </button>
            <button type="button" className="btn small" onClick={() => onDelete(r)}>
              Delete
            </button>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Rules({ companies, companyId, go }: { companies: Company[]; companyId: string | undefined; go: (to: string) => void }) {
  const scopeId = companyId && companyId !== "all" ? companyId : null;
  const company = companies.find((c) => c.id === scopeId);
  const list = usePoll((signal) => api<RuleList>(`/api/policy-rules${scopeId ? `?companyId=${scopeId}` : ""}`, { signal }), 60_000, scopeId ?? "all");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", kinds: [] as string[], commandPattern: "", titlePattern: "", outcome: "owner" as Outcome });
  const [ask, setAsk] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [probe, setProbe] = useState({ companyId: scopeId ?? companies[0]?.id ?? "", command: "" });
  const [verdict, setVerdict] = useState<{ outcome: Outcome; rule: string } | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      list.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const rules = list.data ? (scopeId ? list.data.company : list.data.global) : [];
  const move = (i: number, d: -1 | 1) => {
    const ids = rules.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    void act(() => api("/api/policy-rules/order", { method: "POST", body: { companyId: scopeId, ids } }));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const match: Match = {
      ...(form.kinds.length ? { kinds: form.kinds } : {}),
      ...(form.commandPattern ? { commandPattern: form.commandPattern } : {}),
      ...(form.titlePattern ? { titlePattern: form.titlePattern } : {}),
    };
    void act(async () => {
      await api("/api/policy-rules", { method: "POST", body: { companyId: scopeId, name: form.name, match, outcome: form.outcome } });
      setForm({ name: "", kinds: [], commandPattern: "", titlePattern: "", outcome: "owner" });
    });
  };
  const askCeo = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const r = await api<{ ceo: { name: string } }>(`/api/companies/${scopeId}/rule-requests`, { method: "POST", body: { text: ask } });
      setSentTo(r.ceo.name);
      setAsk("");
    });
  };
  const test = (e: FormEvent) => {
    e.preventDefault();
    void api<{ outcome: Outcome; rule: string }>("/api/policy-rules/test", { method: "POST", body: { ...probe, companyId: probe.companyId || companies[0]!.id } }).then(setVerdict, (err: Error) => setError(err.message));
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Decision rules</h1>
          <p className="sub">What happens when an agent asks to use a tool. The first rule that matches decides.</p>
        </div>
        <div className="field">
          <label htmlFor="rules-scope">Rules for</label>
          <select id="rules-scope" value={scopeId ?? "all"} onChange={(e) => go(`rules/${e.target.value}`)}>
            <option value="all">Every company</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} only
              </option>
            ))}
          </select>
        </div>
      </header>
      <p className="muted" style={{ fontSize: 14 }}>
        Order of checking: a company's own rules, then rules for every company, then the built-in defaults. "Ask the CEO" puts it in the CEO's queue; "Ask me" puts it in yours.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="card" aria-labelledby="rules-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="rules-h" style={{ fontSize: 17, fontWeight: 600 }}>
          {company ? `${company.name}'s rules` : "Rules for every company"}
        </h2>
        <RuleRows
          rules={rules}
          onMove={move}
          onChange={(r, outcome) => void act(() => api(`/api/policy-rules/${r.id}`, { method: "PATCH", body: { outcome } }))}
          onDelete={(r) => window.confirm(`Delete "${r.name}"?`) && void act(() => api(`/api/policy-rules/${r.id}`, { method: "DELETE" }))}
        />
        {scopeId && (
          <form onSubmit={askCeo} style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <div className="field">
              <label htmlFor="rule-ask">What should this rule do?</label>
              <textarea id="rule-ask" required rows={3} maxLength={1000} placeholder="Let agents read from GitHub without asking me, but ask before they change anything." value={ask} onChange={(e) => setAsk(e.target.value)} style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }} />
            </div>
            <div className="actions">
              <button className="btn primary" type="submit" disabled={!ask.trim()}>
                Ask the CEO to draft it
              </button>
            </div>
            {sentTo && <p role="status">Sent to {sentTo}. Their proposal will appear in your Decisions queue.</p>}
          </form>
        )}
        <details style={{ paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <summary>Advanced: write the rule yourself</summary>
        <form onSubmit={add} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "end", paddingTop: 12 }}>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="rule-name">New rule</label>
            <input id="rule-name" required placeholder="Container restarts are fine" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="rule-command">Command matches (regex)</label>
            <input id="rule-command" className="mono" placeholder="^docker\s+restart\b" value={form.commandPattern} onChange={(e) => setForm({ ...form, commandPattern: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="rule-title">Tool title matches (regex)</label>
            <input id="rule-title" className="mono" placeholder="^mcp__github__" value={form.titlePattern} onChange={(e) => setForm({ ...form, titlePattern: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="rule-outcome">Then</label>
            <select id="rule-outcome" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value as Outcome })}>
              {OUTCOMES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <fieldset style={{ gridColumn: "1 / -1", border: 0, padding: 0, margin: 0, display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            <legend style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Tool kinds (any of)</legend>
            {KINDS.map((k) => (
              <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
                <input type="checkbox" checked={form.kinds.includes(k)} onChange={(e) => setForm({ ...form, kinds: e.target.checked ? [...form.kinds, k] : form.kinds.filter((x) => x !== k) })} />
                {k}
              </label>
            ))}
          </fieldset>
          <button className="btn primary" type="submit">
            Add rule
          </button>
        </form>
        </details>
      </section>

      {companies.length > 0 && (
        <form className="card" onSubmit={test} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "end" }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, gridColumn: "1 / -1" }}>Try a command</h2>
          <div className="field">
            <label htmlFor="probe-company">An agent of</label>
            <select id="probe-company" value={probe.companyId || companies[0]!.id} onChange={(e) => setProbe({ ...probe, companyId: e.target.value })}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="probe-command">wants to run</label>
            <input id="probe-command" className="mono" required placeholder="docker restart web" value={probe.command} onChange={(e) => setProbe({ ...probe, command: e.target.value })} />
          </div>
          <button className="btn" type="submit">
            Check
          </button>
          {verdict && (
            <p role="status" style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {outcomeTag(verdict.outcome)} <span>decided by "{verdict.rule}"</span>
            </p>
          )}
        </form>
      )}

      <section className="card" aria-labelledby="defaults-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="defaults-h" style={{ fontSize: 17, fontWeight: 600 }}>
          Built-in defaults
        </h2>
        <p className="muted" style={{ fontSize: 14 }}>
          Checked last, and can't be changed. A request nothing matches goes to you.
        </p>
        <ol className="rules">
          {list.data?.defaults.map((r, i) => (
            <li key={r.name}>
              <span className="mono muted">{i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <strong>{r.name}</strong>
                <p className="mono muted" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
                  When {describeMatch(r.match)}
                </p>
              </div>
              {outcomeTag(r.outcome)}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
