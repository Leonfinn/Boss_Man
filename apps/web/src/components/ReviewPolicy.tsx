import { useEffect, useState, type FormEvent } from "react";
import { api, REVIEW_KINDS, RISKS, type Agent, type ReviewerRef, type ReviewKindName, type ReviewPolicy } from "../api";
import { usePoll } from "../hooks";
import { SaveButton, useSaveState } from "./SaveButton";
import { Loader } from "./Loader";
import { Advanced, PresetCards } from "./PresetCards";
import { DEFAULT_REVIEW_POLICY } from "@boss-man/shared";
import { matchPreset, REVIEW_PRESETS } from "../lib/presets";

const cap = (r: string) => r[0]!.toUpperCase() + r.slice(1);
const SEVERAL = "__several";

/**
 * One reviewer cell: the select picks one choice (Off, CEO, Senior Developer or an agent); once an
 * agent is picked, ticking more agents below makes it a list, and each review goes to one of them
 * (BOS-198). The choices that aren't agents can't be mixed into a list. One agent is saved as its id,
 * several as a list, so a single choice is stored exactly as before.
 */
function ReviewerCell({ label, id, value, onChange, team, off }: { label: string; id: string; value: ReviewerRef | undefined; onChange: (v: ReviewerRef | undefined) => void; team: Agent[]; off: boolean }) {
  const ids = Array.isArray(value) ? value : value && team.some((a) => a.id === value) ? [value] : [];
  const toggle = (agentId: string, on: boolean) => {
    const next = on ? [...ids, agentId] : ids.filter((x) => x !== agentId);
    if (next.length) onChange(next.length === 1 ? next[0]! : next);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <select aria-label={label} id={id} value={ids.length > 1 ? SEVERAL : (value ?? "")} onChange={(e) => (e.target.value === SEVERAL ? undefined : onChange(e.target.value || undefined))}>
        {off && <option value="">Off</option>}
        {value === "marked" && <option value="marked">Marked agent (old setting)</option>}
        <option value="ceo">CEO</option>
        <option value="senior-dev">Senior Developer (when hired)</option>
        {team.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}{a.title ? ` (${a.title})` : ""}
          </option>
        ))}
        {ids.length > 1 && <option value={SEVERAL}>{ids.map((x) => team.find((a) => a.id === x)?.name ?? "Unknown agent").join(", ")}</option>}
      </select>
      {ids.length > 0 && team.length > 1 && (
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2, fontSize: "0.85em" }}>
          <legend className="muted">Shared between (one each)</legend>
          {team.map((a) => (
            <label key={a.id} style={{ whiteSpace: "nowrap" }}>
              <input type="checkbox" aria-label={`${label}: ${a.name}`} checked={ids.includes(a.id)} disabled={ids.length === 1 && ids[0] === a.id} onChange={(e) => toggle(a.id, e.target.checked)} /> {a.name}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** The 5-row table: who approves the plan, who reviews the code, which extra reviews it needs, whether the owner signs off. The one place that says who reviews (BOS-198). */
export function ReviewPolicyTable({ value, onChange, agents, idPrefix }: { value: ReviewPolicy; onChange: (v: ReviewPolicy) => void; agents: Agent[]; idPrefix: string }) {
  const team = agents.filter((a) => a.role !== "ceo" && !a.duty);
  const set = (tier: (typeof RISKS)[number], patch: Partial<ReviewPolicy["low"]>) => onChange({ ...value, [tier]: { ...value[tier], ...patch } });
  const people = (
    <>
      <option value="ceo">CEO</option>
      <option value="senior-dev">Senior Developer (when hired)</option>
      {team.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}{a.title ? ` (${a.title})` : ""}
        </option>
      ))}
    </>
  );
  const setKind = (tier: (typeof RISKS)[number], kind: ReviewKindName, ref: ReviewerRef | undefined) => {
    const { [kind]: _drop, ...rest } = value[tier].kinds ?? {};
    set(tier, { kinds: ref ? { ...rest, [kind]: ref } : rest });
  };
  return (
    // Seven columns of selects are wider than a card: scroll inside it rather than past its edge.
    // Vertical stays hidden so a one-pixel overflow can't swallow the page's wheel (BOS-554).
    <div style={{ overflowX: "auto", overflowY: "hidden" }}>
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left" }}>
          <th>Risk</th>
          <th>Plan approved by</th>
          <th>Code reviewed by</th>
          {REVIEW_KINDS.map((k) => (
            <th key={k}>{cap(k)} review</th>
          ))}
          <th>You sign off</th>
        </tr>
      </thead>
      <tbody>
        {RISKS.map((tier) => (
          <tr key={tier}>
            <td>{cap(tier)}</td>
            <td>
              <select aria-label={`${cap(tier)}: plan approved by`} id={`${idPrefix}-plan-${tier}`} value={value[tier].planApprover} onChange={(e) => set(tier, { planApprover: e.target.value })}>
                <option value="none">None</option>
                <option value="owner">Owner</option>
                {people}
              </select>
            </td>
            <td>
              <ReviewerCell label={`${cap(tier)}: code reviewed by`} id={`${idPrefix}-review-${tier}`} value={value[tier].reviewer} onChange={(v) => v && set(tier, { reviewer: v })} team={team} off={false} />
            </td>
            {REVIEW_KINDS.map((k) => (
              <td key={k}>
                <ReviewerCell label={`${cap(tier)}: ${k} review by`} id={`${idPrefix}-${k}-${tier}`} value={value[tier].kinds?.[k]} onChange={(v) => setKind(tier, k, v)} team={team} off />
              </td>
            ))}
            <td>
              <input type="checkbox" aria-label={`${cap(tier)}: you sign off`} checked={value[tier].ownerSignoff} onChange={(e) => set(tier, { ownerSignoff: e.target.checked })} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/** Settings > Reviews: the company's default policy. */
export function CompanyReviews({ companyId, agents }: { companyId: string; agents: Agent[] }) {
  const url = `/api/companies/${companyId}/review-policy`;
  const loaded = usePoll((signal) => api<ReviewPolicy>(url, { signal }), 3_600_000, `review-policy-${companyId}`).data;
  const [form, setForm] = useState<ReviewPolicy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sv = useSaveState(form);
  useEffect(() => {
    if (loaded && !form) setForm(loaded);
  }, [loaded, form]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(url, { method: "PUT", body: form });
      sv.markSaved();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!form) return <Loader label="Loading the review policy" />;
  const preset = matchPreset(form, REVIEW_PRESETS);
  return (
    <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PresetCards label="Review preset" presets={REVIEW_PRESETS} active={preset} onPick={(p) => setForm(p.values)} />
      <Advanced storeKey="reviews" forceOpen={!preset} summary={preset ? `The full table behind ${preset.name}.` : "Your own values: edit the table or pick a card."}>
        <ReviewPolicyTable value={form} onChange={setForm} agents={agents} idPrefix="co" />
      </Advanced>
      <div style={{ display: "flex", gap: 8 }}>
        <SaveButton {...sv} busy={busy} />
        <button type="button" className="btn" onClick={() => setForm(DEFAULT_REVIEW_POLICY as ReviewPolicy)}>
          Reset to defaults
        </button>
      </div>
      {err && <p role="alert" className="error">{err}</p>}
    </form>
  );
}

/** In a project: "Use the company's" or "Customise" with the same table. */
export function ProjectReviews({ projectId, companyId, agents }: { projectId: string; companyId: string; agents: Agent[] }) {
  const url = `/api/projects/${projectId}/review-policy`;
  const mine = usePoll((signal) => api<{ policy: ReviewPolicy | null }>(url, { signal }), 3_600_000, `project-review-${projectId}`).data;
  const [custom, setCustom] = useState<ReviewPolicy | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sv = useSaveState(custom ?? null);
  useEffect(() => {
    if (mine && custom === undefined) setCustom(mine.policy);
  }, [mine, custom]);
  if (custom === undefined) return null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Customise starts from the company's table and saves it at once, so the choice is what the server holds.
  const choose = (on: boolean) =>
    run(async () => {
      if (on) {
        const copy = await api<ReviewPolicy>(`/api/companies/${companyId}/review-policy`);
        await api(url, { method: "PUT", body: copy });
        setCustom(copy);
        sv.reset(copy);
      } else {
        await api(url, { method: "DELETE" });
        setCustom(null);
      }
    });
  return (
    <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 8 }}>
      <label htmlFor={`rev-${projectId}`}>Reviews for this project</label>
      <select id={`rev-${projectId}`} value={custom ? "custom" : "company"} disabled={busy} onChange={(e) => void choose(e.target.value === "custom")}>
        <option value="company">Use the company's</option>
        <option value="custom">Customise</option>
      </select>
      {custom && (
        <>
          <ReviewPolicyTable value={custom} onChange={setCustom} agents={agents} idPrefix={`pr-${projectId}`} />
          <div>
            <SaveButton
              {...sv}
              busy={busy}
              onClick={() =>
                void run(async () => {
                  await api(url, { method: "PUT", body: custom });
                  sv.markSaved();
                })
              }
            />
          </div>
        </>
      )}
      {err && <p role="alert" className="error">{err}</p>}
    </div>
  );
}
