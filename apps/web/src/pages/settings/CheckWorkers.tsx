// Settings → Server and runner → Limits and checks → Check workers (DR-060, BOS-1435). Other machines that take checks when the
// company runner's slots are full. The owner adds one (its token is shown once), sets its slots and per-check caps, and
// can turn it off or remove it. Each worker says, per company, whether it takes checks and if not, why.
import { useState } from "react";
import { CHECK_PEAK_MB, checkMemoryWarning } from "@boss-man/shared";

const MEMORY_GUIDE = "https://github.com/Leonfinn/Boss_Man/blob/main/docs/34-check-workers.md#changing-the-memory-on-any-docker-host";
import { api, type Company } from "../../api";
import { copyMessage, copyText } from "../../clipboard";
import { usePoll } from "../../hooks";
import { when } from "../Runs";
import type { HostFactsView } from "../../host-facts-display";
import { workerAddressChoices, workerComposeFile, workerSocketUrl } from "./check-worker-compose";
import { SaveButton } from "../../components/SaveButton";
import { useAction } from "./shared";
import { DEFAULT_POLICY, policyLine, policyValid, SlotSplitFields, type MachineTakes, type SlotPolicy } from "./SlotSplit";

export type CheckWorkerView = {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  slots: number;
  reportedSlots: number | null;
  /** BOS-2217: the machine's memory for checks, in MB; absent or null from an older worker or server. */
  reportedMemoryMb?: number | null;
  /** BOS-2217: set when checks at once × memory per check is more than the machine has. */
  memoryWarning?: string | null;
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

/** The form values a worker has now: the baseline the Save button compares against. */
const draftOf = (w: CheckWorkerView): Draft => ({ name: w.name, companyIds: w.companies.map((c) => c.id), slots: String(w.slots), threads: w.checkThreads ? String(w.checkThreads) : "", memoryGb: w.checkMemoryMb ? String(w.checkMemoryMb / 1024) : "", policy: { takes: w.takes ?? "both", mergeKept: w.mergeKept ?? 0 } });

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

function WorkerForm({ draft, setDraft, companies, maxSlots, idPrefix, machineMb }: { draft: Draft; setDraft: (d: Draft) => void; companies: Company[]; maxSlots: number; idPrefix: string; machineMb?: number | null }) {
  // BOS-2217: as the owner types, say when the numbers need more than the machine has. Only a worker that has connected reports its memory.
  const slotsNow = Number(draft.slots);
  const typedMb = draft.memoryGb.trim() ? Math.round(Number(draft.memoryGb) * 1024) : null;
  const perCheckMb = typedMb && typedMb > 0 ? typedMb : CHECK_PEAK_MB;
  const gbText = (mb: number) => `${Math.round((mb / 1024) * 100) / 100} GB`;
  const warning = machineMb && Number.isInteger(slotsNow) && slotsNow >= 1 ? checkMemoryWarning({ slots: slotsNow, perCheckMb: typedMb, machineMb }) : null;
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
      <label htmlFor={`${idPrefix}-memory`}>Memory limit per check (GB, optional)</label>
      <input id={`${idPrefix}-memory`} type="number" min={0.25} step={0.5} value={draft.memoryGb} onChange={(e) => setDraft({ ...draft, memoryGb: e.target.value })} style={{ width: 80 }} />
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        The most memory Boss Man lets one check use on this machine. It does not give the machine more memory: the machine's total is set where the worker runs (<code>mem_limit</code> in its compose file). Set this to the machine's memory ÷ checks at once.
      </p>
      <p className="muted" style={{ fontSize: 14, margin: 0 }} data-testid="check-worker-memory-machine">
        {machineMb
          ? `This machine has ${gbText(machineMb)}${Number.isInteger(slotsNow) && slotsNow >= 1 ? ` (${slotsNow} check${slotsNow === 1 ? "" : "s"} × ${gbText(perCheckMb)} would need ${gbText(slotsNow * perCheckMb)})` : ""}.`
          : "Not reported yet: redeploy the worker once to see it."}
      </p>
      {warning && (
        <p role="alert" className="tag red" style={{ fontSize: 14 }} data-testid="check-worker-memory-warning">
          {warning} <a href={MEMORY_GUIDE} target="_blank" rel="noreferrer">Check worker guide</a>
        </p>
      )}
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
  // BOS-1601: the address the worker dials is the owner's pick from the addresses Boss Man knows, not just the page's own.
  const hostFacts = usePoll((signal) => api<HostFactsView>("/api/host-facts", { signal }), 60_000, "host-facts-workers");
  const choices = workerAddressChoices({ origin: window.location.origin, facts: hostFacts.data?.facts });
  const [picked, setPicked] = useState<string | null>(null);
  const choice = choices.find((c) => c.url === picked) ?? choices[0];
  const workerUrl = choice?.url ?? workerSocketUrl(window.location.origin);
  const list = companies.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="check-workers">
      <h3 style={{ margin: "8px 0 0" }}>Check workers</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Other machines that take checks when the runner's slots are full. A check worker runs checks only: merge checks (the full test run before a ticket lands) and quick checks (before review). It gets no secrets and runs no agents, and code only ever goes onto main from your main Boss Man server, never from a worker. It takes checks when its tools (Node, pnpm, git and so on) match the company's runner, so an ordinary runner update does not stop it. If the tools ever differ, this page says which one and you press Redeploy on that machine.
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
          {w.memoryWarning && (
            <p style={{ fontSize: 14, margin: 0 }} className="tag red" data-testid="check-worker-memory-card-warning">
              Memory: {w.memoryWarning}
            </p>
          )}
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
              <WorkerForm draft={editing.draft} setDraft={(draft) => setEditing({ id: w.id, draft })} companies={list} maxSlots={maxSlots} idPrefix={`cw-${w.id}`} machineMb={w.reportedMemoryMb} />
              <div style={{ display: "flex", gap: 8 }}>
                <SaveButton
                  dirty={JSON.stringify(editing.draft) !== JSON.stringify(draftOf(w))}
                  saved={false}
                  busy={act.busy}
                  disabled={!valid(editing.draft, maxSlots)}
                  onClick={() =>
                    void act.run(async () => {
                      await api(`/api/settings/check-workers/${w.id}`, { method: "PATCH", body: toBody(editing.draft) });
                      setEditing(null);
                      reload();
                      return "Saved.";
                    })
                  }
                />
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
                onClick={() => setEditing({ id: w.id, draft: draftOf(w) })}
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
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} data-testid="check-worker-address">
            <legend>Address the worker uses to reach Boss Man (it must be able to look it up from the worker's machine)</legend>
            {choices.map((c) => (
              <label key={c.url} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <input type="radio" name="cw-address" checked={c.url === workerUrl} onChange={() => setPicked(c.url)} />
                <span>
                  <strong>{c.label}</strong> <code>{c.url}</code>
                  <br />
                  Works from: {c.worksFrom}
                  {c.warning && <><br />{c.warning}</>}
                </span>
              </label>
            ))}
            {!choices.some((c) => c.kind === "lan") && (
              <p data-testid="check-worker-no-lan">Boss Man's host did not report a local network address, so none is offered. The address below is the one this page is open at; if it is a Tailscale name, only machines on your tailnet can use it. For any other machine, type Boss Man's LAN address into <code>BOSSMAN_URL</code> yourself: <code>ws://&lt;LAN address&gt;:3100/api/check-worker/connect</code>.</p>
            )}
            <p>If the worker's log says "Can't find the address", the worker's machine can't look that name up: pick the local network address, edit <code>BOSSMAN_URL</code> in the file and redeploy.</p>
          </fieldset>
          <pre className="mono codebox" data-testid="check-worker-compose" style={{ maxHeight: 320, overflow: "auto" }}>
            {workerComposeFile({ url: workerUrl, slots: added.slots, token: added.token })}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                void act.run(async () =>
                  copyMessage(await copyText(workerComposeFile({ url: workerUrl, slots: added.slots, token: added.token })), "Compose file"),
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
