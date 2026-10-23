import { useEffect, useState, type FormEvent } from "react";
import { api, REVIEW_KINDS, RISKS, type Agent, type ReviewKindName, type ReviewPolicy } from "../api";
import { usePoll } from "../hooks";
import { SaveButton, useSaveState } from "./SaveButton";

// Mirrors the server's defaults (packages/shared/src/review-policy.ts) for "Reset to defaults".
const DEFAULTS: ReviewPolicy = {
  trivial: { planApprover: "none", reviewer: "ceo", ownerSignoff: false },
  low: { planApprover: "ceo", reviewer: "ceo", ownerSignoff: false },
  medium: { planApprover: "ceo", reviewer: "senior-dev", ownerSignoff: false },
  high: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true },
  critical: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true },
};

const cap = (r: string) => r[0]!.toUpperCase() + r.slice(1);

/** The 5-row table: who approves the plan, who reviews the code, which extra reviews it needs, whether the owner signs off. */
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
  const setKind = (tier: (typeof RISKS)[number], kind: ReviewKindName, ref: string) => {
    const { [kind]: _drop, ...rest } = value[tier].kinds ?? {};
    set(tier, { kinds: ref ? { ...rest, [kind]: ref } : rest });
  };
  return (
    // Seven columns of selects are wider than a card: scroll inside it rather than past its edge.
    <div style={{ overflowX: "auto" }}>
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
              <select aria-label={`${cap(tier)}: code reviewed by`} id={`${idPrefix}-review-${tier}`} value={value[tier].reviewer} onChange={(e) => set(tier, { reviewer: e.target.value })}>
                {people}
              </select>
            </td>
            {REVIEW_KINDS.map((k) => (
              <td key={k}>
                <select aria-label={`${cap(tier)}: ${k} review by`} id={`${idPrefix}-${k}-${tier}`} value={value[tier].kinds?.[k] ?? ""} onChange={(e) => setKind(tier, k, e.target.value)}>
                  <option value="">Off</option>
                  <option value="marked">The agent marked as {k} reviewer</option>
                  {people}
                </select>
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
  if (!form) return <p className="muted">Loading…</p>;
  return (
    <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <ReviewPolicyTable value={form} onChange={setForm} agents={agents} idPrefix="co" />
      <div style={{ display: "flex", gap: 8 }}>
        <SaveButton {...sv} busy={busy} />
        <button type="button" className="btn" onClick={() => setForm(DEFAULTS)}>
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
