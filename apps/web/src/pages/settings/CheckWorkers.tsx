// Settings → Server and runner → Checks → Check workers (DR-060, BOS-1435). Other machines that take checks when the
// company runner's slots are full. The owner adds one (its token is shown once), sets its slots and per-check caps, and
// can turn it off or remove it. Each worker says, per company, whether it takes checks and if not, why.
import { useState } from "react";
import { api, type Company } from "../../api";
import { copyMessage, copyText } from "../../clipboard";
import { usePoll } from "../../hooks";
import { when } from "../Runs";
import { workerComposeFile, workerSocketUrl } from "./check-worker-compose";
import { useAction } from "./shared";
import { DEFAULT_POLICY, policyLine, policyValid, SlotSplitFields, type MachineTakes, type SlotPolicy } from "./SlotSplit";

export type CheckWorkerView = {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  slots: number;
  reportedSlots: number | null;
  limit: number;
  /** BOS-1602; absent from a server older than this page. */
  takes?: MachineTakes;
  mergeKept?: number;
  checkThreads: number | null;
  checkMemoryMb: number | null;
  imageCommit: string | null;
  toolchain: Record<string, string> | null;
  lastSeenAt: string | null;
  companies: { id: string; name: string; ready: boolean; reason: string | null }[];
  reason: string | null;
};

type Draft = { name: string; companyIds: string[]; slots: string; threads: string; memoryGb: string; policy: SlotPolicy };
const blank: Draft = { name: "", companyIds: [], slots: "1", threads: "", memoryGb: "", policy: DEFAULT_POLICY };

const toBody = (d: Draft) => ({
  name: d.name.trim(),
  companyIds: d.companyIds,
  slots: Number(d.slots),
  checkThreads: d.threads.trim() ? Number(d.threads) : null,
  checkMemoryMb: d.memoryGb.trim() ? Math.round(Number(d.memoryGb) * 1024) : null,
  takes: d.policy.takes,
  mergeKept: d.policy.takes === "both" ? d.policy.mergeKept : 0,
});

function valid(d: Draft, maxSlots: number) {
  const b = toBody(d);
  return !!b.name && Number.isInteger(b.slots) && b.slots >= 1 && b.slots <= maxSlots && (b.checkThreads === null || (Number.isInteger(b.checkThreads) && b.checkThreads >= 1 && b.checkThreads <= 256)) && (b.checkMemoryMb === null || (b.checkMemoryMb >= 256 && b.checkMemoryMb <= 1_048_576)) && policyValid(d.policy, b.slots);
}

function WorkerForm({ draft, setDraft, companies, maxSlots, idPrefix }: { draft: Draft; setDraft: (d: Draft) => void; companies: Company[]; maxSlots: number; idPrefix: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label htmlFor={`${idPrefix}-name`}>Name</label>
      <input id={`${idPrefix}-name`} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. NAS in the hall cupboard" />
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>Companies whose checks it may run</legend>
        {companies.map((c) => (
          <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <input
              type="checkbox"
              checked={draft.companyIds.includes(c.id)}
              onChange={(e) => setDraft({ ...draft, companyIds: e.target.checked ? [...draft.companyIds, c.id] : draft.companyIds.filter((x) => x !== c.id) })}
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${idPrefix}-slots`}>Checks at once on this machine (1 to {maxSlots})</label>
      <input id={`${idPrefix}-slots`} type="number" min={1} max={maxSlots} value={draft.slots} onChange={(e) => setDraft({ ...draft, slots: e.target.value })} style={{ width: 80 }} />
      <SlotSplitFields value={draft.policy} onChange={(policy) => setDraft({ ...draft, policy })} slots={Number(draft.slots) || 1} idPrefix={idPrefix} />
      <label htmlFor={`${idPrefix}-threads`}>Test threads per check (optional)</label>
      <input id={`${idPrefix}-threads`} type="number" min={1} max={256} value={draft.threads} onChange={(e) => setDraft({ ...draft, threads: e.target.value })} style={{ width: 80 }} />
      <label htmlFor={`${idPrefix}-memory`}>Memory per check, in GB (optional)</label>
      <input id={`${idPrefix}-memory`} type="number" min={0.25} step={0.5} value={draft.memoryGb} onChange={(e) => setDraft({ ...draft, memoryGb: e.target.value })} style={{ width: 80 }} />
      <p className="muted" style={{ fontSize: 14 }}>
        Leave the optional fields empty to let the machine decide. A machine never runs more checks than it says it can, whatever the number here.
      </p>
    </div>
  );
}

export function CheckWorkers({ workers, maxSlots, reload }: { workers: CheckWorkerView[]; maxSlots: number; reload: () => void }) {
  const companies = usePoll((signal) => api<Company[]>("/api/companies", { signal }), 60_000, "companies");
  const act = useAction();
  const [adding, setAdding] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [added, setAdded] = useState<{ token: string; commit: string | null; slots: number } | null>(null);
  const list = companies.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="check-workers">
      <h3 style={{ margin: "8px 0 0" }}>Check workers</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Other machines that take checks when the runner's slots are full. A check worker runs checks only: it gets no secrets, runs no agents and never merges. It takes checks when its tools (Node, pnpm, git and so on) match the company's runner, so an ordinary runner update does not stop it. If the tools ever differ, this page says which one and you press Redeploy on that machine.
      </p>
      {workers.length === 0 && <p className="muted" style={{ fontSize: 14 }}>No check workers yet.</p>}
      {workers.map((w) => (
        <div key={w.id} className="card" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }} data-testid="check-worker">
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong>{w.name}</strong>
            {!w.enabled ? <span className="tag">Off</span> : w.connected ? <span className="tag">Connected</span> : <span className="tag red">Offline</span>}
            <span className="muted" style={{ fontSize: 14 }}>
              {w.limit} check{w.limit === 1 ? "" : "s"} at once{w.reportedSlots !== null && w.reportedSlots < w.slots ? ` (the machine says it can run ${w.reportedSlots})` : ""}
              <span data-testid="check-worker-split">{` · ${policyLine({ takes: w.takes ?? "both", mergeKept: w.mergeKept ?? 0 }, w.limit)}`}</span>
              {w.lastSeenAt ? ` · last seen ${when(w.lastSeenAt)}` : ""}
              {w.toolchain?.node ? ` · Node ${w.toolchain.node}` : w.imageCommit ? ` · version ${w.imageCommit.slice(0, 7)}` : ""}
            </span>
          </div>
          {w.reason ? (
            <p style={{ fontSize: 14, margin: 0 }} data-testid="check-worker-reason">
              Takes no checks: {w.reason}
            </p>
          ) : (
            <ul style={{ fontSize: 14, margin: 0, paddingLeft: 18 }}>
              {w.companies.length === 0 && <li>Not set up for any company yet.</li>}
              {w.companies.map((c) => (
                <li key={c.id} data-testid="check-worker-company">
                  {c.name}: {c.ready ? "takes checks when the runner is full" : c.reason}
                </li>
              ))}
            </ul>
          )}
          {editing?.id === w.id ? (
            <>
              <WorkerForm draft={editing.draft} setDraft={(draft) => setEditing({ id: w.id, draft })} companies={list} maxSlots={maxSlots} idPrefix={`cw-${w.id}`} />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={act.busy || !valid(editing.draft, maxSlots)}
                  onClick={() =>
                    void act.run(async () => {
                      await api(`/api/settings/check-workers/${w.id}`, { method: "PATCH", body: toBody(editing.draft) });
                      setEditing(null);
                      reload();
                      return "Saved.";
                    })
                  }
                >
                  Save
                </button>
                <button type="button" className="btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setEditing({ id: w.id, draft: { name: w.name, companyIds: w.companies.map((c) => c.id), slots: String(w.slots), threads: w.checkThreads ? String(w.checkThreads) : "", memoryGb: w.checkMemoryMb ? String(w.checkMemoryMb / 1024) : "", policy: { takes: w.takes ?? "both", mergeKept: w.mergeKept ?? 0 } } })}
              >
                Change
              </button>
              <button
                type="button"
                className="btn"
                disabled={act.busy}
                onClick={() =>
                  void act.run(async () => {
                    await api(`/api/settings/check-workers/${w.id}`, { method: "PATCH", body: { enabled: !w.enabled } });
                    reload();
                    return w.enabled ? `${w.name} is off. Any check it was running went back in line.` : `${w.name} is on again.`;
                  })
                }
              >
                {w.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={act.busy}
                onClick={() =>
                  window.confirm(`Remove ${w.name}? Its token stops working at once, and any check it is running goes back in line.`) &&
                  void act.run(async () => {
                    await api(`/api/settings/check-workers/${w.id}`, { method: "DELETE" });
                    reload();
                    return `${w.name} was removed.`;
                  })
                }
              >
                Remove
              </button>
            </div>
          )}
        </div>
      ))}
      {added && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="check-worker-token">
          <p>
            <strong>Copy this file now; it holds the worker's token and isn't shown again.</strong> On the worker's machine, save it as <code>compose.yaml</code> in an empty folder (or paste it into a TrueNAS custom app, Portainer or Dockge) and run <code>docker compose up -d</code>. Nothing else to edit, now or after a runner update.
          </p>
          <pre className="mono codebox" data-testid="check-worker-compose" style={{ maxHeight: 320, overflow: "auto" }}>
            {workerComposeFile({ url: workerSocketUrl(window.location.origin), slots: added.slots, token: added.token })}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                void act.run(async () =>
                  copyMessage(await copyText(workerComposeFile({ url: workerSocketUrl(window.location.origin), slots: added.slots, token: added.token })), "Compose file"),
                )
              }
            >
              Copy compose file
            </button>
            <button type="button" className="btn" onClick={() => setAdded(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {adding ? (
        <>
          <WorkerForm draft={adding} setDraft={setAdding} companies={list} maxSlots={maxSlots} idPrefix="cw-new" />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              disabled={act.busy || !valid(adding, maxSlots)}
              onClick={() =>
                void act.run(async () => {
                  const body = { ...toBody(adding), enabled: true };
                  const r = await api<{ id: string; token: string; commit?: string | null }>("/api/settings/check-workers", { method: "POST", body });
                  setAdded({ token: r.token, commit: r.commit ?? null, slots: body.slots });
                  setAdding(null);
                  reload();
                })
              }
            >
              Add
            </button>
            <button type="button" className="btn" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div>
          <button type="button" className="btn" onClick={() => setAdding(blank)}>
            Add a check worker
          </button>
        </div>
      )}
      {act.view}
    </div>
  );
}
