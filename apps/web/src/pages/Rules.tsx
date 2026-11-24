import { useRef, useState, type FormEvent } from "react";
import { SCRATCH_RULE } from "@boss-man/shared";
import { api, type Agent, type Company } from "../api";
import { usePoll } from "../hooks";
import { clearDraft } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { LoadError } from "../components/LoadError";

type Outcome = "allow" | "ceo" | "owner" | "deny";
type Match = { agentIds?: string[]; safeOnly?: boolean; kinds?: string[]; commandPattern?: string; titlePattern?: string; scratchOnly?: boolean; tempCleanupOnly?: boolean; workingCopyOnly?: boolean; reservedTmpRemoval?: boolean; destructive?: boolean; pushing?: boolean };
type Rule = { id: string; companyId: string | null; name: string; match: Match; outcome: Outcome; position: number; createdAt?: string | null; createdBy?: string | null; sourceDecisionId?: string | null; expiresAt?: string | null };

/** "Expires in 45 min" / "Expires today at 23:59" / "Expired at 15:42" for a timed rule; nothing for one that never ends (BOS-2188). */
export function expiryOf(expiresAt: string | null | undefined, now: Date = new Date()): { expired: boolean; text: string } {
  if (!expiresAt) return { expired: false, text: "" };
  const end = new Date(expiresAt);
  const clock = end.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = end.toDateString() === now.toDateString();
  const day = sameDay ? "" : `${end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} `;
  if (end <= now) return { expired: true, text: `Expired ${sameDay ? "at" : "on"} ${day}${clock}` };
  const mins = Math.ceil((end.getTime() - now.getTime()) / 60_000);
  if (mins < 60) return { expired: false, text: `Expires in ${mins} min` };
  return { expired: false, text: sameDay ? `Expires today at ${clock}` : `Expires on ${day}at ${clock}` };
}
type RuleList = { company: Rule[]; global: Rule[]; defaults: Array<{ name: string; match: Match; outcome: Outcome }>; shadowedIds?: string[] };

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

/** "from Kit" / "from Kit or Zippy"; an id no agent list knows falls back to the old wording. */
function describeAgents(ids: string[], agents: Agent[]) {
  const names = ids.map((id) => agents.find((a) => a.id === id)?.name);
  if (names.some((n) => !n)) return ids.length === 1 ? "the request is from one named agent" : "the request is from one of several named agents";
  return `the request is from ${names.join(" or ")}`;
}

function describeMatch(m: Match, agents: Agent[] = []) {
  const parts: string[] = [];
  if (m.agentIds?.length) parts.unshift(describeAgents(m.agentIds, agents));
  if (m.kinds?.length) parts.push(`tool kind is ${m.kinds.join(" or ")}`);
  if (m.commandPattern) parts.push(`command matches /${m.commandPattern}/`);
  if (m.titlePattern) parts.push(`title matches /${m.titlePattern}/`);
  if (m.scratchOnly) parts.push("everything it changes or deletes is in /tmp");
  if (m.destructive) parts.push("the command deletes or destroys data (Boss Man reads what each part runs, however it's written)");
  if (m.tempCleanupOnly) parts.push("its only deletes are of entries directly in /tmp");
  if (m.reservedTmpRemoval) parts.push("it removes one of Boss Man's own /tmp entries (a check slot, a skills folder)");
  if (m.workingCopyOnly) parts.push("its deletes are plain paths in the agent's own working copy (or /tmp)");
  if (m.safeOnly) parts.push("it is not a destructive or pushing command");
  if (m.pushing) parts.push("the command pushes or publishes");
  return parts.join(" and ");
}

/** The row as a form (BOS-2186). Save sends name, match and outcome in one PATCH; the match keeps any field this form doesn't show (agents, safe-only…). A server refusal shows under the form and nothing is saved. */
function RuleEditForm({ rule, onSave, onCancel }: { rule: Rule; onSave: (patch: { name: string; match: Match; outcome: Outcome }) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState({ name: rule.name, kinds: rule.match.kinds ?? [], commandPattern: rule.match.commandPattern ?? "", titlePattern: rule.match.titlePattern ?? "", outcome: rule.outcome });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = (s: string) => `edit-${rule.id}-${s}`;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const { kinds, commandPattern, titlePattern, ...rest } = rule.match;
    void kinds;
    void commandPattern;
    void titlePattern;
    const match: Match = { ...rest, ...(f.kinds.length ? { kinds: f.kinds } : {}), ...(f.commandPattern ? { commandPattern: f.commandPattern } : {}), ...(f.titlePattern ? { titlePattern: f.titlePattern } : {}) };
    setSaving(true);
    setProblem(null);
    try {
      await onSave({ name: f.name, match, outcome: f.outcome });
    } catch (err) {
      setProblem((err as Error).message);
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} aria-label={`Edit ${rule.name}`} style={{ gridColumn: "1 / -1", display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "end" }}>
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <label htmlFor={id("name")}>Rule name</label>
        <input id={id("name")} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={id("command")}>Command matches (regex)</label>
        <input id={id("command")} className="mono" value={f.commandPattern} onChange={(e) => setF({ ...f, commandPattern: e.target.value })} aria-invalid={problem ? true : undefined} aria-describedby={problem ? id("problem") : undefined} />
      </div>
      <div className="field">
        <label htmlFor={id("title")}>Tool title matches (regex)</label>
        <input id={id("title")} className="mono" value={f.titlePattern} onChange={(e) => setF({ ...f, titlePattern: e.target.value })} aria-invalid={problem ? true : undefined} />
      </div>
      <div className="field">
        <label htmlFor={id("outcome")}>Then</label>
        <select id={id("outcome")} value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value as Outcome })}>
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
            <input type="checkbox" checked={f.kinds.includes(k)} onChange={(e) => setF({ ...f, kinds: e.target.checked ? [...f.kinds, k] : f.kinds.filter((x) => x !== k) })} />
            {k}
          </label>
        ))}
      </fieldset>
      {problem && (
        <p id={id("problem")} className="error" role="alert" style={{ gridColumn: "1 / -1" }}>
          {problem}
        </p>
      )}
      <span className="row-actions" style={{ gridColumn: "1 / -1" }}>
        <button className="btn primary small" type="submit" disabled={saving}>
          Save
        </button>
        <button className="btn small" type="button" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

type UseCounts = { allow: number; ceo: number; owner: number; deny: number };
type Usage = Record<string, { week: UseCounts; month: UseCounts; lastAt: string }>;
const total = (c: UseCounts) => c.allow + c.ceo + c.owner + c.deny;
const split = (c: UseCounts) => `${c.allow} allowed, ${c.ceo} sent to the CEO, ${c.owner} sent to you, ${c.deny} refused`;

/** "3 days ago" / "today" for when a rule last matched. */
export function agoText(iso: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

/** "12 this week · 40 in 30 days · last matched 2 days ago", or a "Not used in 30 days" tag (BOS-2372). Nothing until the usage has loaded. */
export function RuleUsageLine({ name, usage }: { name: string; usage: Usage | undefined }) {
  if (!usage) return null;
  const u = usage[name];
  if (!u || total(u.month) === 0) return <p style={{ fontSize: 12.5 }}><span className="tag">Not used in 30 days</span></p>;
  return (
    <p className="muted" style={{ fontSize: 12.5 }} title={`This week: ${split(u.week)}. Last 30 days: ${split(u.month)}.`}>
      {total(u.week)} this week · {total(u.month)} in 30 days · last matched {agoText(u.lastAt)}
      <br />
      30 days: {split(u.month)}
    </p>
  );
}

export type AskedCard = { kind: string | null; title: string; asked: number; toOwner: number; toCeo: number; allowed: number; refused: number; open: number; lastAt: string };

/** A title as a regex that matches exactly that text (BOS-2418). */
export const literalTitlePattern = (title: string): string => `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

const answeredText = (c: AskedCard) => {
  const parts = [c.allowed && `${c.allowed} allowed`, c.refused && `${c.refused} refused`, c.open && `${c.open} still open`].filter(Boolean);
  return parts.length ? parts.join(", ") : "not answered by a person";
};

/** The 10 kinds of request that reached the owner or the CEO most in 30 days, each with "Make a rule" (BOS-2418). */
export function MostAskedCards({ cards, error, onRetry, onMake }: { cards: AskedCard[] | undefined; error: Error | null; onRetry: () => void; onMake: (c: AskedCard) => void }) {
  return (
    <details className="card">
      <summary style={{ fontSize: 17, fontWeight: 600 }}>Most-asked cards (last 30 days)</summary>
      {error && !cards && <LoadError what="the most-asked cards" message={error.message} onRetry={onRetry} />}
      {!error && !cards && <p className="muted">Loading the cards…</p>}
      {cards && cards.length === 0 && <p className="muted">No cards reached you in the last 30 days.</p>}
      {cards && cards.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Kind</th><th>Title</th><th>Asked you</th><th>Sent to the CEO</th><th>How you answered</th><th>Last asked</th><th /></tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={`${c.kind ?? ""}\u0000${c.title}`}>
                  <td>{c.kind ?? "other"}</td>
                  <td className="mono" style={{ overflowWrap: "anywhere" }}>{c.title || "(no title)"}</td>
                  <td>{c.toOwner}</td>
                  <td>{c.toCeo}</td>
                  <td>{answeredText(c)}</td>
                  <td>{agoText(c.lastAt)}</td>
                  <td>{c.title && <button type="button" className="btn" onClick={() => onMake(c)}>Make a rule</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

type RuleFilter ={ text: string; outcome: Outcome | "" };
const filterOn = (f: RuleFilter) => Boolean(f.text.trim() || f.outcome);

/** View-only filter (BOS-2323): case-insensitive substring over name, command pattern, title pattern and the names of the agents a rule applies to; plus an outcome. */
export function ruleMatchesFilter(r: { name: string; match: Match; outcome: Outcome }, f: RuleFilter, agents: Agent[] = []): boolean {
  if (f.outcome && r.outcome !== f.outcome) return false;
  const q = f.text.trim().toLowerCase();
  if (!q) return true;
  const agentNames = (r.match.agentIds ?? []).map((id) => agents.find((a) => a.id === id)?.name ?? "");
  return [r.name, r.match.commandPattern ?? "", r.match.titlePattern ?? "", ...agentNames].some((s) => s.toLowerCase().includes(q));
}

/** "3 of 20 rules shown" while a filter is on; nothing otherwise. */
function FilterCount({ shown, total, f }: { shown: number; total: number; f: RuleFilter }) {
  if (!filterOn(f)) return null;
  return (
    <p className="muted" role="status" style={{ fontSize: 13 }}>
      {shown === 0 && total > 0 ? "No rules match. " : ""}
      {shown} of {total} rules shown
    </p>
  );
}

function RuleRows({ rules, all = rules, filtered = false, usage, agents, shadowed, editingId, onEdit, onSave, onMove, onChange, onDelete }: { rules: Rule[]; all?: Rule[]; filtered?: boolean; usage?: Usage; agents: Agent[]; shadowed: string[]; editingId: string | null; onEdit: (id: string | null) => void; onSave: (r: Rule, patch: { name: string; match: Match; outcome: Outcome }) => Promise<void>; onMove: (i: number, d: -1 | 1) => void; onChange: (r: Rule, o: Outcome) => void; onDelete: (r: Rule) => void }) {
  if (!all.length) return <p className="muted">None yet.</p>;
  if (!rules.length) return null;
  return (
    <ol className="rules">
      {rules.map((r) => {
        const i = all.indexOf(r);
        return editingId === r.id ? (
          <li key={r.id}>
            <span className="mono muted">{i + 1}</span>
            <RuleEditForm rule={r} onSave={(p) => onSave(r, p)} onCancel={() => onEdit(null)} />
          </li>
        ) : (
        <li key={r.id} style={expiryOf(r.expiresAt).expired ? { opacity: 0.6 } : undefined}>
          <span className="mono muted">{i + 1}</span>
          <div style={{ minWidth: 0 }}>
            <strong>{r.name}</strong>
            {r.expiresAt && (
              <p className={expiryOf(r.expiresAt).expired ? "muted" : "tag amber"} style={{ fontSize: 12.5 }}>
                {expiryOf(r.expiresAt).text}
                {expiryOf(r.expiresAt).expired ? ". It no longer matches; Boss Man removes it a week after it ended." : ""}
              </p>
            )}
            <p className="mono muted" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
              When {describeMatch(r.match, agents)}
            </p>
            <RuleUsageLine name={r.name} usage={usage} />
            {r.createdBy && (
              <p className="muted" style={{ fontSize: 12.5 }}>
                Made by {r.createdBy}{r.createdAt ? ` on ${new Date(r.createdAt).toLocaleString()}` : ""}{r.sourceDecisionId ? " from a decision card (see Decisions, answered)" : ""}. Remove it with the button on this row.
              </p>
            )}
            {shadowed.includes(r.id) && <p className="muted" style={{ fontSize: 12.5 }}>Built-in rules already allow these requests, so this rule no longer asks about them. It still applies to delete, push and other guarded requests.</p>}
          </div>
          <select aria-label={`Outcome of ${r.name}`} value={r.outcome} onChange={(e) => onChange(r, e.target.value as Outcome)}>
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="row-actions">
            {!filtered && (
              <>
                <button type="button" className="btn small" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => onMove(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn small" aria-label={`Move ${r.name} down`} disabled={i === all.length - 1} onClick={() => onMove(i, 1)}>
                  ↓
                </button>
              </>
            )}
            {!expiryOf(r.expiresAt).expired && (
              <button type="button" className="btn small" aria-label={`Edit ${r.name}`} onClick={() => onEdit(r.id)}>
                Edit
              </button>
            )}
            <button type="button" className="btn small" onClick={() => onDelete(r)}>
              Delete
            </button>
          </span>
        </li>
        );
      })}
    </ol>
  );
}

export function Rules({ companies, companyId, go }: { companies: Company[]; companyId: string | undefined; go: (to: string) => void }) {
  const scopeId = companyId && companyId !== "all" ? companyId : null;
  const company = companies.find((c) => c.id === scopeId);
  const allAgents = (scopeId ? company?.agents : companies.flatMap((c) => c.agents)) ?? [];
  const list = usePoll((signal) => api<RuleList>(`/api/policy-rules${scopeId ? `?companyId=${scopeId}` : ""}`, { signal }), 60_000, scopeId ?? "all");
  // Usage is a nice-to-have: a failed or odd reply just hides the lines (a rule with no usage shown is not marked unused).
  const usageList = usePoll((signal) => api<{ rules?: Usage }>(`/api/policy-rules/usage${scopeId ? `?companyId=${scopeId}` : ""}`, { signal }), 300_000, `usage-${scopeId ?? "all"}`);
  const usage = usageList.data?.rules && typeof usageList.data.rules === "object" ? usageList.data.rules : undefined;
  const askedList = usePoll((signal) => api<{ cards?: AskedCard[] }>(`/api/policy-rules/most-asked${scopeId ? `?companyId=${scopeId}` : ""}`, { signal }), 300_000, `asked-${scopeId ?? "all"}`);
  const asked = Array.isArray(askedList.data?.cards) ? askedList.data!.cards : undefined;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", kinds: [] as string[], commandPattern: "", titlePattern: "", outcome: "owner" as Outcome });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RuleFilter>({ text: "", outcome: "" });
  const [ask, setAsk] = useState("");
  // The "what should this rule do?" text is kept in this browser as it is typed (DR-045).
  const askDraftKey = `rule-ask/${scopeId ?? "all"}`;
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [probe, setProbe] = useState({ companyId: scopeId ?? companies[0]?.id ?? "", command: "" });
  const [verdict, setVerdict] = useState<{ outcome: Outcome; rule: string } | null>(null);
  const [useDraft, setUseDraft] = useState(false);

  // `submitting` disables the two submit buttons; the ref stops a second click that lands before React re-renders.
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      list.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const submitOnce = async (fn: () => Promise<unknown>) => {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      await act(fn);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };
  const rules = list.data ? (scopeId ? list.data.company : list.data.global) : [];
  const shownRules = rules.filter((r) => ruleMatchesFilter(r, filter, allAgents));
  const defaults = list.data?.defaults ?? [];
  const shownDefaults = defaults.filter((r) => ruleMatchesFilter(r, filter));
  const scratchRule = rules.find((r) => r.match.scratchOnly);
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
    void submitOnce(async () => {
      await api("/api/policy-rules", { method: "POST", body: { companyId: scopeId, name: form.name, match, outcome: form.outcome } });
      setForm({ name: "", kinds: [], commandPattern: "", titlePattern: "", outcome: "owner" });
    });
  };
  const askCeo = (e: FormEvent) => {
    e.preventDefault();
    void submitOnce(async () => {
      const r = await api<{ ceo: { name: string } }>(`/api/companies/${scopeId}/rule-requests`, { method: "POST", body: { text: ask } });
      setSentTo(r.ceo.name);
      setAsk("");
      clearDraft(askDraftKey);
    });
  };
  // The rule being typed in "Add a rule", if it has anything to match on: "Try a command" can test it before it is saved (BOS-2188).
  const draftMatch: Match | null = form.kinds.length || form.commandPattern || form.titlePattern ? { ...(form.kinds.length ? { kinds: form.kinds } : {}), ...(form.commandPattern ? { commandPattern: form.commandPattern } : {}), ...(form.titlePattern ? { titlePattern: form.titlePattern } : {}) } : null;
  const test = (e: FormEvent) => {
    e.preventDefault();
    const draft = useDraft && draftMatch ? { draft: { match: draftMatch, outcome: form.outcome } } : {};
    void api<{ outcome: Outcome; rule: string }>("/api/policy-rules/test", { method: "POST", body: { ...probe, companyId: probe.companyId || companies[0]!.id, ...draft } }).then((v) => { setVerdict(v); setError(null); }, (err: Error) => setError(err.message));
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
        Order of checking: network and safety guards, then your deny rules, then your allow rules (they cannot lift a safety guard), then the built-in allows, then your "Ask the CEO" and "Ask me" rules, which apply only to requests that would otherwise ask. "Ask the CEO" puts it in the CEO's queue; "Ask me" puts it in yours.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <MostAskedCards
        cards={asked}
        error={askedList.error}
        onRetry={askedList.reload}
        onMake={(c) => {
          // Fills the form only; nothing is saved until the owner saves it. The outcome stays as it was for them to pick.
          setForm({ name: "", kinds: c.kind ? [c.kind] : [], commandPattern: "", titlePattern: literalTitlePattern(c.title), outcome: "owner" });
          setAdvancedOpen(true);
          setTimeout(() => document.getElementById("rule-name")?.focus(), 0);
        }}
      />

      <section className="card" aria-labelledby="rules-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="rules-h" style={{ fontSize: 17, fontWeight: 600 }}>
          {company ? `${company.name}'s rules` : "Rules for every company"}
        </h2>
        {!list.data && !list.error && <p className="muted" role="status">Loading…</p>}
        {!list.data && list.error && <LoadError what="the rules" message={list.error.message} onRetry={list.reload} />}
        {list.data && (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "end" }}>
            <div className="field">
              <label htmlFor="rules-filter-text">Filter rules</label>
              <input id="rules-filter-text" type="search" placeholder="Name, command, title or agent" value={filter.text} onChange={(e) => setFilter({ ...filter, text: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="rules-filter-outcome">Show rules that</label>
              <select id="rules-filter-outcome" value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value as Outcome | "" })}>
                <option value="">All</option>
                {OUTCOMES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {list.data && usageList.error && <LoadError what="how often each rule matched" message={usageList.error.message} onRetry={usageList.reload} />}
        {list.data && <FilterCount shown={shownRules.length} total={rules.length} f={filter} />}
        {list.data && <RuleRows
          rules={shownRules}
          all={rules}
          filtered={filterOn(filter)}
          usage={usage}
          agents={allAgents}
          shadowed={list.data?.shadowedIds ?? []}
          editingId={editingId}
          onEdit={setEditingId}
          onSave={async (r, patch) => {
            await api(`/api/policy-rules/${r.id}`, { method: "PATCH", body: patch });
            setEditingId(null);
            setError(null);
            list.reload();
          }}
          onMove={move}
          onChange={(r, outcome) => void act(() => api(`/api/policy-rules/${r.id}`, { method: "PATCH", body: { outcome } }))}
          onDelete={(r) => window.confirm(`Delete "${r.name}"?`) && void act(() => api(`/api/policy-rules/${r.id}`, { method: "DELETE" }))}
        />}
      </section>

      {list.data && <>
      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={Boolean(scratchRule)}
            disabled={!list.data}
            onChange={() => void act(() => (scratchRule ? api(`/api/policy-rules/${scratchRule.id}`, { method: "DELETE" }) : api("/api/policy-rules", { method: "POST", body: { companyId: scopeId, ...SCRATCH_RULE } })))}
          />
          {SCRATCH_RULE.name}
        </label>
        <p className="muted" style={{ fontSize: 14 }}>
          Agents often copy the project into /tmp to try something out. When this is on, a command is allowed without asking if every file it changes or deletes is in /tmp. It still asks you about anything that touches files outside /tmp, pushes, uses the network, or runs a program Boss Man can't see inside (such as node or a script). Off by default.
        </p>
      </section>

      <section className="card" aria-labelledby="add-rule-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="add-rule-h" style={{ fontSize: 17, fontWeight: 600 }}>
          Add a rule
        </h2>
        {scopeId && (
          <form onSubmit={askCeo} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="field">
              <label htmlFor="rule-ask">What should this rule do?</label>
              <DraftTextarea draftKey={askDraftKey} id="rule-ask" required rows={3} maxLength={1000} placeholder="Let agents read from GitHub without asking me, but ask before they change anything." value={ask} onChange={setAsk} style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }} />
            </div>
            <div className="actions">
              <button className="btn primary" type="submit" disabled={!ask.trim() || submitting}>
                Ask the CEO to draft it
              </button>
            </div>
            {sentTo && <p role="status">Sent to {sentTo}. Their proposal will appear in your Decisions queue.</p>}
          </form>
        )}
        <details open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)} style={scopeId ? { paddingTop: 12, borderTop: "1px solid var(--line)" } : undefined}>
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
          <button className="btn primary" type="submit" disabled={submitting}>
            Add rule
          </button>
        </form>
        </details>
      </section>
      </>}

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
          {draftMatch && (
            <label style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
              <input type="checkbox" checked={useDraft} onChange={(e) => setUseDraft(e.target.checked)} />
              Try it with the rule I'm typing under "Add a rule" first (nothing is saved)
            </label>
          )}
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
          Checked last, and can't be changed. A request nothing matches goes to the CEO first, and to you if the CEO does not settle it. Deletes, moves and requests that name a path come straight to you.
        </p>
        <FilterCount shown={shownDefaults.length} total={defaults.length} f={filter} />
        <ol className="rules">
          {shownDefaults.map((r) => (
            <li key={r.name}>
              <span className="mono muted">{defaults.indexOf(r) + 1}</span>
              <div style={{ minWidth: 0 }}>
                <strong>{r.name}</strong>
                <p className="mono muted" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
                  When {describeMatch(r.match)}
                </p>
                <RuleUsageLine name={r.name} usage={usage} />
              </div>
              {outcomeTag(r.outcome)}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
